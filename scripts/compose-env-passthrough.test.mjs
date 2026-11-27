import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Ticket #1360 — an operator is told to put a variable in `.env`, but `docker compose` only hands the
// api container the variables the `api` service lists under `environment:`. A documented variable that
// is not listed is silently dropped: the operator sets META_APP_ID, restarts, and the provider stays
// "operator-only" with nothing saying why. This test reads two docs and the compose file and fails
// when a documented operator variable is not passed through. It only READS files; it writes nothing.
//
// docker-compose.prod.yml overrides `image:` only, so it inherits `environment:` from the base file
// and is covered by this same check.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// Documented variables that are deliberately NOT passed to the api container. Each needs a reason.
const EXCLUDED = {
  POSTGRES_PASSWORD: 'consumed by the postgres service and interpolated into DATABASE_URL, not read by api by name',
  HTTP_PORT: 'host port of the Caddy proxy, interpolated by compose only',
  HTTPS_PORT: 'host port of the Caddy proxy, interpolated by compose only',
  NEXT_PUBLIC_API_URL: 'a build-time arg for the web image, not a runtime api variable',
  CSP_MODE: 'read by the web container',
  API_INTERNAL_URL: 'read by the web container',
  MCP_PUBLIC_URL: 'read by the mcp service',
  MCP_AUTH_SERVER: 'read by the mcp service',
  MCP_MAX_BODY_BYTES: 'read by the mcp service',
};

const NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** Variables an operator is told to set: `NAME=` lines in code fences, and backticked names in the
 *  first column of a table row (configuration.md) or the "client id/secret env" columns (integrations). */
function documentedVars(markdown) {
  const found = new Set();
  for (const fence of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    for (const m of fence[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)) found.add(m[1]);
  }
  for (const row of markdown.split('\n').filter((l) => /^\|/.test(l))) {
    const cells = row.split('|').slice(1, -1);
    const first = cells[0] ?? '';
    for (const m of first.matchAll(/`([A-Z0-9_]+)`/g)) found.add(m[1]);
    if (/^\|\s*(YouTube|Google Calendar|Facebook)/.test(row)) {
      for (const c of cells.slice(2, 4)) for (const m of c.matchAll(/`([A-Z0-9_]+)`/g)) found.add(m[1]);
    }
  }
  return [...found].filter((n) => NAME.test(n));
}

/** Names under the `api:` service's `environment:` block (a text read; no YAML dependency in scripts/). */
function apiEnvironment(compose) {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => /^  api:\s*$/.test(l));
  assert.ok(start >= 0, 'compose has an api service');
  const names = new Set();
  let inEnv = false;
  for (const l of lines.slice(start + 1)) {
    if (/^  \S/.test(l)) break; // next service
    if (/^    environment:\s*$/.test(l)) {
      inEnv = true;
      continue;
    }
    if (inEnv && /^    \S/.test(l)) inEnv = false; // next key of the service
    const m = inEnv && l.match(/^      ([A-Z][A-Z0-9_]*):/);
    if (m) names.add(m[1]);
  }
  return names;
}

const DOCS = ['docs/self-hosting-integrations.md', 'apps/docs/src/content/docs/self-hosting/configuration.md'];

test('every operator variable the self-hosting docs name reaches the api container', () => {
  const env = apiEnvironment(read('docker-compose.yml'));
  assert.ok(env.size > 10, 'sanity: the api environment was parsed');
  const missing = DOCS.flatMap((doc) =>
    documentedVars(read(doc))
      .filter((v) => !env.has(v) && !(v in EXCLUDED))
      .map((v) => `${v} (documented in ${doc})`),
  );
  assert.deepEqual(missing, [], `documented but not passed through docker-compose.yml api.environment:\n${missing.join('\n')}`);
});

test('an excluded variable that compose now passes through is dropped from the exclusion list', () => {
  const env = apiEnvironment(read('docker-compose.yml'));
  for (const v of Object.keys(EXCLUDED)) {
    assert.ok(!env.has(v), `${v} is excluded but compose passes it: drop it from EXCLUDED`);
  }
});

test('the parsers catch what they are for', () => {
  assert.deepEqual(documentedVars('```\nFOO_BAR=1\n```\n| `A_B` / `C_D` | x |\n'), ['FOO_BAR', 'A_B', 'C_D']);
  const compose = '  api:\n    environment:\n      A_B: ${A_B:-}\n    ports: []\n  web:\n    environment:\n      NOT_API: 1\n';
  assert.deepEqual([...apiEnvironment(compose)], ['A_B']);
});
