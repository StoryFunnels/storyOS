import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1160 — ONE focus ring. `--focus-ring-color` is `--primary-text`, drawn by the single `*:focus-visible` rule in
 * globals.css; no component may paint its own focus colour.
 *
 * Why this is a scan and not a list of file names (CLAUDE.md, "a check wrong about what it checks"): the previous
 * inventory of per-component gold focus styles came from one grep pattern, and a pattern is a proxy. The scan below
 * derives the set from the SOURCE: every utility class that sits behind a focus-ish variant (`focus:`, `focus-visible:`,
 * `focus-within:`, with `group-` / `peer-` prefixes and any stacked variants) and (a) names the accent/gold token in any
 * spelling, or (b) is a ring/outline utility, which is the property the global rule owns.
 *
 * What it does NOT flag, on purpose: `focus:border-border-strong` (a border change on a text field, drawn in
 * addition to the global ring) and `focus:outline-none` (inert, the unlayered global rule wins; globals.css says so).
 */

const SRC = join(__dirname, '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');

/** A class token behind a focus variant. `[^\s'"`]*` is the rest of the utility, brackets and `var(--x)` included. */
const FOCUS_UTILITY = /(?:^|[\s'"`])((?:[a-z0-9_[\]-]+:)*(?:group-|peer-)?focus(?:-visible|-within)?:(?:[a-z0-9_[\]-]+:)*[^\s'"`]+)/g;
const GOLD = /accent|gold|--c8|--warning/;
const RING_OR_OUTLINE = /^(?:[a-z0-9_[\]-]+:)*(?:group-|peer-)?focus(?:-visible|-within)?:(?:[a-z0-9_[\]-]+:)*(?:ring|outline)(?!-none$)(?:-|$)/;

/** Every offending class token in `text`, as `token`. Exported shape is tiny so the mutation tests below can drive it. */
export function forbiddenFocusUtilities(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FOCUS_UTILITY)) {
    const token = m[1]!;
    // the utility part only (after the last focus-ish variant), so `focus:` itself is never "gold"
    const utility = token.replace(/^.*?focus(?:-visible|-within)?:/, '');
    if (GOLD.test(utility) || RING_OR_OUTLINE.test(token)) out.push(token);
  }
  return out;
}

/** A CSS rule whose selector is a focus state and whose body paints the accent. */
export function forbiddenFocusCssRules(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/([^{}]*:focus(?:-visible|-within)?[^{}]*)\{([^{}]*)\}/g)) {
    if (/var\(--(?:accent|c8)\b|--accent-soft/.test(m[2]!)) out.push(m[1]!.trim());
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|css)$/.test(name) && !/\.(unit\.)?test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('the scan itself (mutation checks: it must fire on what it exists to catch)', () => {
  it.each([
    ['focus:border-[var(--accent)]'],
    ['focus:border-accent'],
    ['focus-visible:border-accent'],
    ['focus-visible:ring-[var(--accent)]'],
    ['focus-visible:ring-2'],
    ['focus-visible:outline-accent'],
    ['focus-visible:outline focus-visible:outline-2'],
    ['group-focus-visible:bg-[var(--accent)]'],
    ['md:focus-visible:ring-border-strong'],
    ['focus:bg-[var(--accent)]/50'],
    ['focus-within:ring-1'],
  ])('flags %s', (cls) => {
    expect(forbiddenFocusUtilities(`className="x ${cls} y"`).length).toBeGreaterThan(0);
  });

  it.each([
    ['focus:border-border-strong'],
    ['focus:outline-none'],
    ['group-focus-visible:bg-border-strong'],
    ['group-focus-visible:bg-[var(--focus-ring-color)]'],
    ['hover:bg-[var(--accent)]/50'],
    ['isOver && ring-1 ring-inset ring-accent/40'],
    ['checked:border-accent checked:bg-accent'],
  ])('keeps %s', (cls) => {
    expect(forbiddenFocusUtilities(`className="x ${cls} y"`)).toEqual([]);
  });

  it('flags a focus CSS rule that paints the accent, and keeps one that paints the token', () => {
    expect(forbiddenFocusCssRules('.x:focus-visible { outline: 2px solid var(--accent); }')).toHaveLength(1);
    expect(forbiddenFocusCssRules('.x:focus-visible { outline: var(--focus-ring); }')).toEqual([]);
  });
});

describe('no component or stylesheet paints its own (gold) focus', () => {
  const files = walk(SRC);
  it('scans a real population (not an empty glob)', () => {
    expect(files.length).toBeGreaterThan(300);
  });
  it('no focus-variant utility names the accent/gold token, or is a ring/outline utility', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (!/\.tsx?$/.test(f)) continue;
      for (const h of forbiddenFocusUtilities(readFileSync(f, 'utf8'))) hits.push(`${relative(SRC, f)}: ${h}`);
    }
    expect(hits).toEqual([]);
  });
  it('no :focus rule in a stylesheet paints the accent', () => {
    const hits: string[] = [];
    for (const f of files) {
      if (!f.endsWith('.css')) continue;
      for (const h of forbiddenFocusCssRules(readFileSync(f, 'utf8'))) hits.push(`${relative(SRC, f)}: ${h}`);
    }
    expect(hits).toEqual([]);
  });
});

function block(selector: string): string {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open, i);
  }
  throw new Error(`no block for ${selector}`);
}
const light = block(':root {');
const dark = block(":root[data-theme='dark']");
const hex = (b: string, name: string): string => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(b);
  if (m) return m[1]!;
  if (b !== light) return hex(light, name);
  throw new Error(`${name} not found`);
};
function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the token', () => {
  it('is --primary-text, 2px, with a 2px offset, and is not derived from the accent', () => {
    expect(css).toMatch(/--focus-ring-color:\s*var\(--primary-text\);/);
    expect(css).toMatch(/--focus-ring-width:\s*2px;/);
    expect(css).toMatch(/--focus-ring-offset:\s*2px;/);
    expect(css).not.toMatch(/--focus-ring-color:[^;]*--accent/);
  });
  it('the one rule draws it with the offset, and forced-colors names a system colour', () => {
    expect(block('*:focus-visible')).toMatch(/outline:\s*var\(--focus-ring\)/);
    expect(block('*:focus-visible')).toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/);
    expect(block('@media (forced-colors: active)')).toMatch(/--focus-ring-color:\s*Highlight/);
  });
  // The ring is read against the SURFACE across the offset gap (a filled primary button is nearly the ring's own colour),
  // so the bar is every surface token, both themes. This is the set from globals.css, not a hand-picked few.
  describe.each([
    ['light', light],
    ['dark', dark],
  ])('%s: 3:1 against every --bg-* surface', (_n, theme) => {
    const surfaces = [...css.matchAll(/^\s*(--bg-[a-z-]+):\s*#[0-9a-fA-F]{6}\b/gm)].map((m) => m[1]!);
    it('has a real surface population', () => {
      expect(new Set(surfaces).size).toBeGreaterThanOrEqual(8);
    });
    it.each([...new Set(surfaces)])('%s', (s) => {
      expect(ratio(hex(theme, '--primary-text'), hex(theme, s))).toBeGreaterThanOrEqual(3);
    });
  });
});
