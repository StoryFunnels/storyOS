#!/usr/bin/env node
// Fails when a git-tracked symlink points outside the repo or at a missing target
// (ticket #1100). A tracked link into someone's machine-local path dangles in every
// other checkout and crashes tree walkers (docs:check died with ENOENT on one).
import { execFileSync } from 'node:child_process';
import { existsSync, readlinkSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findBadSymlinks(root) {
  const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: root, encoding: 'utf8' });
  const rootAbs = resolve(root);
  const bad = [];
  for (const rec of out.split('\0').filter(Boolean)) {
    const [meta, path] = rec.split('\t');
    if (!meta.startsWith('120000')) continue;
    const abs = resolve(rootAbs, path);
    let target;
    try {
      target = readlinkSync(abs);
    } catch {
      continue; // staged/tracked but not on disk as a link: not this check's concern
    }
    const dest = resolve(dirname(abs), target);
    const rel = relative(rootAbs, dest);
    if (rel.startsWith('..') || isAbsolute(rel)) bad.push(`${path} -> ${target} (points outside the repo)`);
    else if (!existsSync(dest)) bad.push(`${path} -> ${target} (target does not exist)`);
  }
  return bad;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = findBadSymlinks(process.cwd());
  if (bad.length) {
    console.error('Tracked symlinks that break in other checkouts:\n' + bad.map((b) => '  ' + b).join('\n'));
    process.exit(1);
  }
  console.log('check-tracked-symlinks: ok');
}
