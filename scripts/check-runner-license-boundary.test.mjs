// Tests for scripts/check-runner-license-boundary.mjs. Run by `pnpm test:scripts` (node --test).
//
// The check is worth nothing if it only ever passes, so the cases that matter are the VIOLATING fixtures: each one is a real way the
// boundary gets crossed quietly (a dependency line, an import, a relative path, a workspace: spec, an unlicensed workspace package, a
// copyleft production dependency), and each must fail. The real package must pass.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBoundary, expressionIsPermissive, importSpecifiers } from './check-runner-license-boundary.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const realRoot = resolve(here, '..');
const APACHE = readFileSync(join(realRoot, 'packages', 'runner', 'LICENSE'), 'utf8');

function write(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

/** A minimal repo: three workspace packages (two AGPL, one permissive) and a Runner that is clean unless `mutate` says otherwise. */
function fixture(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'runner-boundary-'));
  write(root, 'packages/schemas/package.json', { name: '@storyos/schemas', license: 'AGPL-3.0-or-later' });
  write(root, 'packages/sdk/package.json', { name: '@storyos/sdk', license: 'AGPL-3.0-or-later', dependencies: { '@storyos/schemas': 'workspace:*' } });
  write(root, 'packages/tiny-mit/package.json', { name: '@storyos/tiny-mit', license: 'MIT' });
  write(root, 'apps/api/package.json', { name: '@storyos/api', license: 'AGPL-3.0-or-later' });
  write(root, 'packages/runner/package.json', { name: '@storyos/runner', license: 'Apache-2.0', devDependencies: { vitest: '^4.0.0' } });
  write(root, 'packages/runner/LICENSE', APACHE);
  write(root, 'packages/runner/src/index.ts', "import { readFileSync } from 'node:fs';\nimport { x } from './x.js';\nexport const y = readFileSync;\n");
  write(root, 'packages/runner/src/x.ts', 'export const x = 1;\n');
  write(root, 'packages/runner/test/a.test.ts', "import { it } from 'vitest';\nimport { x } from '../src/x.js';\nit('a', () => x);\n");
  mutate(root);
  return root;
}

function violationsOf(mutate) {
  const root = fixture(mutate);
  try {
    return checkBoundary({ repoRoot: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const pkgOf = (root) => JSON.parse(readFileSync(join(root, 'packages/runner/package.json'), 'utf8'));
const setPkg = (root, patch) => write(root, 'packages/runner/package.json', { ...pkgOf(root), ...patch });

test('the real packages/runner passes', () => {
  assert.deepEqual(checkBoundary({ repoRoot: realRoot }), []);
});

test('a clean fixture passes', () => {
  assert.deepEqual(violationsOf(() => {}), []);
});

for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  test(`FAILS when ${field} names an AGPL workspace package`, () => {
    const v = violationsOf((root) => setPkg(root, { [field]: { '@storyos/schemas': 'workspace:*' } }));
    assert.equal(v.length >= 1, true);
    assert.match(v.join('\n'), new RegExp(`${field} names "@storyos/schemas"`));
  });
}

test('FAILS on a workspace: spec for an AGPL package even under another range', () => {
  const v = violationsOf((root) => setPkg(root, { devDependencies: { '@storyos/sdk': '^0.1.0' } }));
  assert.match(v.join('\n'), /names "@storyos\/sdk"/);
});

test('FAILS on a workspace: spec pointing at something that is not a known permissive workspace package', () => {
  const v = violationsOf((root) => setPkg(root, { devDependencies: { 'some-local': 'link:../elsewhere' } }));
  assert.match(v.join('\n'), /points into the repository/);
});

test('allows a PERMISSIVE workspace package, but FAILS if that package itself reaches an AGPL one', () => {
  assert.deepEqual(violationsOf((root) => setPkg(root, { dependencies: { '@storyos/tiny-mit': 'workspace:*' } })), []);
  const v = violationsOf((root) => {
    write(root, 'packages/tiny-mit/package.json', { name: '@storyos/tiny-mit', license: 'MIT', dependencies: { '@storyos/schemas': 'workspace:*' } });
    setPkg(root, { dependencies: { '@storyos/tiny-mit': 'workspace:*' } });
  });
  assert.match(v.join('\n'), /reaches "@storyos\/schemas" through "@storyos\/tiny-mit"/);
});

test('FAILS when a workspace package declares NO licence: cannot tell is not fine', () => {
  const v = violationsOf((root) => {
    write(root, 'packages/mystery/package.json', { name: '@storyos/mystery' });
    setPkg(root, { devDependencies: { '@storyos/mystery': 'workspace:*' } });
  });
  assert.match(v.join('\n'), /NO licence declared/);
});

for (const [label, code] of [
  ['a static import', "import { schema } from '@storyos/schemas';\n"],
  ['a deep import', "import { schema } from '@storyos/schemas/dist/index.js';\n"],
  ['a type-only import', "import type { Sdk } from '@storyos/sdk';\n"],
  ['a re-export', "export * from '@storyos/sdk';\n"],
  ['a dynamic import', "const m = await import('@storyos/schemas');\n"],
  ['a require', "const m = require('@storyos/sdk');\n"],
]) {
  test(`FAILS on ${label} of an AGPL workspace package in src`, () => {
    const v = violationsOf((root) => write(root, 'packages/runner/src/leak.ts', code));
    assert.match(v.join('\n'), /packages\/runner\/src\/leak\.ts imports "@storyos\//);
  });
}

test('FAILS on an import in a TEST file too', () => {
  const v = violationsOf((root) => write(root, 'packages/runner/test/leak.test.ts', "import { schema } from '@storyos/schemas';\n"));
  assert.match(v.join('\n'), /test\/leak\.test\.ts imports/);
});

test('FAILS on a relative import that climbs out of the package', () => {
  for (const spec of ['../../schemas/src/index.js', '../../../apps/api/src/main.js', '../../../../packages/sdk/src/index.js']) {
    const v = violationsOf((root) => write(root, 'packages/runner/src/climb.ts', `import { a } from '${spec}';\n`));
    assert.match(v.join('\n'), /resolves outside packages\/runner/, spec);
  }
});

test('does NOT fail on a relative import that stays inside, nor on a data file merely read by path', () => {
  const v = violationsOf((root) => write(root, 'packages/runner/test/data.test.ts', "import { x } from '../src/x.js';\nconst p = '../../../docs/api/openapi.json';\nexport { x, p };\n"));
  assert.deepEqual(v, []);
});

test('FAILS on a @storyos package it cannot identify', () => {
  const v = violationsOf((root) => write(root, 'packages/runner/src/who.ts', "import { z } from '@storyos/unknown-thing';\n"));
  assert.match(v.join('\n'), /cannot identify/);
});

test('FAILS when the Runner is not declared Apache-2.0, or LICENSE is missing or is another licence', () => {
  assert.match(violationsOf((root) => setPkg(root, { license: 'AGPL-3.0-or-later' })).join('\n'), /must be "Apache-2.0"/);
  assert.match(violationsOf((root) => setPkg(root, { license: undefined })).join('\n'), /must be "Apache-2.0"/);
  assert.match(violationsOf((root) => rmSync(join(root, 'packages/runner/LICENSE'))).join('\n'), /LICENSE is missing/);
  assert.match(violationsOf((root) => write(root, 'packages/runner/LICENSE', 'MIT License\n')).join('\n'), /not the Apache License/);
});

test('FAILS when there is no Runner to check: nothing to check is not passing', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-boundary-empty-'));
  try {
    assert.match(checkBoundary({ repoRoot: root }).join('\n'), /nothing to check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('production dependencies: a permissive one passes; a copyleft or unresolvable one FAILS', () => {
  const withDep = (license, resolvable = true) => (root) => {
    setPkg(root, { dependencies: { 'left-pad': '^1.0.0' } });
    if (resolvable) write(root, 'packages/runner/node_modules/left-pad/package.json', { name: 'left-pad', version: '1.0.0', ...(license ? { license } : {}) });
  };
  assert.deepEqual(violationsOf(withDep('MIT')), []);
  assert.deepEqual(violationsOf(withDep('(MIT OR GPL-3.0-only)')), []); // the permissive alternative may be taken
  assert.match(violationsOf(withDep('LGPL-3.0-only')).join('\n'), /not on the Runner's permissive-only list/);
  assert.match(violationsOf(withDep('MPL-2.0')).join('\n'), /permissive-only/); // fine for the AGPL repo, not for an embeddable package
  assert.match(violationsOf(withDep(undefined)).join('\n'), /permissive-only/);
  assert.match(violationsOf(withDep('MIT', false)).join('\n'), /cannot be resolved/);
});

test('production dependencies: a copyleft licence TWO levels down FAILS', () => {
  const v = violationsOf((root) => {
    setPkg(root, { dependencies: { a: '^1.0.0' } });
    write(root, 'packages/runner/node_modules/a/package.json', { name: 'a', license: 'MIT', dependencies: { b: '^1.0.0' } });
    write(root, 'packages/runner/node_modules/a/node_modules/b/package.json', { name: 'b', license: 'GPL-3.0-only' });
  });
  assert.match(v.join('\n'), /"b" is licensed "GPL-3.0-only"/);
});

test('SPDX expressions and import scanning', () => {
  assert.equal(expressionIsPermissive('MIT'), true);
  assert.equal(expressionIsPermissive('(MIT AND BSD-3-Clause)'), true);
  assert.equal(expressionIsPermissive('(MIT AND GPL-3.0-only)'), false);
  assert.equal(expressionIsPermissive(null), false);
  assert.deepEqual(importSpecifiers("import a from 'x'; import 'side'; export { b } from 'y'; const c = require('z'); await import('w');").sort(), ['side', 'w', 'x', 'y', 'z']);
});

test('the CLI exits 1 on a violation and 0 on the real package', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = join(here, 'check-runner-license-boundary.mjs');
  const ok = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const root = fixture((r) => write(r, 'packages/runner/src/leak.ts', "import { s } from '@storyos/schemas';\n"));
  try {
    const bad = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /1 violation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// keeps the unused-import linter honest about copyFileSync being available to future fixtures
void copyFileSync;
