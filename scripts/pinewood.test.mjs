import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Ticket #1269 — the safety refusals of the standing local Pinewood stack.
//
// These are dry runs and direct calls of the guard functions: no Postgres, no pnpm, no
// network. Every refusal is exit code 2 with a message naming the reason, and every test
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
const stateDir = join(root, 'state');

/** Run a pinewood script with a scrubbed environment: nothing leaks in from the caller's shell. */
function run(script, args = [], env = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
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
  const r = spawnSync('bash', ['-c', `. "${LIB}"; ${snippet}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: join(root, 'home'), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---- the happy path, so every refusal below is a refusal OF something --------------------

test('a valid dry run prints the plan, exits 0 and changes nothing', () => {
  const res = run(UP, ['--dry-run']);
  assert.equal(res.code, 0, res.all);
  assert.match(res.out, /1\. git pull --ff-only origin main/);
  assert.match(res.out, /database storyos_pinewood on localhost:5432 if missing/);
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
  const r = lib('pw_run_with_db stack storyos_pinewood FOO=1 env', {
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

test('the only DROP DATABASE statements sit behind the template and rig guards', () => {
  for (const [file, guard] of [
    [TEMPLATE, 'pw_check_db template'],
    [RIG, 'pw_check_db rig'],
  ]) {
    const src = readFileSync(file, 'utf8');
    const drops = [...src.matchAll(/DROP DATABASE/g)];
    assert.equal(drops.length, 1, `${file} should have exactly one DROP DATABASE`);
    assert.ok(src.indexOf(guard) !== -1 && src.indexOf(guard) < drops[0].index, `${guard} must precede the DROP in ${file}`);
  }
});
