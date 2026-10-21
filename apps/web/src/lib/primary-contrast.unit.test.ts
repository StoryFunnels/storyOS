import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #994 — the action colour (`--primary`) carries the label of every primary button, so its pairing with
 * `--text-on-dark` must clear WCAG AA (4.5:1) in BOTH themes, and the button must be visibly a button against the page
 * (3:1, the non-text floor). Dark `--primary` is deliberately NOT the prototype's #6d7fc0 (3.61:1 under the label); this
 * test is what keeps a later "match the prototype exactly" edit from quietly bringing that back.
 */
const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

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
// A token the dark block does not redeclare is inherited from `:root`, exactly as the browser resolves it.
const token = (b: string, name: string): string => {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(b);
  if (m) return m[1]!;
  if (b !== light) return token(light, name);
  throw new Error(`${name} not found`);
};

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each([
  ['light', light],
  ['dark', dark],
])('%s: --primary', (_name, theme) => {
  it('the label on a primary button clears AA, resting and hovered', () => {
    expect(ratio(token(theme, '--text-on-dark'), token(theme, '--primary'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(theme, '--text-on-dark'), token(theme, '--primary-hover'))).toBeGreaterThanOrEqual(4.5);
  });
  it('the button is visible against the page (3:1)', () => {
    expect(ratio(token(theme, '--primary'), token(theme, '--bg-app'))).toBeGreaterThanOrEqual(3);
  });
  it('the Undo label (--text-on-accent on gold) clears AA', () => {
    expect(ratio(token(theme, '--text-on-accent'), token(theme, '--accent'))).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Otto's ruling on #994: two tokens. `--primary` is the FILL (a button's background); `--primary-text` is TEXT and
 * GLYPHS. They differ in dark mode, where the fill is only 3.45:1 as text on a card, so `text-primary` must read the
 * text token — and nothing may colour text with the fill token directly.
 */
describe.each([
  ['light', light],
  ['dark', dark],
])('%s: --primary-text', (_name, theme) => {
  it('clears AA as text on the card and on the page', () => {
    expect(ratio(token(theme, '--primary-text'), token(theme, '--bg-card'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(theme, '--primary-text'), token(theme, '--bg-app'))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('text never resolves to the fill (#994)', () => {
  it('in dark the text token is NOT the fill token', () => {
    expect(token(dark, '--primary-text')).not.toBe(token(dark, '--primary'));
  });
  it('the dark FILL would fail as text on the card, which is why the tokens are split', () => {
    expect(ratio(token(dark, '--primary'), token(dark, '--bg-card'))).toBeLessThan(4.5);
  });
  it('the theme exposes the text token as `text-primary-text`', () => {
    expect(css).toMatch(/--color-primary-text:\s*var\(--primary-text\)/);
  });
  it('no source colours TEXT with the fill token directly', () => {
    const SRC = join(__dirname, '..');
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(name) && !/\.(unit\.)?test\.(ts|tsx)$/.test(name)) out.push(p);
      }
      return out;
    };
    // Bare `text-primary` (with or without an opacity) resolves to the FILL colour; `text-primary-text` does not match.
    const FILL_AS_TEXT = /(?<![\w-])!?text-primary(?![\w-])|text-\[var\(--(?:color-)?primary\)\]/;
    const offenders = walk(SRC)
      .filter((p) => FILL_AS_TEXT.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe('the prototype’s light navy', () => {
  it('light --primary is the prototype’s #2f3b63', () => {
    expect(token(light, '--primary').toLowerCase()).toBe('#2f3b63');
  });
});
