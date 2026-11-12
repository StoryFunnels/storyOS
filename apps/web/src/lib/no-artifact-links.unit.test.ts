import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1293: a "See an example" link once pointed at a claude.ai artifact that held real tickets and data, and shipped to
 * production. No source file may carry a claude.ai artifact URL, in code, tests or comments: a design reference is shared
 * through our own share host, built from fake data. The needle is assembled so this file does not match itself.
 */
const NEEDLE = ['claude.ai', 'artifact'].join('/');

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = [join(here, '..'), join(here, '../../../api/src')];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(dir, e.name))) : [join(dir, e.name)]));
}

/** Every file under `root` whose text holds the needle (text files only: ts, tsx, css, json, md). */
export function filesWithNeedle(root: string, needle = NEEDLE): string[] {
  return walk(root)
    .filter((f) => /\.(tsx?|css|json|md|mjs)$/.test(f))
    .filter((f) => readFileSync(f, 'utf8').includes(needle))
    .map((f) => f.slice(root.length + 1));
}

describe('no claude.ai artifact URL in shipped source', () => {
  it('apps/web/src and apps/api/src hold none, comments and tests included', () => {
    for (const root of ROOTS) {
      expect(readdirSync(root).length).toBeGreaterThan(3); // the scan really found the tree (a wrong relative path would pass vacuously)
      expect(filesWithNeedle(root)).toEqual([]);
    }
  });

  it('the scan sees a hit when there is one (not a vacuous pass)', () => {
    expect(filesWithNeedle(join(here, '..'), 'MY_WORK_EXAMPLE_URL').length).toBeGreaterThan(0);
  });
});
