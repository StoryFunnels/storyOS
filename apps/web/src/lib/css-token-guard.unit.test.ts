import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1168 — `var(--x, #fff)` with `--x` declared nowhere renders the fallback in EVERY theme and nothing fails: the
 * Tyron buttons wore white on gold (2.38:1 / 2.03:1) that way. A fallback hides a missing declaration, so a use that
 * carries a fallback must name a token globals.css declares. (Plain `var(--x)` with no fallback is not scanned here: an
 * undeclared one renders visibly unset.)
 */
const srcRoot = join(__dirname, '..');
const css = readFileSync(join(srcRoot, 'app', 'globals.css'), 'utf8');

function declaredTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/(--[a-zA-Z0-9_-]+)['"]?\s*:/g)].map((m) => m[1]!));
}

/** `var(--name,` occurrences, i.e. uses WITH a fallback. */
function fallbackUses(source: string): string[] {
  return [...source.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*,/g)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Found by this guard on its first run (#1168 fixed ONLY --on-accent). Each is a real undeclared token whose fallback is
 * what actually renders. They are listed so the guard can be green while they are fixed, and the list may only SHRINK:
 * an entry that stops being a violation fails the test below, which forces its removal.
 */
const KNOWN_UNDECLARED = new Set([
  'app/w/[ws]/settings/account/page.tsx: --radius-pill', // the 9999px fallback is the intent; declare it
  'components/pack-install-dialog.tsx: --warning-soft', // #fef3c7 renders in both themes (a light pastel in dark mode)
]);

describe('var(--token, fallback) must name a declared token', () => {
  const files = walk(srcRoot);
  // "Declared" = in globals.css, or set anywhere in src (a component may set a custom property inline, e.g. --block-w).
  const declared = declaredTokens(css);
  for (const f of files) for (const t of declaredTokens(readFileSync(f, 'utf8'))) declared.add(t);
  const bad: string[] = [];
  let uses = 0;
  for (const f of files) {
    for (const name of fallbackUses(readFileSync(f, 'utf8'))) {
      uses++;
      if (!declared.has(name)) bad.push(`${f.slice(srcRoot.length + 1)}: ${name}`);
    }
  }

  it('scans a real population (a scan that matches nothing proves nothing)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(uses).toBeGreaterThan(5);
  });

  it('no NEW fallback hides an undeclared token', () => {
    expect(bad.filter((b) => !KNOWN_UNDECLARED.has(b))).toEqual([]);
  });

  it('the known-undeclared list has no stale entries', () => {
    expect([...KNOWN_UNDECLARED].filter((k) => !bad.includes(k))).toEqual([]);
  });

  it('the scanner itself flags an undeclared token and passes a declared one', () => {
    const d = declaredTokens(':root { --a: #fff; }');
    expect(fallbackUses('color: var(--a, #000); x: var(--on-accent,#fff)').filter((n) => !d.has(n))).toEqual([
      '--on-accent',
    ]);
  });
});

describe('text-on-fill tokens clear AA (4.5:1) in both themes', () => {
  const block = (selector: string): string => {
    const open = css.indexOf('{', css.indexOf(selector));
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      if (css[i] === '}' && --depth === 0) return css.slice(open, i);
    }
    throw new Error(`no block for ${selector}`);
  };
  const light = block(':root {');
  const dark = block(":root[data-theme='dark']");
  const token = (b: string, name: string): string => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b);
    if (m) return m[1]!;
    if (b !== light) return token(light, name);
    throw new Error(`${name} not found`);
  };
  const lum = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: string, b: string): number => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  describe.each([
    ['light', light],
    ['dark', dark],
  ])('%s', (_n, theme) => {
    it('--text-on-accent on --accent (gold)', () => {
      expect(ratio(token(theme, '--text-on-accent'), token(theme, '--accent'))).toBeGreaterThanOrEqual(4.5);
    });
    it('--text-on-error on --error', () => {
      expect(ratio(token(theme, '--text-on-error'), token(theme, '--error'))).toBeGreaterThanOrEqual(4.5);
    });
  });
});
