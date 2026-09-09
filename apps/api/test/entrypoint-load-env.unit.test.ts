import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #658 — every standalone entrypoint (main.ts plus each `node dist/...js`
 * script in package.json) must import `config/load-env` FIRST, or
 * `apps/api/.env` is silently never read and DATABASE_URL falls back to its
 * zod default — the shared founder dev database. #316 fixed this for
 * main.ts; four other entrypoints had quietly grown the same bug since.
 *
 * Enumerated FROM package.json's scripts, not a hand-maintained list — a
 * hand-maintained list is exactly what let four entrypoints go unnoticed. A
 * fifth entrypoint added later inherits this test for free.
 */
const API_ROOT = join(__dirname, '..');

function entrypointSourceFiles(): string[] {
  const pkg = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const files = new Set<string>();
  for (const script of Object.values(pkg.scripts)) {
    const match = script.match(/node dist\/(\S+)\.js/);
    if (match) files.add(`src/${match[1]}.ts`);
  }
  files.add('src/main.ts'); // not a package.json script target, but the same hazard class
  return [...files];
}

/** First import specifier in the file, ignoring comments and blank lines. */
function firstImportSpecifier(sourcePath: string): string {
  const raw = readFileSync(join(API_ROOT, sourcePath), 'utf8');
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const match = withoutComments.match(
    /import\s+(?:['"]([^'"]+)['"]|(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"])/,
  );
  const specifier = match?.[1] ?? match?.[2];
  if (!specifier) throw new Error(`${sourcePath}: no import statement found`);
  return specifier;
}

describe('#658 every standalone entrypoint imports config/load-env first', () => {
  const files = entrypointSourceFiles();

  it('found at least the known entrypoints (package.json parsing did not silently return nothing)', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file}`, () => {
      const first = firstImportSpecifier(file);
      expect(first.endsWith('config/load-env')).toBe(true);
    });
  }
});
