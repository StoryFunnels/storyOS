import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The two publish workflows are tag-only, bound to the `npm-publish`
// environment, and authenticate with a short-lived OIDC identity (trusted
// publishing) instead of a stored credential. This pins that shape.
const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const PUBLISH = ['npm-publish.yml', 'npm-publish-runner.yml'];
const ENV = 'npm-publish';

const read = (f) => readFileSync(new URL(f, dir), 'utf8');
// Comments are documentation, not configuration.
const code = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');

// Stored-credential references. No workflow may carry any of these.
function credentialRefs(text) {
  const c = code(text);
  return [
    ...[...c.matchAll(/secrets\.(NPM_[A-Z0-9_]*)/g)].map((m) => `secrets.${m[1]}`),
    ...[...c.matchAll(/\b(NPM_TOKEN|NODE_AUTH_TOKEN)\b/g)].map((m) => m[1]),
  ];
}
function triggers(text) {
  const m = code(text).match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m);
  return m ? [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]) : [];
}
function hasEnvironment(text) {
  return new RegExp(`^\\s+environment:\\s*['"]?${ENV}['"]?\\s*$`, 'm').test(code(text));
}
function hasBranchFilter(text) {
  return /^\s+branches(-ignore)?:/m.test(code(text));
}
// Body of a `permissions:` block at the given indent (0 = workflow level,
// 4 = job level). Handles the block form only, which is what this repo uses.
function permissionsAt(text, indent) {
  const pad = ' '.repeat(indent);
  const re = new RegExp(`^${pad}permissions:[ \\t]*\\n((?:${pad} +.*\\n?)+)`, 'm');
  const m = code(text).match(re);
  return m ? m[1] : null;
}
function grantsIdToken(block) {
  return block !== null && /^\s*id-token:\s*write\s*$/m.test(block);
}

// All rules for one publish workflow. Returns neutral messages; empty = clean.
function publishViolations(text) {
  const out = [];
  const c = code(text);
  if (!hasEnvironment(text)) out.push(`job must use the ${ENV} environment`);
  const t = triggers(text);
  if (t.join(',') !== 'push') out.push(`must trigger on tags only (found: ${t.join(', ') || 'none'})`);
  if (hasBranchFilter(text)) out.push('must not filter on branches');
  if (!/^\s+tags:/m.test(c)) out.push('push trigger must be a tags filter');
  if (!/if:\s*github\.ref_type == 'tag'/.test(c)) out.push('job must require a tag ref');
  if (!/merge-base --is-ancestor/.test(c)) out.push('tagged commit must be checked against main');
  if (!grantsIdToken(permissionsAt(text, 4))) out.push('publish job must grant id-token: write');
  if (permissionsAt(text, 0) === null) out.push('workflow level must set explicit permissions');
  if (grantsIdToken(permissionsAt(text, 0))) out.push('id-token must not be granted at workflow level');
  if (!/^\s*contents:\s*read\s*$/m.test(permissionsAt(text, 0) ?? '')) {
    out.push('workflow level must grant contents: read');
  }
  if (!/npm publish\b[^\n]*--provenance\b/.test(c)) out.push('publish command must pass --provenance');
  if (/\bpnpm\b[^\n]*\bpublish\b/.test(c)) out.push('publish must run through npm, not another client');
  if (credentialRefs(text).length > 0) out.push('must not reference stored credentials');
  return out;
}

test('no workflow references a stored npm credential', () => {
  assert.ok(files.length > 0, 'sanity: workflows are found');
  const bad = files.filter((f) => credentialRefs(read(f)).length > 0);
  assert.deepEqual(bad, [], `stored npm credentials referenced in: ${bad.join(', ')}`);
});

for (const f of PUBLISH) {
  test(`${f} satisfies the publish rules`, () => {
    assert.ok(files.includes(f), `${f} exists`);
    assert.deepEqual(publishViolations(read(f)), [], `${f}: publish rules`);
  });
}

test('the checks catch violations', () => {
  const ok = read('npm-publish.yml');
  assert.deepEqual(publishViolations(ok), [], 'sanity: baseline is clean');

  const has = (text, needle) => publishViolations(text).some((m) => m.includes(needle));

  // environment
  assert.ok(has(ok.replace(/environment: npm-publish/, ''), 'environment'));
  // triggers
  assert.ok(has(ok.replace('push:', 'pull_request:'), 'tags only'));
  assert.ok(has(ok.replace(/ {2}push:\n/, '  push:\n    branches: [main]\n'), 'branches'));
  assert.ok(has(ok.replace(/ {4}tags:\n {6}- 'mcp-v\*'\n/, ''), 'tags'));
  // gates
  assert.ok(has(ok.replace(/if: github\.ref_type == 'tag'/, "if: always()"), 'tag ref'));
  assert.ok(has(ok.replace(/merge-base --is-ancestor/g, 'merge-base'), 'against main'));
  // id-token placement
  const noJobToken = ok.replace(/^( {4})permissions:\n(?: {6}.*\n)+/m, '');
  assert.ok(has(noJobToken, 'id-token: write'));
  const wfToken = ok.replace(/^permissions:\n {2}contents: read\n/m, 'permissions:\n  contents: read\n  id-token: write\n');
  assert.ok(has(wfToken, 'workflow level'));
  assert.ok(has(ok.replace(/^permissions:\n {2}contents: read\n/m, ''), 'explicit permissions'));
  assert.ok(has(ok.replace(/^permissions:\n {2}contents: read\n/m, 'permissions:\n  actions: read\n'), 'contents: read'));
  // provenance and client
  assert.ok(has(ok.replace(/ --provenance/g, ''), '--provenance'));
  assert.ok(has(ok.replace(/npm publish/g, 'pnpm publish'), 'not another client'));
  // stored credentials, in the publish workflows and anywhere else
  assert.ok(has(ok + '\n        env:\n          A: ${{ secrets.NPM_TOKEN }}\n', 'stored credentials'));
  assert.ok(has(ok + '\n        env:\n          NODE_AUTH_TOKEN: x\n', 'stored credentials'));
  assert.deepEqual(credentialRefs('  env:\n    A: ${{ secrets.NPM_PUBLISH }}\n'), ['secrets.NPM_PUBLISH']);
  assert.deepEqual(credentialRefs('# NPM_TOKEN and NODE_AUTH_TOKEN\n'), []);
});
