import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Semantic colour utilities must name a token that EXISTS.
 *
 * Found while converting DatabaseRow onto the shared sidebar menu (#389): the
 * "Delete database" item rendered in ordinary ink rather than red. `text-danger`
 * had never resolved — Tailwind v4 generates utilities from the `--color-*`
 * custom properties in globals.css, and there is a `--color-error` but no
 * `--color-danger`. A class naming a token that does not exist produces no rule
 * and no warning; it silently does nothing.
 *
 * It had been wrong in five files, including:
 *  - #383's shared row menu — every danger item since it shipped;
 *  - Tyron's "Yes, do it" confirmation, which #358 deliberately gave the danger
 *    colour so the SAFE action is the easy one — it had no background at all;
 *  - #388's dashboard target tones, so a tile over its limit rendered grey
 *    instead of red, defeating the point of the feature.
 *
 * None of it was caught by typecheck, lint, or any test, because a bad Tailwind
 * class is valid TypeScript and valid CSS-in-className. Hence this.
 */

const WEB_SRC = join(import.meta.dirname, '..');
const GLOBALS = join(WEB_SRC, 'app', 'globals.css');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.isFile() && (p.endsWith('.tsx') || p.endsWith('.ts')) && !p.includes('.test.') ? [p] : [];
  });
}

/** The colour names Tailwind can actually generate utilities for. */
function definedColorTokens(): Set<string> {
  const css = readFileSync(GLOBALS, 'utf8');
  return new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

const SEMANTIC = /\b(?:text|bg|border|ring|fill|stroke|from|to|via)-(success|error|warning|info|danger|caution|positive|negative)\b/g;

describe('semantic colour utilities', () => {
  const defined = definedColorTokens();

  it('globals.css defines the tokens this test relies on', () => {
    // Guards the guard: if the token naming scheme changes, this fails loudly
    // rather than the check quietly passing everything.
    expect(defined.has('error')).toBe(true);
    expect(defined.has('success')).toBe(true);
  });

  it('every semantic colour class in the app names a DEFINED token', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(SEMANTIC)) {
        if (!defined.has(m[1]!)) {
          offenders.push(`${file.replace(WEB_SRC, 'src')}: ${m[0]}`);
        }
      }
    }
    expect(
      offenders,
      `These classes name a colour token that globals.css does not define, so they\n` +
        `render nothing at all — silently, with no build warning:\n` +
        `${offenders.map((o) => `  ${o}`).join('\n')}\n\n` +
        `Defined tokens: ${[...defined].sort().join(', ')}\n`,
    ).toEqual([]);
  });
});
