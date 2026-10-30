#!/usr/bin/env node
/**
 * #1124 — the base build-images.yml's `changes` job diffs against: the newest
 * main commit whose `Build & push images` run SUCCEEDED, i.e. the last commit
 * that really has all three `:<sha>` images.
 *
 * Diffing against `github.event.before` (the previous push) was wrong whenever
 * the previous push's run never published. The workflow keeps one pending run
 * and cancels the older one, so in a burst of merges the middle commit gets no
 * images at all. The next run then diffed only against that cancelled commit,
 * and a service changed ONLY in it was reported unchanged — `merge` re-tagged
 * its old `:latest` onto the new sha, an image without that commit's code.
 * 5 of 30 runs were cancelled when this was found; each time the next commit
 * happened to touch the same service, which is luck, not design.
 *
 * The candidate must be a STRICT ancestor of HEAD. Re-running an old run would
 * otherwise find a newer published commit, diff HEAD against its own
 * descendant, see nothing changed, and re-tag a newer `:latest` onto an old sha.
 * No usable candidate → fall back to the previous behaviour (FALLBACK, normally
 * `github.event.before`); docker-inputs-changed.mjs still rebuilds everything
 * when that is empty or unresolvable.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** First candidate (newest first) that is a strict ancestor of head, else fallback. */
export function pickBase(candidates, head, isStrictAncestor, fallback) {
  for (const sha of candidates) {
    if (sha && sha !== head && isStrictAncestor(sha, head)) return { base: sha, from: 'last published' };
  }
  return { base: fallback || '', from: 'fallback' };
}

function gitIsStrictAncestor(sha, head) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, head], { stdio: 'ignore' });
    return true;
  } catch {
    return false; // not an ancestor, or a sha this clone does not have
  }
}

async function publishedShas() {
  const { GITHUB_API_URL = 'https://api.github.com', GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
  const url = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/build-images.yml/runs?branch=main&status=success&per_page=30`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()).workflow_runs.map((r) => r.head_sha);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  let candidates = [];
  try {
    candidates = await publishedShas();
  } catch (error) {
    console.log(`could not list published runs (${error.message}) — using the fallback base`);
  }
  const { base, from } = pickBase(candidates, head, gitIsStrictAncestor, process.env.FALLBACK);
  console.log(`base=${base || '(none)'} (${from})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`);
}
