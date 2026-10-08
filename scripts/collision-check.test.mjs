// Tests for scripts/collision-check.mjs (#839). Run: node --test scripts/
//
// Real subprocess, real git, a stub `gh` on PATH. The stub's description file is
// rewritten BETWEEN runs while PR_BODY in the environment stays frozen — that is
// precisely the sequence that cost a cycle on 2026-10-08: open with a malformed
// Overlaps-With line, edit only the body, rerun the same job. What a stub cannot
// show — that GitHub Actions really hands a rerun the old payload — is covered by
// the scratch-PR reproduction recorded on the ticket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'collision-check.mjs');
let root;
let repo;
let bin;
let bodyFile;

const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'collision-'));
  repo = join(root, 'repo');
  bin = join(root, 'bin');
  bodyFile = join(root, 'body.txt');
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t.test');
  git('config', 'user.name', 't');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(repo, 'shared.txt'), 'mine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'mine');

  // `gh pr list` → one other open PR touching shared.txt. `gh pr view` → body file,
  // or a failure when STUB_VIEW_FAIL is set.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  echo '[{"number":977,"title":"other","headRefName":"other","changedFiles":1,"files":[{"path":"shared.txt"}]}]'
elif [ "$1 $2" = "pr view" ]; then
  [ -n "$STUB_VIEW_FAIL" ] && { echo "gh: boom" >&2; exit 1; }
  cat "${bodyFile}"
else
  exit 1
fi
`);
  chmodSync(join(bin, 'gh'), 0o755);
});
after(() => rmSync(root, { recursive: true, force: true }));

function run(env = {}) {
  const r = spawnSync('node', [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLISION_BASE: 'main', PR_NUMBER: '980', ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('a body edited AFTER the run was triggered is what counts: malformed fails, corrected passes, stale PR_BODY ignored', () => {
  const FROZEN = 'Overlaps-With: PR #977 — frozen at trigger time';
  writeFileSync(bodyFile, FROZEN);
  const first = run({ PR_BODY: FROZEN });
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /UNDECLARED\s+#977/);

  // The rerun: ONLY the description changes. PR_BODY (the frozen payload) is the same.
  writeFileSync(bodyFile, 'Overlaps-With: #977 — both edit the shared file\n');
  const rerun = run({ PR_BODY: FROZEN });
  assert.equal(rerun.code, 0, rerun.out);
  assert.match(rerun.out, /declared/);
});

test('live wins in the other direction too: a stale PR_BODY that declares cannot rescue a body that does not', () => {
  writeFileSync(bodyFile, 'no declaration here');
  const r = run({ PR_BODY: 'Overlaps-With: #977 — stale and generous' });
  assert.equal(r.code, 1, r.out);
});

test('the format is unchanged: "PR #977" and a mid-line mention are still not declarations', () => {
  writeFileSync(bodyFile, 'Overlaps-With: PR #977');
  assert.equal(run().code, 1);
  writeFileSync(bodyFile, 'see Overlaps-With: #977 in passing');
  assert.equal(run().code, 1);
});

test('an unreadable description is "cannot tell": exit 2, never a pass and never the frozen fallback', () => {
  const r = run({ STUB_VIEW_FAIL: '1', PR_BODY: 'Overlaps-With: #977 — would pass if used' });
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /could not read the description of PR #980/);
});

test('a real undeclared overlap still fails, and the failure names the remedy', () => {
  writeFileSync(bodyFile, '');
  const r = run();
  assert.equal(r.code, 1);
  assert.match(r.out, /re-running the job is enough/);
  assert.match(r.out, /not `PR #NNN`/);
});

test('with no PR to ask about (local, before one is open) PR_BODY is the declaration', () => {
  const r = run({ PR_NUMBER: '', PR_BODY: 'Overlaps-With: #977 — local' });
  assert.equal(r.code, 0, r.out);
});
