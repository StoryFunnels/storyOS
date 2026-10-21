import { readFileSync } from 'node:fs';
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

describe('the prototype’s light navy', () => {
  it('light --primary is the prototype’s #2f3b63', () => {
    expect(token(light, '--primary').toLowerCase()).toBe('#2f3b63');
  });
});
