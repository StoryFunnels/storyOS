import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #1123 — the `ci` job is the only required check, so a job it does not wait on
// can be red and the PR still merges. Read the workflow itself rather than a
// list kept here: a job added later is covered without anyone editing this test.
const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function jobIds(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
}

function gateNeeds(text) {
  const job = text.slice(text.search(/^ {2}ci:\s*$/m));
  const line = job.match(/^ {4}needs:\s*\[([^\]]*)\]/m);
  assert.ok(line, 'the ci job has an inline `needs: [...]` list');
  return line[1].split(',').map((s) => s.trim()).filter(Boolean);
}

test('the ci gate waits on every other job in ci.yml', () => {
  const others = jobIds(workflow).filter((id) => id !== 'ci');
  assert.ok(others.includes('images'), 'sanity: the Docker images job is found');
  const missing = others.filter((id) => !gateNeeds(workflow).includes(id));
  assert.deepEqual(missing, [], `jobs the required ci check does not wait on: ${missing.join(', ')}`);
});
