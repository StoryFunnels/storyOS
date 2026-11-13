import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #1292 — deploy-production applies MAIL_FROM from a GitHub environment
// variable into ~/storyOS/.env on the box. The risky part is writing a value
// that contains `<`, `>`, `@` and spaces into a file that `docker compose` (and
// any shell) reads, without sed-replacement surprises (`&`, `/`, `\`), without
// ever destroying the secrets next to it, and without writing at all when the
// variable is unset. Those guards live in scripts/set-env-var.sh and are
// exercised here against the real script, not a copy of its logic.
const SCRIPT = new URL('./set-env-var.sh', import.meta.url).pathname;
const GOOD = 'Quill from StoryOS <quill@storyos.dev>';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function box(content, mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'set-env-var-'));
  const file = join(dir, '.env');
  if (content !== null) {
    writeFileSync(file, content);
    chmodSync(file, mode);
  }
  return { dir, file, read: () => readFileSync(file, 'utf8') };
}

function run(args, extraEnv = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
}

const SECRETS = 'IMAGE_TAG=' + 'a'.repeat(40) + '\nBETTER_AUTH_SECRET=s3cr3t-do-not-print\nCONNECTIONS_MASTER_KEY=also/secret&stuff\\here\n';

test('appends the variable, single-quoted, and leaves every other line byte-identical', () => {
  const b = box(SECRETS);
  const r = run(['MAIL_FROM', b64(GOOD), b.file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(b.read(), `${SECRETS}MAIL_FROM='${GOOD}'\n`);
});

test('replaces an existing MAIL_FROM exactly once, whatever it held, and keeps its neighbours', () => {
  const b = box(`IMAGE_TAG=x\nMAIL_FROM=old <old@example.com>\nexport MAIL_FROM="dup"\nOTHER=1\n`);
  const r = run(['MAIL_FROM', b64(GOOD), b.file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(b.read(), `IMAGE_TAG=x\nOTHER=1\nMAIL_FROM='${GOOD}'\n`);
});

test('does not touch a commented MAIL_FROM or a variable that merely starts with the name', () => {
  const keep = '# MAIL_FROM=documented example\nMAIL_FROM_NAME=Someone\nXMAIL_FROM=nope\n';
  const b = box(keep);
  assert.equal(run(['MAIL_FROM', b64(GOOD), b.file]).status, 0);
  assert.equal(b.read(), `${keep}MAIL_FROM='${GOOD}'\n`);
});

test('a file with no trailing newline does not get the variable glued onto its last line', () => {
  const b = box('IMAGE_TAG=abc');
  assert.equal(run(['MAIL_FROM', b64(GOOD), b.file]).status, 0);
  assert.equal(b.read(), `IMAGE_TAG=abc\nMAIL_FROM='${GOOD}'\n`);
});

test('keeps the file mode (the .env holds secrets), whatever it is', () => {
  for (const mode of [0o600, 0o640, 0o644]) {
    const b = box(SECRETS, mode);
    assert.equal(run(['MAIL_FROM', b64(GOOD), b.file]).status, 0);
    assert.equal(statSync(b.file).mode & 0o777, mode);
  }
});

test('leaves no temp file behind: on update, on a no-op re-run, and on a refusal', () => {
  const b = box(SECRETS);
  assert.equal(run(['MAIL_FROM', b64(GOOD), b.file]).status, 0);
  assert.deepEqual(readdirSync(b.dir), ['.env']);
  assert.equal(run(['MAIL_FROM', b64(GOOD), b.file]).status, 0);
  assert.deepEqual(readdirSync(b.dir), ['.env']);
  assert.notEqual(run(['MAIL_FROM', b64('Quill <quill@storyos>'), b.file]).status, 0);
  assert.deepEqual(readdirSync(b.dir), ['.env']);
});

test('an unset or blank value writes nothing and is not an error', () => {
  for (const val of ['', b64(''), b64('   '), b64('\t ')]) {
    const b = box(SECRETS);
    const before = statSync(b.file).mtimeMs;
    const r = run(['MAIL_FROM', val, b.file]);
    assert.equal(r.status, 0, `${JSON.stringify(val)}: ${r.stderr}`);
    assert.equal(b.read(), SECRETS, `${JSON.stringify(val)} changed the file`);
    assert.equal(statSync(b.file).mtimeMs, before);
    assert.match(r.stdout, /unchanged/i);
  }
});

test('no value argument at all is the same as unset', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-env-home-'));
  spawnSync('mkdir', ['-p', join(home, 'storyOS')]);
  writeFileSync(join(home, 'storyOS', '.env'), SECRETS);
  const r = spawnSync('bash', [SCRIPT, 'MAIL_FROM'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(home, 'storyOS', '.env'), 'utf8'), SECRETS);
  rmSync(home, { recursive: true, force: true });
});

test('an unset value does not delete an existing MAIL_FROM either', () => {
  const b = box(`MAIL_FROM='${GOOD}'\n`);
  assert.equal(run(['MAIL_FROM', b64(''), b.file]).status, 0);
  assert.equal(b.read(), `MAIL_FROM='${GOOD}'\n`);
});

test('the written line sources back to exactly the value in a shell, despite < > @ and spaces', () => {
  const values = [GOOD, '"Quill" <quill@storyos.dev>', 'R&D / Quill <q@storyos.dev>', 'quill@storyos.dev', 'Quill (StoryOS) <quill+ops@mail.storyos.dev>'];
  for (const v of values) {
    const b = box(SECRETS);
    const r = run(['MAIL_FROM', b64(v), b.file]);
    assert.equal(r.status, 0, `${v}: ${r.stderr}`);
    const s = spawnSync('bash', ['-c', 'set -a; . "$1"; printf %s "$MAIL_FROM"', 'x', b.file], { encoding: 'utf8' });
    assert.equal(s.stdout, v);
  }
});

test('re-running with the same value is a no-op in content', () => {
  const b = box(SECRETS);
  run(['MAIL_FROM', b64(GOOD), b.file]);
  const once = b.read();
  const r = run(['MAIL_FROM', b64(GOOD), b.file]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(b.read(), once);
});

test('refuses a value that is not a sender address, and leaves the file untouched', () => {
  const bad = {
    'full-width at sign': 'Quill from StoryOS <quill＠storyos.dev>',
    'full-width angle brackets': 'Quill ＜quill@storyos.dev＞',
    'no address': 'Quill from StoryOS',
    'address without a domain dot': 'Quill <quill@storyos>',
    'trailing text after the address': 'Quill <quill@storyos.dev> extra',
    'two addresses': 'A <a@b.co>, B <b@b.co>',
    'single quote': "O'Quill <quill@storyos.dev>",
    'newline': 'Quill <quill@storyos.dev>\nBETTER_AUTH_SECRET=pwned',
    'carriage return': 'Quill <quill@storyos.dev>\r',
    'dollar': 'Quill $HOME <quill@storyos.dev>',
    'backslash': 'Quill \\ <quill@storyos.dev>',
    'backtick': 'Quill `id` <quill@storyos.dev>',
    'non-ASCII in the address': 'Quill <quíll@storyos.dev>',
    'control character': 'Quill\u0007 <quill@storyos.dev>',
  };
  for (const [why, v] of Object.entries(bad)) {
    const b = box(SECRETS);
    const r = run(['MAIL_FROM', b64(v), b.file]);
    assert.notEqual(r.status, 0, `${why} was accepted`);
    assert.equal(b.read(), SECRETS, `${why} changed the file`);
    assert.match(r.stderr, /MAIL_FROM/);
  }
});

test('refuses input that is not base64 instead of writing something', () => {
  const b = box(SECRETS);
  const r = run(['MAIL_FROM', 'not base64 !!', b.file]);
  assert.notEqual(r.status, 0);
  assert.equal(b.read(), SECRETS);
});

test('refuses a key that is not an UPPER_SNAKE name (it is interpolated into a pattern)', () => {
  for (const key of ['mail_from', 'MAIL FROM', 'A.B', '1X', 'X;rm', '']) {
    const b = box(SECRETS);
    const r = run([key, b64(GOOD), b.file]);
    assert.notEqual(r.status, 0, `${JSON.stringify(key)} was accepted`);
    assert.equal(b.read(), SECRETS);
  }
});

test('refuses to create the env file: a missing .env means the wrong box or folder', () => {
  const b = box(null);
  const r = run(['MAIL_FROM', b64(GOOD), b.file]);
  assert.notEqual(r.status, 0);
  assert.equal(existsSync(b.file), false);
});

test('never prints the env file contents or the value, on success or on failure', () => {
  const b = box(SECRETS);
  const ok = run(['MAIL_FROM', b64(GOOD), b.file]);
  const again = run(['MAIL_FROM', b64(GOOD), b.file]);
  const no = run(['MAIL_FROM', b64('Quill <quill＠storyos.dev>'), b.file]);
  for (const out of [ok.stdout + ok.stderr, again.stdout + again.stderr, no.stdout + no.stderr]) {
    assert.doesNotMatch(out, /s3cr3t|also\/secret|BETTER_AUTH_SECRET|CONNECTIONS_MASTER_KEY|quill@storyos|storyos\.dev/);
  }
});

test('with no arguments it explains itself and fails', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/i);
});

test('defaults to ~/storyOS/.env when no file is given', () => {
  const home = mkdtempSync(join(tmpdir(), 'set-env-home-'));
  const dir = join(home, 'storyOS');
  spawnSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, '.env'), SECRETS);
  const r = spawnSync('bash', [SCRIPT, 'MAIL_FROM', b64(GOOD)], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), `${SECRETS}MAIL_FROM='${GOOD}'\n`);
  rmSync(home, { recursive: true, force: true });
});

// ── The workflow wiring ──────────────────────────────────────────────────────
const workflow = readFileSync(new URL('../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');

function step(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.search(/^ {6}(?:- name:|# ──)/m);
  return { start, text: next < 0 ? rest : rest.slice(0, next) };
}

const apply = step('Apply MAIL_FROM from the production environment');

test('workflow: MAIL_FROM is applied only when the environment variable is set', () => {
  assert.match(apply.text, /^ {8}if:\s*\$\{\{\s*vars\.MAIL_FROM != ''\s*\}\}\s*$/m);
});

test('workflow: the value reaches the shell through env, never interpolated into the script', () => {
  assert.match(apply.text, /^ {10}MAIL_FROM:\s*\$\{\{\s*vars\.MAIL_FROM\s*\}\}\s*$/m);
  const run = apply.text.slice(apply.text.indexOf('run:'));
  assert.doesNotMatch(run, /\$\{\{/, 'a ${{ }} expression inside run: is shell injection');
});

test('workflow: it ships the script over ssh, base64-encoded, and uses the repo script', () => {
  assert.match(apply.text, /base64/);
  assert.match(apply.text, /ssh prod "bash -s -- MAIL_FROM \$b64" < scripts\/set-env-var\.sh/);
});

test('workflow: it does not trace commands or print the value', () => {
  assert.doesNotMatch(apply.text, /set -[a-z]*x|xtrace|echo[^\n]*MAIL_FROM/);
});

test('workflow: it runs after SSH is set up and BEFORE the current version is recorded and before the deploy', () => {
  const ssh = step('SSH setup (pinned host key)').start;
  const cur = step('Record the currently deployed version').start;
  const dep = step('Back up, then deploy').start;
  assert.ok(ssh < apply.start && apply.start < cur && cur < dep);
});

test('workflow: the deploy still rewrites only IMAGE_TAG', () => {
  assert.equal([...workflow.matchAll(/sed -i "s\/\^/g)].length, 2);
  assert.doesNotMatch(workflow, /sed -i[^\n]*MAIL_FROM/);
});
