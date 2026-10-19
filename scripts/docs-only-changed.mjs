#!/usr/bin/env node
/**
 * #953 — is this diff DOCS-ONLY? ci.yml's `changes` job runs this so `test-api` and `test-other`
 * can be skipped for a diff that cannot change what they test (46 of the last 100 merged PRs were
 * docs-only, each paying ~22 runner-minutes twice: once on the PR, once in the merge queue).
 *
 * FAIL-SAFE toward "code changed", the same direction as docker-inputs-changed.mjs: a wrongly
 * skipped test run is a regression reaching main; a wrongly run one costs minutes. So no base
 * ref, an unresolvable diff, or an EMPTY diff all report docs_only=false.
 *
 * Docs-only means EVERY changed file is under apps/docs/, docs/, tickets/, or is a *.md that is
 * not under apps/ or packages/ (those may be fixtures or package READMEs a build or test reads).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DOC_DIRS = ['apps/docs/', 'docs/', 'tickets/'];

export function isDocFile(file) {
  if (DOC_DIRS.some((d) => file.startsWith(d))) return true;
  return file.endsWith('.md') && !file.startsWith('apps/') && !file.startsWith('packages/');
}

/** null (cannot tell) and [] (nothing changed) are both "not docs-only". */
export function docsOnly(files) {
  if (!files || files.length === 0) return false;
  return files.every(isDocFile);
}

function changedFiles(base, head) {
  if (!base) return null;
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch (error) {
    console.error(`git diff ${base}...${head} failed: ${error.message}`);
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = changedFiles(process.env.DIFF_BASE || '', process.env.DIFF_HEAD || 'HEAD');
  const result = docsOnly(files);
  console.log(files === null ? 'No usable base ref — treating the diff as code.' : `${files.length} file(s) changed; docs-only: ${result}`);
  console.log(`docs_only=${result}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${result}\n`);
}
