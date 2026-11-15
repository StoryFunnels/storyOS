import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// The npm token is used by exactly two workflows, both tag-only and both bound
// to the `npm-publish` environment. This pins that shape.
const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const PUBLISH = ['npm-publish.yml', 'npm-publish-runner.yml'];
const ENV = 'npm-publish';

const read = (f) => readFileSync(new URL(f, dir), 'utf8');
// Comments are documentation, not configuration.
const code = (text) => text.replace(/^\s*#.*$/gm, '').replace(/\s#\s.*$/gm, '');

function npmSecretRefs(text) {
  return [...code(text).matchAll(/secrets\.(NPM_[A-Z0-9_]*)/g)].map((m) => m[1]);
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
// env: blocks that carry an npm secret, with the block's indentation.
function secretEnvBlocks(text) {
  const c = code(text);
  return [...c.matchAll(/^( *)env:[ \t]*\n((?:\1 +.*\n?)+)/gm)]
    .filter((m) => /secrets\.NPM_/.test(m[2]))
    .map((m) => ({ indent: m[1].length, index: m.index }));
}

test('only the publish workflows reference npm secrets', () => {
  assert.ok(files.length > 0, 'sanity: workflows are found');
  const bad = files.filter((f) => !PUBLISH.includes(f) && npmSecretRefs(read(f)).length > 0);
  assert.deepEqual(bad, [], `npm secrets referenced outside the publish workflows: ${bad.join(', ')}`);
});

for (const f of PUBLISH) {
  test(`${f} uses the ${ENV} environment`, () => {
    assert.ok(npmSecretRefs(read(f)).length > 0, 'sanity: the workflow publishes with the secret');
    assert.ok(hasEnvironment(read(f)), `${f}: publish jobs must use the ${ENV} environment`);
  });
  test(`${f} is tag-triggered only`, () => {
    const t = triggers(read(f));
    assert.deepEqual(t, ['push'], `${f}: publish workflows must trigger on tags only (found: ${t.join(', ')})`);
    assert.ok(!hasBranchFilter(read(f)), `${f}: publish workflows must not filter on branches`);
    assert.match(code(read(f)), /^\s+tags:/m, `${f}: push trigger must be a tags filter`);
  });
  test(`${f} gates the job on a tag and checks main ancestry`, () => {
    const c = code(read(f));
    assert.match(c, /if:\s*github\.ref_type == 'tag'/, `${f}: job must require a tag ref`);
    assert.match(c, /merge-base --is-ancestor/, `${f}: tagged commit must be checked against main`);
  });
  test(`${f} gives the secret to the publish step only`, () => {
    const c = code(read(f));
    const blocks = secretEnvBlocks(read(f));
    assert.equal(blocks.length, 1, `${f}: expected exactly one env block with the secret`);
    assert.ok(blocks[0].indent >= 8, `${f}: the secret must sit on a step, not on the job or workflow`);
    const stepStart = c.lastIndexOf('- run:', blocks[0].index);
    assert.match(c.slice(stepStart, blocks[0].index), /publish/, `${f}: the secret belongs to the publish step`);
  });
}

test('the checks catch violations', () => {
  const ok = read('npm-publish.yml');
  assert.ok(hasEnvironment(ok));
  assert.ok(!hasEnvironment(ok.replace(/environment: npm-publish/, '')));
  assert.deepEqual(triggers(ok.replace('push:', 'pull_request:')), ['pull_request']);
  assert.deepEqual(triggers(ok), ['push']);
  assert.deepEqual(npmSecretRefs('  env:\n    A: ${{ secrets.NPM_TOKEN }}\n'), ['NPM_TOKEN']);
  assert.deepEqual(npmSecretRefs('# ${{ secrets.NPM_TOKEN }}\n'), []);
  assert.equal(secretEnvBlocks('    env:\n      A: ${{ secrets.NPM_TOKEN }}\n')[0].indent, 4);
});
