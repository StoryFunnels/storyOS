import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Stored credentials (anything under `secrets.` other than the per-run
// GITHUB_TOKEN) are only ever released to a job bound to a protected
// environment, only to the step that needs them, and a job that deploys can
// only start from main, over an SSH connection whose host key is pinned.
//
// The rules are read from the workflow files, not from a list of filenames: a
// new workflow that breaks one is caught without anyone editing this file.
const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => readFileSync(new URL(f, dir), 'utf8');

// Comments are documentation, not configuration.
const code = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');

const EPHEMERAL = new Set(['GITHUB_TOKEN']);

function credentialRefs(text) {
  const c = code(text);
  const out = [];
  for (const m of c.matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)) {
    if (!EPHEMERAL.has(m[1])) out.push(`secrets.${m[1]}`);
  }
  if (/^\s*secrets:\s*inherit\b/m.test(c)) out.push('secrets: inherit');
  if (/\bsecrets\s*\[/.test(c) || /toJSON\(\s*secrets\s*\)/.test(c)) out.push('secrets context');
  return out;
}

// [{ id, body }] for each job under `jobs:` (ids at indent 2).
function jobsOf(text) {
  const c = code(text);
  const at = c.search(/^jobs:\s*$/m);
  if (at < 0) return [];
  const rest = c.slice(at).replace(/^jobs:\s*\n/, '');
  const parts = rest.split(/^(?= {2}[A-Za-z0-9_-]+:\s*$)/m).filter((p) => /^ {2}[A-Za-z0-9_-]+:/.test(p));
  return parts.map((p) => ({ id: p.match(/^ {2}([A-Za-z0-9_-]+):/)[1], body: p }));
}
// Everything before `jobs:` (workflow-level keys).
function headerOf(text) {
  const c = code(text);
  const at = c.search(/^jobs:\s*$/m);
  return at < 0 ? c : c.slice(0, at);
}
function triggersOf(text) {
  const m = headerOf(text).match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m);
  return m ? [...m[1].matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]) : [];
}
function pushBlock(text) {
  const m = headerOf(text).match(/^ {2}push:\s*\n((?: {4,}.*\n)*)/m);
  return m ? m[1] : '';
}
function declaresEnvironment(body) {
  return /^ {4}environment:\s*\S/m.test(body) || /^ {4}environment:\s*\n {6}name:\s*\S/m.test(body);
}
// A block (`env:` / `permissions:`) at the given indent, or inline `{}` text.
function blockAt(text, key, indent) {
  const pad = ' '.repeat(indent);
  const m = text.match(new RegExp(`^${pad}${key}:[ \\t]*(\\{\\})?[ \\t]*\\n?((?:${pad} +.*\\n?)*)`, 'm'));
  return m ? { inline: m[1] ?? '', body: m[2] } : null;
}
function isDeployJob(job) {
  return /^deploy/.test(job.id) || /^\s*(?:-\s+)?(?:run:\s+)?.*\b(?:ssh|scp|rsync)\b\s/m.test(job.body.replace(/^ {4}name:.*$/m, ''));
}

// Every rule, for one workflow. Neutral messages; empty = clean.
function violations(text) {
  const out = [];
  const jobs = jobsOf(text);
  const triggers = triggersOf(text);
  const prTriggered = triggers.some((t) => /^pull_request/.test(t));
  const header = headerOf(text);

  if (credentialRefs(header).length > 0) out.push('workflow level must not reference stored credentials');
  if (credentialRefs(text).some((r) => r === 'secrets: inherit' || r === 'secrets context')) {
    out.push('the secrets context must not be passed on whole');
  }
  if (prTriggered && credentialRefs(text).length > 0) out.push('pull request workflows must not reference stored credentials');
  if (prTriggered && jobs.some((j) => declaresEnvironment(j.body))) out.push('pull request workflows must not use an environment');

  const deployJobs = jobs.filter(isDeployJob);
  for (const job of jobs) {
    const refs = credentialRefs(job.body);
    if (refs.length > 0 && !declaresEnvironment(job.body)) {
      out.push(`${job.id}: stored credentials outside an environment-bound job`);
    }
    const env = blockAt(job.body, 'env', 4);
    if (env && credentialRefs(env.body).length > 0) out.push(`${job.id}: stored credentials in job-level env`);
  }

  for (const job of deployJobs) {
    if (!declaresEnvironment(job.body)) out.push(`${job.id}: deploy job must use an environment`);
    const jobPerm = blockAt(job.body, 'permissions', 4);
    const wfPerm = blockAt(header, 'permissions', 0);
    if (!jobPerm && !wfPerm) out.push(`${job.id}: deploy job must set explicit permissions`);
    if (/:\s*write\b/.test((jobPerm?.body ?? '') + (wfPerm?.body ?? ''))) out.push(`${job.id}: deploy job must not hold write permissions`);
    if (triggers.length > 1 && !/github\.ref == 'refs\/heads\/main'/.test(job.body.match(/^ {4}if:.*$/m)?.[0] ?? '')) {
      out.push(`${job.id}: deploy job must require the main ref`);
    }
    if (/\bssh\b/.test(job.body)) {
      if (!/^\s*StrictHostKeyChecking(?:\s+|=)yes\s*$/m.test(job.body)) out.push(`${job.id}: ssh must verify the host key`);
      if (!/known_hosts/.test(job.body) || !/secrets\.[A-Z0-9_]*KNOWN_HOSTS/.test(job.body)) {
        out.push(`${job.id}: ssh must use a pinned known_hosts value`);
      }
    }
  }
  if (deployJobs.length > 0) {
    const bad = triggers.filter((t) => t !== 'push' && t !== 'workflow_dispatch');
    if (bad.length > 0) out.push(`deploy workflows must not trigger on: ${bad.join(', ')}`);
    if (triggers.includes('push')) {
      const p = pushBlock(text);
      if (!/^\s+branches:\s*\[\s*main\s*\]\s*$/m.test(p) && !/^\s+branches:\s*\n\s+-\s*main\s*$/m.test(p)) {
        out.push('deploy workflows must only trigger on pushes to main');
      }
      if (/^\s+tags(-ignore)?:/m.test(p)) out.push('deploy workflows must not trigger on tags');
    }
  }

  if (/StrictHostKeyChecking(?:\s+|=)(no|off|accept-new)\b/i.test(code(text))) out.push('host key checking must not be relaxed');
  if (/\bssh-keyscan\b/.test(code(text))) out.push('host keys must be pinned, not scanned');
  if (/UserKnownHostsFile(?:\s+|=)\/dev\/null/.test(code(text))) out.push('known hosts must not be discarded');
  return out;
}

test('workflows are found', () => {
  assert.ok(files.length >= 6, 'sanity: workflows are found');
  assert.ok(files.some((f) => jobsOf(read(f)).some(isDeployJob)), 'sanity: deploy jobs are recognised');
});

for (const f of files) {
  test(`${f} keeps stored credentials inside protected deploy jobs`, () => {
    assert.deepEqual(violations(read(f)), [], `${f}: credential rules`);
  });
}

test('the checks catch violations', () => {
  const staging = read('build-images.yml');
  const prod = read('deploy-production.yml');
  assert.deepEqual(violations(staging), [], 'sanity: staging baseline is clean');
  assert.deepEqual(violations(prod), [], 'sanity: production baseline is clean');

  const has = (text, needle) => violations(text).some((m) => m.includes(needle));
  const drop = (text, re) => {
    const next = text.replace(re, '');
    assert.notEqual(next, text, `mutation applied: ${re}`);
    return next;
  };
  const swap = (text, a, b) => {
    const next = text.replace(a, b);
    assert.notEqual(next, text, `mutation applied: ${a}`);
    return next;
  };

  // environment on the deploy job
  assert.ok(has(drop(staging, /^ {4}environment:\n {6}name: staging\n {6}url: .*\n/m), 'environment'));
  assert.ok(has(drop(prod, /^ {4}environment:\n {6}name: production\n/m), 'environment'));
  // credentials outside an environment-bound job
  const ci = read('ci.yml');
  assert.ok(has(swap(ci, /^jobs:\n/m, 'jobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ secrets.EXAMPLE_KEY }}"\n'), 'outside an environment'));
  // credentials in env above the step
  assert.ok(has(swap(staging, /^( {4})timeout-minutes: 10\n/m, '    timeout-minutes: 10\n    env:\n      K: ${{ secrets.STAGING_SSH_KEY }}\n'), 'job-level env'));
  assert.ok(has(swap(staging, /^jobs:\n/m, 'env:\n  K: ${{ secrets.STAGING_SSH_KEY }}\njobs:\n'), 'workflow level'));
  // whole context
  assert.ok(has(swap(staging, /STAGING_HOST: \$\{\{ secrets\.STAGING_HOST \}\}/, 'STAGING_HOST: ${{ toJSON(secrets) }}'), 'secrets context'));
  assert.ok(has(staging + '\n    secrets: inherit\n', 'secrets context'));
  // pull request triggers
  assert.ok(has(swap(staging, /^ {2}workflow_dispatch:/m, '  pull_request:\n  workflow_dispatch:'), 'must not trigger on'));
  assert.ok(has(swap(ci, /^jobs:\n/m, 'jobs:\n  extra:\n    runs-on: ubuntu-latest\n    environment: staging\n    steps:\n      - run: echo hi\n'), 'pull request workflows'));
  assert.ok(has(swap(ci, /^jobs:\n/m, 'jobs:\n  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "${{ secrets.EXAMPLE_KEY }}"\n'), 'pull request workflows'));
  // push scope
  assert.ok(has(swap(staging, /branches: \[main\]/, 'branches: [main, "**"]'), 'pushes to main'));
  assert.ok(has(drop(staging, /^ {4}branches: \[main\]\n/m), 'pushes to main'));
  assert.ok(has(swap(staging, /^ {2}push:\n/m, "  push:\n    tags: ['v*']\n"), 'tags'));
  // main-ref gate on a deploy job reachable by more than one trigger
  assert.ok(has(swap(staging, / && github\.ref == 'refs\/heads\/main'/, ''), 'main ref'));
  // permissions
  assert.ok(has(drop(staging, /^ {4}permissions: \{\}\n/m), 'explicit permissions'));
  assert.ok(has(swap(staging, /^ {4}permissions: \{\}\n/m, '    permissions:\n      contents: write\n'), 'write permissions'));
  // host key handling
  assert.ok(has(swap(staging, /StrictHostKeyChecking yes/, 'StrictHostKeyChecking no'), 'host key'));
  assert.ok(has(swap(staging, /StrictHostKeyChecking yes/, 'StrictHostKeyChecking accept-new'), 'host key'));
  assert.ok(has(drop(staging, /^ +StrictHostKeyChecking yes\n/m), 'verify the host key'));
  assert.ok(has(swap(staging, /secrets\.STAGING_KNOWN_HOSTS/, 'secrets.STAGING_SSH_KEY'), 'pinned known_hosts'));
  assert.ok(has(swap(staging, /^( +)ssh staging bash/m, '$1ssh-keyscan x >> ~/.ssh/known_hosts\n$1ssh staging bash'), 'scanned'));
  assert.ok(has(swap(staging, /IdentitiesOnly yes/, 'IdentitiesOnly yes\n  UserKnownHostsFile /dev/null'), 'discarded'));

  // what must be KEPT: the ephemeral token, and comments about the rules
  assert.deepEqual(credentialRefs('  password: ${{ secrets.GITHUB_TOKEN }}\n'), []);
  assert.deepEqual(credentialRefs('# secrets.STAGING_SSH_KEY lives in the environment\n'), []);
  assert.deepEqual(violations(prod.replace(/^( {4})timeout-minutes: 20\n/m, '$1timeout-minutes: 20\n')), []);
});
