#!/usr/bin/env node
/**
 * #793 — which of the three Docker images (api/web/mcp) a diff actually
 * touches, so ci.yml's validation job and build-images.yml's publish job can
 * both skip work a diff cannot possibly affect, from ONE place instead of two
 * copies of the same path list drifting apart.
 *
 * FAIL-SAFE, not fail-closed like collision-check.mjs: a docker validation
 * skipped when it should have run is a missed check (ci.yml, item A); a
 * publish job that SKIPS BUILDING a service leaves no image at that commit's
 * sha, and docker-compose.prod.yml pins IMAGE_TAG for all three (#793's own
 * caution) — a broken deploy, not a missed warning. So whenever the diff
 * cannot be computed (no base ref — workflow_dispatch, a shallow clone, a
 * merge_group's base_sha missing), every service is reported changed. The
 * cost of a wrong "yes" here is a rebuild that wasn't needed; the cost of a
 * wrong "no" is a stale image running in production.
 *
 * Each service's own input set, read off the Dockerfiles rather than
 * asserted: api only COPYs packages/sdk's package.json (a stub, never
 * built), so an sdk source change does not affect it — but web and mcp both
 * `pnpm --filter @storyos/sdk build` it, so they depend on it for real.
 * packages/schemas and packages/config are copied into and built by all
 * three, so a change there always means all three.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const COMMON = ['packages/schemas/', 'packages/config/', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'turbo.json'];
const SERVICES = {
  api: ['apps/api/', 'docker/api.Dockerfile'],
  web: ['apps/web/', 'docker/web.Dockerfile', 'packages/sdk/'],
  mcp: ['packages/mcp/', 'docker/mcp.Dockerfile', 'packages/sdk/'],
};
/** ci.yml's job also validates docker-compose*.yml — not a build input for
 * any service, but still a reason for THAT job (not build-images.yml) to run. */
const COMPOSE = ['docker-compose.yml', 'docker-compose.prod.yml'];

const BASE = process.env.DOCKER_DIFF_BASE || '';
const HEAD = process.env.DOCKER_DIFF_HEAD || 'HEAD';

function changedFiles() {
  if (!BASE) return null; // no base to diff against — caller must assume everything changed
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${BASE}...${HEAD}`], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch (error) {
    console.error(`git diff ${BASE}...${HEAD} failed: ${error.message}`);
    return null; // unresolvable base (shallow clone, unknown sha) — same fail-safe as above
  }
}

function matches(file, prefixes) {
  return prefixes.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

const files = changedFiles();
const result = {};
if (files === null) {
  console.log('No usable base ref — treating every service (and compose) as changed.');
  result.api = result.web = result.mcp = result.compose = true;
} else {
  console.log(`${files.length} file(s) changed since ${BASE}:`);
  for (const f of files) console.log(`  ${f}`);
  const commonChanged = files.some((f) => matches(f, COMMON));
  for (const [service, paths] of Object.entries(SERVICES)) {
    result[service] = commonChanged || files.some((f) => matches(f, paths));
  }
  result.compose = files.some((f) => matches(f, COMPOSE));
}
result.any = result.api || result.web || result.mcp || result.compose;
/**
 * A JSON array of just the changed service names — build-images.yml's `build`
 * job uses this as a DYNAMIC matrix axis (`service: ${{ fromJSON(...) }}`),
 * because a job's own `if:` cannot reference `matrix.*` (only `github`,
 * `inputs`, `needs`, `vars` are available there — confirmed by actionlint,
 * not assumed). An empty array means GitHub generates zero `service x arch`
 * combinations for `build`, so an all-unchanged push runs no build jobs at
 * all rather than three jobs that immediately no-op.
 */
result.services = JSON.stringify(Object.keys(SERVICES).filter((s) => result[s]));

for (const [key, value] of Object.entries(result)) {
  console.log(`${key}=${value}`);
}
if (process.env.GITHUB_OUTPUT) {
  const lines = Object.entries(result).map(([k, v]) => `${k}=${v}\n`).join('');
  appendFileSync(process.env.GITHUB_OUTPUT, lines);
}
