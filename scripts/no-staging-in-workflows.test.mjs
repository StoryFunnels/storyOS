import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// There is no staging environment. No workflow may carry a job for one or read
// a secret that belongs to one. Comments are documentation, not configuration,
// so they are stripped first. WORKFLOWS_DIR lets a mutation check point this at
// a copy of the workflows that still has a staging job.
const dir = process.env.WORKFLOWS_DIR
  ? pathToFileURL(process.env.WORKFLOWS_DIR.replace(/\/?$/, '/'))
  : new URL('../.github/workflows/', import.meta.url);
const code = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');

function stagingReferences(text) {
  const c = code(text);
  return [
    ...[...c.matchAll(/secrets\.([A-Z0-9_]*STAGING[A-Z0-9_]*)/gi)].map((m) => `secrets.${m[1]}`),
    ...[...c.matchAll(/^ {2}([A-Za-z0-9_-]*staging[A-Za-z0-9_-]*):\s*$/gim)].map((m) => `job ${m[1]}`),
  ];
}

test('the rule catches a staging job and a staging secret (self-check)', () => {
  const bad = 'jobs:\n  deploy-staging:\n    steps:\n      - run: x\n        env:\n          K: ${{ secrets.STAGING_SSH_KEY }}\n';
  assert.deepEqual(stagingReferences(bad), ['secrets.STAGING_SSH_KEY', 'job deploy-staging']);
  assert.deepEqual(stagingReferences('# deploy-staging was removed\njobs:\n  build:\n    steps: []\n'), []);
});

test('no workflow has a staging job or reads a staging secret', () => {
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, 'found workflows');
  for (const f of files) {
    assert.deepEqual(stagingReferences(readFileSync(new URL(f, dir), 'utf8')), [], `${f} references staging`);
  }
});
