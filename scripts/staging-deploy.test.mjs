import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #1125 — the staging deploy failed 10 times in 24 while every run showed green
// (`continue-on-error`), was skipped whenever no image changed, and pulled main
// instead of the sha whose images it deployed. Read the job from the workflow.
const workflow = readFileSync(new URL('../.github/workflows/build-images.yml', import.meta.url), 'utf8');

function job(text, id) {
  const start = text.search(new RegExp(`^ {2}${id}:\\s*$`, 'm'));
  assert.ok(start >= 0, `job ${id} exists`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

const deploy = job(workflow, 'deploy-staging');

test('a failed staging deploy is not hidden', () => {
  assert.doesNotMatch(deploy, /^ {4}continue-on-error:\s*true/m);
});

test('staging deploys even when no image was rebuilt', () => {
  assert.match(deploy, /^ {4}if:\s*always\(\) && needs\.merge\.result == 'success'( && github\.ref == 'refs\/heads\/main')?\s*$/m);
});

test('staging checks out the sha it deploys, not the tip of main', () => {
  assert.match(deploy, /checkout -q --detach \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(deploy, /^\s+git pull/m);
});

// Ticket #1121 — staging deploys through the `staging` environment and pins the
// host key, the same way deploy-production.yml does.
test('staging deploys through the staging environment', () => {
  assert.match(deploy, /^ {4}environment:\s*\n {6}name:\s*staging\s*$/m);
});

test('staging pins its SSH host key', () => {
  assert.match(deploy, /secrets\.STAGING_KNOWN_HOSTS/);
  assert.match(deploy, /^\s+StrictHostKeyChecking yes\s*$/m);
  assert.doesNotMatch(deploy, /accept-new|StrictHostKeyChecking=no|StrictHostKeyChecking no/);
});
