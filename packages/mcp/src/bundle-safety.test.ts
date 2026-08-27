import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The mcp image must still BOOT (#399 follow-up).
 *
 * `pnpm bundle` emits ESM with zod marked external, but `@storyos/schemas` is
 * built as CJS. Bundling any value out of the schemas BARREL therefore inlines
 * a `require('zod')`, which esbuild turns into a shim that throws
 * `Dynamic require of "zod" is not supported` — at boot, on the first import,
 * before a single tool runs.
 *
 * This is not hypothetical. #399 unified four copies of the colour palette and
 * pulled `PALETTE` from the barrel, three lines below a comment warning not to.
 * Every unit test passed, `pnpm build` passed, the bundle even loaded on macOS.
 * The only thing that caught it was CI booting the container: "the mcp image
 * did not serve /health within 40s — it builds but does not run".
 *
 * That feedback arrives ~8 minutes after a push and burns a queue slot, so the
 * rule gets a cheap test rather than a comment that was already there and was
 * already ignored once.
 *
 * The fix is always the same: import from a zod-free SUBPATH
 * (`@storyos/schemas/colors`, `/markdown`, `/icons`, `/system-fields`), or use
 * `import type`, which is erased and pulls in nothing.
 */
const SRC = join(import.meta.dirname, '.');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('mcp bundle safety', () => {
  it('never imports a VALUE from the zod-bearing @storyos/schemas barrel', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      // `import ... from '@storyos/schemas'` with no `type` keyword. Subpaths
      // are fine, so the quote must close immediately after the package name.
      const re = /^import\s+(?!type\s)([^;]*?)\s+from\s+['"]@storyos\/schemas['"]/gm;
      for (const m of text.matchAll(re)) offenders.push(`${file.slice(SRC.length + 1)}: import ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('does not accidentally cover zero files', () => {
    // A guard whose glob silently stopped matching would pass forever.
    expect(sources(SRC).length).toBeGreaterThan(5);
  });
});
