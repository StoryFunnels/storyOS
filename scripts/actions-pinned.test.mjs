import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// #1053 — a tag like `@v4` can be moved to different code by whoever controls
// the action's repo; a full commit sha cannot. Every `uses:` in every workflow
// must name a 40-hex sha (Dependabot bumps them, keeping the `# vX.Y.Z` note).
// Local actions (`./...`) and `docker://` images are not GitHub refs and are skipped.
const dir = new URL('../.github/workflows/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

function unpinned(text) {
  return [...text.matchAll(/^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)/gm)]
    .map((m) => m[1])
    .filter((ref) => !ref.startsWith('./') && !ref.startsWith('docker://'))
    .filter((ref) => !/@[0-9a-f]{40}$/.test(ref));
}

test('every workflow action is pinned to a full commit sha', () => {
  assert.ok(files.length > 0, 'sanity: workflows are found');
  const bad = files.flatMap((f) => unpinned(readFileSync(new URL(f, dir), 'utf8')).map((ref) => `${f}: ${ref}`));
  assert.deepEqual(bad, [], `actions not pinned to a sha:\n${bad.join('\n')}`);
});

test('the check catches a tag-pinned action', () => {
  assert.deepEqual(unpinned('    - uses: actions/checkout@v4\n'), ['actions/checkout@v4']);
  assert.deepEqual(unpinned(`      uses: actions/checkout@${'a'.repeat(40)} # v4.4.0\n`), []);
});
