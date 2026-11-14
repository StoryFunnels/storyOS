import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './brand-mark';

/**
 * Ticket #1302 (Otto): the StoryOS mark must stay visible in dark mode. The failure was a hard-coded navy tile on a navy-ish card, so
 * the ratios are computed from the REAL tokens in globals.css, and the SVG's own fills are read from the rendered markup.
 */
const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');
/** A token's value inside the block opened by `selector` (the first block that declares it after the selector). */
function token(selector: string, name: string): string {
  const from = css.indexOf(selector);
  expect(from, selector).toBeGreaterThan(-1);
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css.slice(from));
  expect(m, `${name} after ${selector}`).not.toBeNull();
  return m![1]!;
}
const lum = (hex: string) => {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('the StoryOS mark is visible on the auth card in both themes (#1302)', () => {
  const html = renderToStaticMarkup(createElement(BrandMark));
  it('the tile and middle bar read from theme tokens; nothing is hard-coded to a dark fill', () => {
    expect(html).toContain('fill:var(--brand-mark-tile)');
    expect(html).toContain('stroke:var(--brand-mark-stroke)');
    expect(html).not.toMatch(/fill="#0F1729"/i);
    expect(html).toContain('aria-label="StoryOS"');
  });
  for (const [theme, selector] of [
    ['light', ':root {'],
    ['dark', ":root[data-theme='dark']"],
  ] as const) {
    it(`${theme}: the mark clears 3:1 against the card (light: the navy tile; dark: the bars, since the tile is only a lifted surface)`, () => {
      const card = token(selector, '--bg-card');
      if (theme === 'light')
        expect(ratio(token(selector, '--brand-mark-tile'), card)).toBeGreaterThanOrEqual(3);
      else {
        expect(ratio('#D4A017', card)).toBeGreaterThanOrEqual(3);
        expect(ratio('#F5E4B8', card)).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${theme}: the bars read on the tile (gold >= 3:1, cream >= 3:1)`, () => {
      const tile = token(selector, '--brand-mark-tile');
      expect(ratio('#D4A017', tile)).toBeGreaterThanOrEqual(3);
      expect(ratio('#F5E4B8', tile)).toBeGreaterThanOrEqual(3);
    });
  }
  it('dark: the tile is the prototype values and its 2px stroke lifts it off the card (the fixed navy did not)', () => {
    const d = ":root[data-theme='dark']";
    expect(token(d, '--brand-mark-tile').toLowerCase()).toBe('#232b3c');
    expect(token(d, '--brand-mark-stroke').toLowerCase()).toBe('#3a4458');
    const card = token(d, '--bg-card');
    expect(ratio(token(d, '--brand-mark-stroke'), card)).toBeGreaterThan(ratio('#0F1729', card));
    expect(ratio('#0F1729', card)).toBeLessThan(1.2);
  });
});
