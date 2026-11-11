import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every `var(--x)` in the web source must name a custom property that exists. An undefined variable makes the whole declaration
 * invalid at computed-value time, so a fill falls back to black (1.23:1 on a dark card: relations map, PR 1485) and a
 * `color-mix(... var(--card))` background vanishes. Nothing fails to compile, so this reads the source.
 *
 * "Exists" means: declared in globals.css OUTSIDE `@theme inline` (that block only feeds Tailwind utilities and emits no runtime
 * variable), or declared in the same file (`'--pack-hue': …` set on an element, a class that declares it), or listed in
 * DYNAMIC below with the reason. The set is the repo's, not a list of the names that bit us.
 */
const src = resolve(__dirname, '..');

/** Names that are not declared in source on purpose. Each says where it really comes from. */
const DYNAMIC: Record<string, string> = {
  '--radix-popover-content-available-height': 'set at runtime by Radix on the popover content',
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** The text of a file without block and line comments, so prose that mentions `var(--old)` is not a use. */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** Custom properties globals.css really emits: everything declared outside the `@theme inline { … }` block. */
export function runtimeVars(css: string): Set<string> {
  const at = css.indexOf('@theme inline');
  let end = at;
  if (at >= 0) {
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const outside = at >= 0 ? css.slice(0, at) + css.slice(end) : css;
  return new Set([...stripComments(outside).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
}

/** Every `var(--x)` use in `text` whose name is neither in `defined` nor declared in the text itself. */
export function undefinedVarUses(text: string, defined: ReadonlySet<string>): string[] {
  const code = stripComments(text);
  const local = new Set([...code.matchAll(/(--[\w-]+)['"`]?\s*:/g)].map((m) => m[1]!));
  const out: string[] = [];
  for (const m of code.matchAll(/var\(\s*(--[\w-]+)/g)) {
    const name = m[1]!;
    if (!defined.has(name) && !local.has(name) && !(name in DYNAMIC)) out.push(name);
  }
  return out;
}

describe('every var(--x) names a custom property that exists', () => {
  const defined = runtimeVars(readFileSync(join(src, 'app/globals.css'), 'utf8'));
  // layout.tsx also imports app/fonts/fonts.css, which declares the font variables (--font-quill, #1253): those are real too.
  for (const [, name] of readFileSync(join(src, 'app/fonts/fonts.css'), 'utf8').matchAll(/(--[\w-]+)\s*:/g)) defined.add(name);

  it('globals.css emits the real tokens, and the Tailwind-only names are not among them', () => {
    expect(defined.has('--bg-card')).toBe(true);
    expect(defined.has('--text-primary')).toBe(true);
    expect(defined.has('--text-muted')).toBe(true);
    // These only exist as `@theme inline` utility names (fill-ink, bg-card, …), never as a variable.
    for (const n of ['--ink', '--muted', '--card', '--color-ink', '--color-card']) expect(defined.has(n)).toBe(false);
  });

  it('no source file uses an undefined variable', () => {
    const files = walk(src).filter((f) => /\.(tsx?|css)$/.test(f) && !/globals\.css$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const bad = files.flatMap((f) => undefinedVarUses(readFileSync(f, 'utf8'), defined).map((n) => `${f.slice(src.length + 1)}: var(${n})`));
    expect(bad).toEqual([]);
  });

  it('flags the three names that shipped broken, and keeps a file-local declaration', () => {
    expect(undefinedVarUses('fill: var(--ink); color: var(--muted); background: var(--card)', defined)).toEqual(['--ink', '--muted', '--card']);
    expect(undefinedVarUses("style={{ '--pack-hue': 3 }} className=\"[color:var(--pack-hue)]\"", defined)).toEqual([]);
    expect(undefinedVarUses('/* var(--ink) */ // var(--card)\nconst a = 1;', defined)).toEqual([]);
  });
});
