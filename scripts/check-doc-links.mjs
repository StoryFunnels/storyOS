#!/usr/bin/env node
/** Checks that every relative markdown link in the repo points to an existing file. */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.turbo', '.claude']);
const mdFiles = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.md')) mdFiles.push(p);
  }
}
walk('.');

let broken = 0;
const linkRe = /\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkRe)) {
    const link = match[1];
    if (/^(https?:|mailto:)/.test(link)) continue;
    const target = normalize(join(dirname(file), link));
    if (!existsSync(target)) {
      console.error(`BROKEN: ${file} -> ${link}`);
      broken++;
    }
  }
}

console.log(`${mdFiles.length} markdown files checked, ${broken} broken links`);
process.exit(broken ? 1 : 0);
