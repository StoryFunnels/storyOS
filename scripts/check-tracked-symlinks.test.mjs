import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBadSymlinks } from './check-tracked-symlinks.mjs';

function repoWith(links) {
  const dir = mkdtempSync(join(tmpdir(), 'symlink-guard-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(join(dir, 'real'));
  writeFileSync(join(dir, 'real', 'file.txt'), 'x');
  for (const [name, target] of Object.entries(links)) symlinkSync(target, join(dir, name));
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('the real repo tracks no escaping or dangling symlinks', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  assert.deepEqual(findBadSymlinks(root), []);
});

test('accepts a link to an existing file inside the repo', () => {
  assert.deepEqual(findBadSymlinks(repoWith({ ok: 'real/file.txt' })), []);
});

test('rejects a link that escapes the repo (the #1100 shape)', () => {
  const bad = findBadSymlinks(repoWith({ shim: '../../../../usr/local/lib/node_modules/corepack/dist/pnpm.js' }));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /outside the repo/);
});

test('rejects an absolute link out of the repo', () => {
  assert.equal(findBadSymlinks(repoWith({ abs: '/usr/local/bin/node' })).length, 1);
});

test('rejects a dangling link inside the repo', () => {
  const bad = findBadSymlinks(repoWith({ gone: 'real/missing.txt' }));
  assert.equal(bad.length, 1);
  assert.match(bad[0], /does not exist/);
});
