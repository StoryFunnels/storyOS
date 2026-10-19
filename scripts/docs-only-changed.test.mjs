import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docsOnly } from './docs-only-changed.mjs';
import { notGreen } from './ci-gate.mjs';

test('docs-only: docs paths and root markdown', () => {
  assert.equal(docsOnly(['apps/docs/src/a.md', 'docs/architecture/x.md', 'tickets/1.md', 'README.md']), true);
});
test('a single code file makes it code', () => {
  assert.equal(docsOnly(['docs/a.md', 'apps/api/src/x.ts']), false);
});
test('markdown under apps/ or packages/ is NOT docs (fixtures, package READMEs)', () => {
  assert.equal(docsOnly(['apps/api/test/fixture.md']), false);
  assert.equal(docsOnly(['packages/mcp/README.md']), false);
});
test('workflow, lockfile and script changes are code', () => {
  for (const f of ['.github/workflows/ci.yml', 'pnpm-lock.yaml', 'scripts/ci-gate.mjs', 'docker/api.Dockerfile']) assert.equal(docsOnly([f]), false, f);
});
test('fails safe: unknown diff or empty diff is code', () => {
  assert.equal(docsOnly(null), false);
  assert.equal(docsOnly([]), false);
});

const ok = { result: 'success' }, skipped = { result: 'skipped' }, failure = { result: 'failure' };
const all = (over = {}) => ({ changes: ok, checks: ok, 'test-api': ok, 'test-other': ok, ...over });

test('gate: a code PR with everything green passes', () => {
  assert.deepEqual(notGreen(all(), 'false'), []);
});
test('gate: docs-only PR may skip the test jobs', () => {
  assert.deepEqual(notGreen(all({ 'test-api': skipped, 'test-other': skipped }), 'true'), []);
});
test('gate: a code PR whose test job was skipped for any other reason FAILS', () => {
  assert.deepEqual(notGreen(all({ 'test-api': skipped }), 'false'), ['test-api']);
  assert.deepEqual(notGreen(all({ 'test-api': skipped }), ''), ['test-api']);
});
test('gate: a skip is not forgiven when `changes` itself did not succeed', () => {
  assert.deepEqual(notGreen(all({ changes: failure, 'test-api': skipped, 'test-other': skipped }), 'true').sort(), ['changes', 'test-api', 'test-other']);
});
test('gate: only the test jobs may skip; `checks` skipped or any failure still fails', () => {
  assert.deepEqual(notGreen(all({ checks: skipped }), 'true'), ['checks']);
  assert.deepEqual(notGreen(all({ 'test-other': failure }), 'true'), ['test-other']);
});
