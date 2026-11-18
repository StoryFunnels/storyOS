import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ticket #1269 — the safety refusals of the standing local Pinewood stack.
//
// These are dry runs, live runs against a FAKE Postgres, and direct calls of the guard
// functions: no real Postgres, no pnpm, no network. `psql`, `createdb` and `pnpm` are
// stubs (scripts/pinewood-test-bin) that keep their "databases" (name -> comment) in a
// directory and log every command, so a test can assert both what was refused and that
// nothing destructive was attempted. Every refusal is exit code 2 with a message naming the reason, and every test
// here was mutation-checked (the guard replaced by a no-op, the test watched go red);
// the mutations are listed in the PR.

const dir = (rel) => new URL(rel, import.meta.url).pathname;
const UP = dir('./pinewood/pinewood-up.sh');
const TEMPLATE = dir('./pinewood/pinewood-template.sh');
const RIG = dir('./pinewood/pinewood-rig.sh');
const LIB = dir('./pinewood/lib.sh');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pinewood-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A real clone-shaped directory: `.git` is a directory, on main, clean, with a lockfile. */
function makeClone(name = 'pinewood-fixture') {
  const p = join(root, name);
  mkdirSync(p, { recursive: true });
  git(p, 'init', '-q', '-b', 'main');
  mkdirSync(join(p, 'apps/api'), { recursive: true });
  writeFileSync(join(p, 'apps/api/package.json'), '{"name":"@storyos/api","scripts":{}}\n');
  writeFileSync(join(p, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  git(p, 'add', '-A');
  git(p, 'commit', '-q', '-m', 'init');
  return p;
}

const clone = makeClone();
mkdirSync(join(clone, 'node_modules'), { recursive: true });
const stateDir = join(root, 'state');

// ---- a fake Postgres ---------------------------------------------------------------------
// Files in FAKE_PG_DIR: `db.<name>` exists = the database exists, its content is the
// database comment; `log` is every command received; `DOWN` makes psql fail like a refused
// connection.
const fakeBin = dir('./pinewood-test-bin');
let pgCounter = 0;
/** A fresh fake Postgres holding `dbs` (name -> comment). Returns its directory. */
function fakePg(dbs = {}) {
  const d = join(root, `pg-${pgCounter++}`);
  mkdirSync(d);
  writeFileSync(join(d, 'log'), '');
  for (const [name, comment] of Object.entries(dbs)) writeFileSync(join(d, `db.${name}`), comment);
  return d;
}
const pgLog = (d) => readFileSync(join(d, 'log'), 'utf8');
const pgDbs = (d) => readdirSync(d).filter((f) => f.startsWith('db.')).map((f) => f.slice(3)).sort();
const pgComment = (d, name) => readFileSync(join(d, `db.${name}`), 'utf8');
/** Commands that change something. A refusal must leave none of these in the log. */
const MUTATIONS = /^(createdb:|pnpm:|psql: (DROP|COMMENT|CREATE|ALTER))/m;
const defaultPg = fakePg();
mkdirSync(join(root, 'home'));
/** The pnpm stub runs under `env -i`, so it finds the fake Postgres through HOME. */
const pointStubsAt = (pgDir) => writeFileSync(join(root, 'home', '.fake-pg-dir'), pgDir);

/** Run a pinewood script with a scrubbed environment: nothing leaks in from the caller's shell. */
function run(script, args = [], env = {}) {
  pointStubsAt(env.FAKE_PG_DIR ?? defaultPg);
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_PG_DIR: defaultPg,
      HOME: join(root, 'home'),
      PINEWOOD_HOME: clone,
      PINEWOOD_STATE: stateDir,
      PINEWOOD_ENV_FILE: join(root, 'pinewood.env'),
      ...env,
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function refused(res, pattern) {
  assert.equal(res.code, 2, `expected a refusal (exit 2), got ${res.code}\n${res.all}`);
  assert.match(res.err, /^pinewood: REFUSED: /m);
  assert.match(res.err, pattern);
}

/** Call guard functions in lib.sh directly. */
function lib(snippet, env = {}) {
  pointStubsAt(env.FAKE_PG_DIR ?? defaultPg);
  const r = spawnSync('bash', ['-c', `. "${LIB}"; ${snippet}`], {
    encoding: 'utf8',
    env: { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_PG_DIR: defaultPg, HOME: join(root, 'home'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---- the happy path, so every refusal below is a refusal OF something --------------------

test('a valid dry run prints the plan, exits 0 and changes nothing', () => {
  const res = run(UP, ['--dry-run']);
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /1\. git pull --ff-only origin main/);
  assert.match(res.out, /create database storyos_pinewood on localhost:5432 and mark it as made by this script/);
  assert.match(res.out, /API :3500 and web :3600/);
  assert.match(res.out, /dry run: nothing was changed/);
  assert.equal(existsSync(stateDir), false, 'a dry run must not create the state directory');
  assert.equal(existsSync(join(root, 'pinewood.env')), false, 'a dry run must not generate secrets');
});

test('an inherited DATABASE_URL (the founder database) is ignored, and said so', () => {
  const res = run(UP, ['--dry-run'], { DATABASE_URL: 'postgres://storyos:storyos@localhost:5432/storyos' });
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /ignoring the DATABASE_URL in this shell/);
  assert.doesNotMatch(res.out, /localhost:5432\/storyos\b/);
});

// ---- database refusals -----------------------------------------------------------------

test('refuses a database that is not pinewood-named', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_DB: 'storyos_marek' }), /not a pinewood-named database/);
});

test('refuses umh_analytics, which belongs to another project', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_DB: 'umh_analytics' }), /protected/);
});

test('refuses the shared founder database', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_DB: 'storyos' }), /protected/);
});

test('refuses the template as the standing database (it is disposable, the stack is not)', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_DB: 'storyos_agency_tpl' }), /not a pinewood-named database/);
});

test('refuses a database name that is not a plain identifier', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_DB: 'storyos_pinewood;drop' }), /not a plain lower-case identifier|not a pinewood-named/);
});

test('refuses a Postgres host that is not this machine', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_PGHOST: 'db.example.com' }), /not local/);
});

// ---- port refusals ---------------------------------------------------------------------

test('refuses the ordinary dev ports', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_API_PORT: '3001' }), /ordinary dev port/);
  refused(run(UP, ['--dry-run'], { PINEWOOD_WEB_PORT: '3000' }), /ordinary dev port/);
});

test('refuses a port that is not a number, is privileged, or is shared', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_API_PORT: 'abc' }), /not a number/);
  refused(run(UP, ['--dry-run'], { PINEWOOD_WEB_PORT: '80' }), /outside 1024-65535/);
  refused(run(UP, ['--dry-run'], { PINEWOOD_API_PORT: '3510', PINEWOOD_WEB_PORT: '3510' }), /cannot share port/);
});

test('refuses a port held by a process this stack did not start, and does not touch it', async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await new Promise((resolve) => {
      const child = spawn('bash', [UP, '--dry-run'], {
        env: { PATH: process.env.PATH, HOME: join(root, 'home'), PINEWOOD_HOME: clone, PINEWOOD_STATE: stateDir, PINEWOOD_API_PORT: String(port) },
      });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => resolve({ code, err }));
    });
    assert.equal(res.code, 2, res.err);
    assert.match(res.err, /held by a process this stack did not start/);
    assert.ok(server.listening, 'the foreign listener must still be running');
  } finally {
    server.close();
  }
});

// ---- clone refusals --------------------------------------------------------------------

test('refuses a clone that is a git worktree (.git is a file)', () => {
  const wt = join(root, 'pinewood-worktree');
  git(clone, 'worktree', 'add', '-q', '-b', 'wt-branch', wt);
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: wt }), /not its own clone/);
});

test('refuses a clone path inside a worktrees directory', () => {
  const inside = join(root, 'x/.claude/worktrees/pinewood-agent');
  mkdirSync(inside, { recursive: true });
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: inside }), /inside a worktrees directory/);
});

test('refuses a clone directory that is not pinewood-named', () => {
  const other = makeClone('some-agent-checkout');
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: other }), /not pinewood-named/);
});

test('refuses a relative clone path', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: 'pinewood' }), /not absolute/);
});

test('refuses to run without a clone unless --init is given', () => {
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: join(root, 'pinewood-missing') }), /no clone at .* pass --init/);
});

test('with --init and no clone the plan says it will clone, still changing nothing', () => {
  const missing = join(root, 'pinewood-fresh');
  const res = run(UP, ['--dry-run', '--init'], { PINEWOOD_HOME: missing, PINEWOOD_REPO_URL: 'https://example.invalid/repo.git' });
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /git clone --branch main https:\/\/example\.invalid\/repo\.git/);
  assert.equal(existsSync(missing), false);
});

test('refuses a clone that is not on main', () => {
  const c = makeClone('pinewood-branch');
  git(c, 'switch', '-q', '-c', 'feature');
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: c }), /not main/);
});

test('refuses a clone with local changes (it never resets or discards)', () => {
  const c = makeClone('pinewood-dirty');
  writeFileSync(join(c, 'pnpm-lock.yaml'), 'changed\n');
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: c }), /local changes/);
});

test('refuses a clone with a stray apps/api/.env (a real mail key there would send real mail)', () => {
  const c = makeClone('pinewood-env');
  writeFileSync(join(c, 'apps/api/.env'), 'RESEND_API_KEY=x\n');
  refused(run(UP, ['--dry-run'], { PINEWOOD_HOME: c }), /apps\/api\/\.env exists/);
});

test('refuses an unknown argument', () => {
  refused(run(UP, ['--wipe']), /unknown argument/);
});

// ---- template and rig refusals ---------------------------------------------------------

test('the template script refuses any database that is not a template name', () => {
  for (const db of ['storyos_pinewood', 'umh_analytics', 'storyos', 'storyos_marek']) {
    refused(run(TEMPLATE, ['--dry-run'], { PINEWOOD_TEMPLATE_DB: db }), /protected|not a template database/);
  }
});

test('the template script refuses a non-local Postgres host', () => {
  refused(run(TEMPLATE, ['--dry-run'], { PINEWOOD_PGHOST: '10.0.0.5' }), /not local/);
});

test('the rig script refuses to land on the standing stack, the template or a protected database', () => {
  const repo = clone;
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  for (const rig of ['pinewood', 'pinewood_x', 'agency_tpl', 'agency_tpl_x']) {
    refused(run(RIG, [rig, '--repo', repo, '--dry-run']), /standing stack or the template/);
  }
  // `storyos` itself cannot be spelled as a rig: the name is always storyos_<rig>.
  refused(run(RIG, ['', '--repo', repo, '--dry-run']), /usage|must be named storyos_<rig>/);
});

test('the rig script refuses a rig name that is not a plain identifier', () => {
  const repo = clone;
  for (const rig of ['Bad', 'a;b', 'a b', 'x$(id)', '-rf']) {
    const res = run(RIG, [rig, '--repo', repo, '--dry-run']);
    assert.notEqual(res.code, 0, `rig '${rig}' must not be accepted\n${res.all}`);
  }
  refused(run(RIG, ['Bad', '--repo', repo, '--dry-run']), /not a plain lower-case identifier|must be named/);
});

test('a rig database must be named storyos_<rig>, and the name is checked where it is used', () => {
  refused(run(RIG, ['_x', '--repo', clone, '--dry-run']), /must be named storyos_<rig>/);
  const direct = lib('pw_assert_rig_db marek');
  assert.equal(direct.code, 2);
  assert.match(direct.err, /must be named storyos_<rig>/);
});

test('the rig script needs a StoryOS checkout with dependencies', () => {
  refused(run(RIG, ['marek', '--repo', join(root, 'nowhere'), '--dry-run']), /not a StoryOS checkout/);
});

test('a valid rig dry run says what it would do and changes nothing', () => {
  const res = run(RIG, ['marek_1269', '--repo', clone, '--dry-run']);
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /rig storyos_marek_1269 on localhost:5432, cloned from storyos_agency_tpl/);
});

// ---- the choke point and the process guards --------------------------------------------

test('the child-process choke point re-checks the database before handing over DATABASE_URL', () => {
  const env = { PW_PGHOST: 'localhost', PW_PGPORT: '5432', PW_PGUSER: 'tester' };
  for (const [kind, db] of [
    ['stack', 'umh_analytics'],
    ['stack', 'storyos'],
    ['stack', 'storyos_marek'],
    ['template', 'storyos_pinewood'],
    ['rig', 'storyos_pinewood'],
    ['rig', 'umh_analytics'],
  ]) {
    const r = lib(`pw_run_with_db ${kind} ${db} env`, env);
    assert.equal(r.code, 2, `${kind}/${db} must be refused at the choke point\n${r.err}`);
  }
  const bad = lib('pw_run_with_db stack storyos_pinewood env', { ...env, PW_PGHOST: 'db.example.com' });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /not local/);
});

test('the child process sees only DATABASE_URL, PATH, HOME, TERM and what the caller passed', () => {
  const pg = fakePg({ storyos_pinewood: 'pinewood-stack:storyos_pinewood; created=then' });
  const r = lib('pw_run_with_db stack storyos_pinewood FOO=1 env', {
    FAKE_PG_DIR: pg,
    PW_PGHOST: 'localhost',
    PW_PGPORT: '5432',
    PW_PGUSER: 'tester',
    RESEND_API_KEY: 'must-not-leak',
    STRIPE_SECRET_KEY: 'must-not-leak',
    DATABASE_URL: 'postgres://founder/storyos',
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^DATABASE_URL=postgres:\/\/tester@localhost:5432\/storyos_pinewood$/m);
  assert.match(r.out, /^FOO=1$/m);
  assert.doesNotMatch(r.out, /must-not-leak|founder/);
});

test('only a process whose working directory is inside the clone counts as ours', async () => {
  const home = join(root, 'pinewood-procs');
  mkdirSync(home, { recursive: true });
  const ours = spawn('sleep', ['30'], { cwd: home });
  const theirs = spawn('sleep', ['30'], { cwd: root });
  await Promise.all([ours, theirs].map((c) => new Promise((resolve) => c.once('spawn', resolve))));
  await new Promise((resolve) => setTimeout(resolve, 150)); // let the child finish exec before lsof looks at its cwd
  try {
    const pidfile = (n, pid) => {
      const f = join(root, `${n}.pid`);
      writeFileSync(f, String(pid));
      return f;
    };
    const mine = lib(`pw_owned_pid "${pidfile('ours', ours.pid)}" "${home}"`);
    assert.equal(mine.code, 0, mine.err);
    assert.equal(mine.out.trim(), String(ours.pid));
    const foreign = lib(`pw_owned_pid "${pidfile('theirs', theirs.pid)}" "${home}"`);
    assert.notEqual(foreign.code, 0, 'a process outside the clone must never be recognised as ours');
    const stale = lib(`pw_owned_pid "${join(root, 'missing.pid')}" "${home}"`);
    assert.notEqual(stale.code, 0);
  } finally {
    ours.kill();
    theirs.kill();
  }
});

// ---- nothing in these scripts can drop the standing database ----------------------------

test('pinewood-up.sh never drops anything', () => {
  const src = readFileSync(UP, 'utf8');
  assert.doesNotMatch(src, /dropdb|DROP DATABASE|DROP SCHEMA|reset --hard|git clean|--force/i);
});

test('the only DROP DATABASE statement is pw_drop_marked_db, and it re-reads ownership first', () => {
  const lib_ = readFileSync(LIB, 'utf8');
  const drops = [...lib_.matchAll(/DROP DATABASE/g)];
  assert.equal(drops.length, 1, 'lib.sh should have exactly one DROP DATABASE');
  const fn = lib_.slice(lib_.indexOf('pw_drop_marked_db()'));
  assert.ok(fn.indexOf('pw_db_probe') !== -1 && fn.indexOf('pw_require_ours') !== -1, 'the drop function must probe and require ownership');
  assert.ok(fn.indexOf('pw_require_ours') < fn.indexOf('DROP DATABASE'), 'ownership must be required before the DROP');
  for (const file of [UP, TEMPLATE, RIG]) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /DROP DATABASE|dropdb/i, `${file} must not drop directly`);
    assert.doesNotMatch(src, /^\s*createdb /m, `${file} must create through pw_create_marked_db`);
  }
});

// ---- ownership: what a script created is the only thing it will drop or migrate ----------
//
// Ticket #1269 send-back: `pinewood-rig.sh --recreate` dropped storyos_<anything>, including a
// peer's storyos_test_local, and the dry run said it would and "changed nothing". Every
// scenario below runs as a dry run AND a live run against the same starting state, and both
// must decide identically.

const MARK = (kind, db, more = '') => `pinewood-${kind}:${db}${more}`;
const TPL_MARKED = { storyos_agency_tpl: MARK('template', 'storyos_agency_tpl', '; sha=abc, migrations only, built=then') };

function rigRun(pg, rig, extra = [], { dry = false, env = {} } = {}) {
  return run(RIG, [rig, '--repo', clone, ...(dry ? ['--dry-run'] : []), ...extra], { FAKE_PG_DIR: pg, ...env });
}

/** Same scenario as a dry run and as a live run, each on its own copy of the starting state. */
function bothWays(dbs, runner) {
  const dry = fakePg(dbs);
  const live = fakePg(dbs);
  return { dry: runner(dry, true), live: runner(live, false), dryPg: dry, livePg: live };
}

test('a database the script did not create is refused for --recreate AND for plain migration, dry run or live', () => {
  for (const [label, comment] of [
    ['no comment at all', ''],
    ["somebody else's comment", 'peer session scratch'],
    ['another kind of marker', MARK('stack', 'storyos_decoy')],
    ["another database's marker", MARK('rig', 'storyos_other')],
    ['a marker that only starts like ours', MARK('rig', 'storyos_decoy2')],
    ['a marker with no separator', MARK('rig', 'storyos_decoy') + 'x'],
  ]) {
    for (const extra of [['--recreate'], []]) {
      const dbs = { ...TPL_MARKED, storyos_decoy: comment };
      const { dry, live, dryPg, livePg } = bothWays(dbs, (pg, isDry) => rigRun(pg, 'decoy', extra, { dry: isDry }));
      for (const [mode, res, pg] of [['dry', dry, dryPg], ['live', live, livePg]]) {
        const what = `${label} ${extra.join(' ') || 'migrate'} (${mode})`;
        refused(res, /did not create it/);
        assert.doesNotMatch(pgLog(pg), MUTATIONS, `${what}: nothing may be dropped, created, commented or migrated`);
        assert.deepEqual(pgDbs(pg), ['storyos_agency_tpl', 'storyos_decoy'], `${what}: the database set must be unchanged`);
        assert.equal(pgComment(pg, 'storyos_decoy'), comment, `${what}: the decoy must be untouched`);
      }
      assert.equal(dry.code, live.code, `${label}: dry run and live run must exit the same`);
      assert.equal(dry.err, live.err, `${label}: dry run and live run must refuse with the same message`);
    }
  }
});

test('storyos_test* is protected by name, even with a forged marker, even for a database that does not exist', () => {
  for (const rig of ['test_local', 'test', 'test_x', 'testing', 'test_marek_1']) {
    const db = `storyos_${rig}`;
    for (const dbs of [{ ...TPL_MARKED }, { ...TPL_MARKED, [db]: MARK('rig', db) }, { ...TPL_MARKED, [db]: '' }]) {
      for (const extra of [['--recreate'], []]) {
        const { dry, live, dryPg, livePg } = bothWays(dbs, (pg, isDry) => rigRun(pg, rig, extra, { dry: isDry }));
        refused(dry, /protected/);
        refused(live, /protected/);
        assert.doesNotMatch(pgLog(dryPg) + pgLog(livePg), MUTATIONS);
        assert.deepEqual(pgDbs(livePg), Object.keys(dbs).sort(), `${db} must be left exactly as it was`);
      }
    }
  }
  for (const db of ['storyos_test_local', 'storyos_test', 'storyos_testing']) {
    assert.equal(lib(`pw_is_protected_db ${db}`).code, 0, `${db} must be in the protected set`);
  }
  assert.notEqual(lib('pw_is_protected_db storyos_marek_1269').code, 0, 'an ordinary rig name is not protected by name');
});

test('the standing stack, the template and the founder database cannot be named as rigs, with or without --recreate', () => {
  for (const rig of ['pinewood', 'pinewood_marek', 'agency_tpl', 'agency_tpl_x']) {
    for (const extra of [['--recreate'], []]) {
      const dbs = { ...TPL_MARKED, [`storyos_${rig}`]: MARK('rig', `storyos_${rig}`) };
      const { dry, live, livePg } = bothWays(dbs, (pg, isDry) => rigRun(pg, rig, extra, { dry: isDry }));
      refused(dry, /standing stack or the template/);
      refused(live, /standing stack or the template/);
      assert.doesNotMatch(pgLog(livePg), MUTATIONS);
    }
  }
  const direct = lib('pw_assert_rig_db storyos');
  assert.equal(direct.code, 2);
  assert.match(direct.err, /protected/);
});

test('Postgres not answering is a refusal, never "the database is absent"', () => {
  for (const script of [RIG, TEMPLATE, UP]) {
    for (const dry of [true, false]) {
      const pg = fakePg(TPL_MARKED);
      writeFileSync(join(pg, 'DOWN'), '');
      const args = script === RIG ? ['decoy', '--repo', clone] : script === TEMPLATE ? ['--repo', clone] : [];
      const res = run(script, [...args, ...(dry ? ['--dry-run'] : [])], { FAKE_PG_DIR: pg });
      refused(res, /cannot ask Postgres/);
      assert.doesNotMatch(pgLog(pg), MUTATIONS);
    }
  }
});

test('KEPT: a rig this script created is recreatable, re-runnable, and carries its marker', () => {
  const pg = fakePg(TPL_MARKED);
  // 1. creation: cloned from the template, then marked, then migrated.
  let res = rigRun(pg, 'marek_1269');
  assert.equal(res.code, 0, res.all);
  assert.match(pgLog(pg), /^createdb: .*-T storyos_agency_tpl storyos_marek_1269$/m);
  assert.match(pgComment(pg, 'storyos_marek_1269'), /^pinewood-rig:storyos_marek_1269; template=storyos_agency_tpl; created=/);
  assert.match(pgLog(pg), /^pnpm: DATABASE_URL=postgres:\/\/[^@]+@localhost:5432\/storyos_marek_1269 --filter @storyos\/api db:migrate$/m);
  assert.match(res.out, /DATABASE_URL=postgres:\/\/[^@]+@localhost:5432\/storyos_marek_1269/);

  // 2. a dry run of a recreate says what it will do and exits 0.
  const dry = rigRun(pg, 'marek_1269', ['--recreate'], { dry: true });
  assert.equal(dry.code, 0, dry.all);
  assert.match(dry.out, /--recreate: storyos_marek_1269 exists and was created by this script; it is dropped first/);

  // 3. re-running without --recreate leaves it alone: migrate only, no drop, no second create.
  writeFileSync(join(pg, 'log'), '');
  res = rigRun(pg, 'marek_1269');
  assert.equal(res.code, 0, res.all);
  assert.doesNotMatch(pgLog(pg), /^createdb:|DROP/m);
  assert.match(pgLog(pg), /^pnpm: /m);

  // 4. --recreate really drops and re-clones, and the new database is marked again.
  writeFileSync(join(pg, 'log'), '');
  res = rigRun(pg, 'marek_1269', ['--recreate']);
  assert.equal(res.code, 0, res.all);
  const log = pgLog(pg);
  assert.ok(log.indexOf('DROP DATABASE "storyos_marek_1269"') !== -1, log);
  assert.ok(log.indexOf('DROP DATABASE') < log.indexOf('createdb:'), 'drop comes before the re-clone');
  assert.match(pgComment(pg, 'storyos_marek_1269'), /^pinewood-rig:storyos_marek_1269;/);
  assert.deepEqual(pgDbs(pg), ['storyos_agency_tpl', 'storyos_marek_1269']);
});

test('a rig is never cloned from a template this tooling did not build, dry run or live', () => {
  const { dry, live, livePg } = bothWays({ storyos_agency_tpl: 'somebody else' }, (pg, isDry) => rigRun(pg, 'marek_1269', [], { dry: isDry }));
  refused(dry, /did not create it/);
  refused(live, /did not create it/);
  assert.equal(dry.err, live.err);
  assert.doesNotMatch(pgLog(livePg), MUTATIONS);
  assert.deepEqual(pgDbs(livePg), ['storyos_agency_tpl']);
});

test("a decoy next to a rig the script made is never touched by that rig's --recreate", () => {
  const pg = fakePg({ ...TPL_MARKED, storyos_marek_1269: MARK('rig', 'storyos_marek_1269'), storyos_decoy_marek_1: 'x', storyos_test_local: 'peer' });
  const res = rigRun(pg, 'marek_1269', ['--recreate']);
  assert.equal(res.code, 0, res.all);
  assert.equal(pgComment(pg, 'storyos_decoy_marek_1'), 'x');
  assert.equal(pgComment(pg, 'storyos_test_local'), 'peer');
  assert.doesNotMatch(pgLog(pg), /DROP DATABASE "storyos_(decoy|test)/);
});

test('the template script drops only a template it made, and decides the same in a dry run', () => {
  for (const comment of ['', 'sha=abc, migrations only, built=then', MARK('template', 'storyos_other_tpl')]) {
    const { dry, live, dryPg, livePg } = bothWays({ storyos_agency_tpl: comment }, (pg, isDry) =>
      run(TEMPLATE, ['--repo', clone, ...(isDry ? ['--dry-run'] : [])], { FAKE_PG_DIR: pg }));
    refused(dry, /did not create it/);
    refused(live, /did not create it/);
    assert.equal(dry.err, live.err);
    assert.doesNotMatch(pgLog(dryPg) + pgLog(livePg), MUTATIONS);
    assert.equal(pgComment(livePg, 'storyos_agency_tpl'), comment);
  }
});

test('KEPT: the template script rebuilds a template it made, and re-marks it with provenance', () => {
  const pg = fakePg(TPL_MARKED);
  const dry = run(TEMPLATE, ['--repo', clone, '--dry-run'], { FAKE_PG_DIR: pg });
  assert.equal(dry.code, 0, dry.all);
  const res = run(TEMPLATE, ['--repo', clone], { FAKE_PG_DIR: pg });
  assert.equal(res.code, 0, res.all);
  assert.ok(pgLog(pg).indexOf('DROP DATABASE "storyos_agency_tpl"') !== -1);
  assert.match(pgComment(pg, 'storyos_agency_tpl'), /^pinewood-template:storyos_agency_tpl; sha=[0-9a-f]+, migrations only, built=/);
  // A first build (nothing there yet) needs no marker and creates one.
  const fresh = fakePg();
  const first = run(TEMPLATE, ['--repo', clone], { FAKE_PG_DIR: fresh });
  assert.equal(first.code, 0, first.all);
  assert.match(pgComment(fresh, 'storyos_agency_tpl'), /^pinewood-template:storyos_agency_tpl;/);
});

test('the standing stack never migrates an existing database it did not create, dry run included', () => {
  for (const comment of ['', 'founder scratch', MARK('rig', 'storyos_pinewood')]) {
    const pg = fakePg({ storyos_pinewood: comment });
    for (const args of [['--dry-run'], []]) {
      const res = run(UP, args, { FAKE_PG_DIR: pg });
      refused(res, /did not create it/);
      assert.doesNotMatch(pgLog(pg), MUTATIONS);
    }
  }
  const mine = fakePg({ storyos_pinewood: MARK('stack', 'storyos_pinewood', '; created=then') });
  const res = run(UP, ['--dry-run'], { FAKE_PG_DIR: mine });
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /database storyos_pinewood exists and was created by this script/);
});

test('the choke point itself refuses a database the script did not create, whatever the caller checked', () => {
  const pg = fakePg({ storyos_pinewood: 'founder scratch', storyos_decoy: '' });
  const env = { FAKE_PG_DIR: pg, PW_PGHOST: 'localhost', PW_PGPORT: '5432', PW_PGUSER: 'tester' };
  const cases = [
    ['pw_run_with_db stack storyos_pinewood env', /did not create it/],
    ['pw_run_with_db rig storyos_decoy env', /did not create it/],
    ['pw_run_with_db rig storyos_absent env', /does not exist/],
    ['pw_drop_marked_db rig storyos_decoy', /did not create it/],
  ];
  for (const [snippet, pattern] of cases) {
    const r = lib(snippet, env);
    assert.equal(r.code, 2, `${snippet}\n${r.err}`);
    assert.match(r.err, pattern);
  }
  assert.deepEqual(pgDbs(pg), ['storyos_decoy', 'storyos_pinewood']);
});

// ---- seed:agency gets the configured env file (ticket #1297, found on the first real run) -----
// `env -i` drops PINEWOOD_ENV_FILE, so the seed used to write its throwaway password to its own
// default ~/storyos-envs/pinewood.env, i.e. the standing stack's file, from a throwaway stack.

test('KEPT: seed:agency is handed the env file this run is configured with, and still a marked database only', () => {
  const pg = fakePg({ storyos_pinewood: MARK('stack', 'storyos_pinewood', '; created=then') });
  const envFile = join(root, 'elsewhere', 'my.env');
  const r = lib(`pw_seed_agency stack storyos_pinewood "${envFile}" "${clone}"`, { FAKE_PG_DIR: pg, PW_PGHOST: 'localhost', PW_PGPORT: '5432', PW_PGUSER: 'tester' });
  assert.equal(r.code, 0, r.err);
  assert.match(pgLog(pg), new RegExp(`^pnpm: DATABASE_URL=postgres://tester@localhost:5432/storyos_pinewood PINEWOOD_ENV_FILE=${envFile} --filter @storyos/api seed:agency$`, 'm'));
  // and an unmarked database is refused at the same choke point
  const foreign = fakePg({ storyos_pinewood: 'someone else' });
  const bad = lib(`pw_seed_agency stack storyos_pinewood "${envFile}" "${clone}"`, { FAKE_PG_DIR: foreign, PW_PGHOST: 'localhost', PW_PGPORT: '5432', PW_PGUSER: 'tester' });
  assert.equal(bad.code, 2);
  assert.doesNotMatch(pgLog(foreign), /seed:agency/);
});

test('the template build passes PINEWOOD_ENV_FILE to seed:agency, and both scripts seed through the one function', () => {
  const repo = join(root, 'pinewood-seeded');
  mkdirSync(join(repo, 'apps/api'), { recursive: true });
  mkdirSync(join(repo, 'node_modules'), { recursive: true });
  writeFileSync(join(repo, 'apps/api/package.json'), '{"name":"@storyos/api","scripts":{"seed:agency":"x"}}\n');
  const pg = fakePg(TPL_MARKED);
  const envFile = join(root, 'tpl-secrets.env');
  const res = run(TEMPLATE, ['--repo', repo], { FAKE_PG_DIR: pg, PINEWOOD_ENV_FILE: envFile });
  assert.equal(res.code, 0, res.all);
  assert.match(pgLog(pg), new RegExp(`PINEWOOD_ENV_FILE=${envFile} --filter @storyos/api seed:agency$`, 'm'));
  for (const file of [UP, TEMPLATE]) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /pw_seed_agency (stack|template) /, `${file} must seed through pw_seed_agency`);
    assert.doesNotMatch(src, /pnpm --filter @storyos\/api seed:agency/, `${file} must not call the seed by hand`);
  }
});
