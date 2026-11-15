import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1281 item 7 — `--bg-hover` becomes the reference's #ebe6da in LIGHT only. It is global (410 uses of `bg-hover`), so
 * the guard pins the value, the contrast the words on it need, and that dark did not move.
 */
const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
function decl(name: string, which: number) {
  const m = [...css.matchAll(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'gm'))];
  return m[which]?.[1]?.trim();
}
function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

describe('#1281 item 7 the hover token', () => {
  it('is #ebe6da in light and #1e2430 (unchanged) in dark', () => {
    expect(decl('--bg-hover', 0)).toBe('#ebe6da');
    expect(decl('--bg-hover', 1)).toBe('#1e2430');
  });

  it('keeps words readable on a hover: ink, secondary and muted all clear 4.5:1 on it', () => {
    const hover = decl('--bg-hover', 0)!;
    for (const t of ['--text-primary', '--text-secondary', '--text-muted']) {
      expect(ratio(decl(t, 0)!, hover), t).toBeGreaterThanOrEqual(4.5);
    }
    // faint is glyph-only by the repo's rule; it never reached 4.5:1 on hover, before or after
    expect(ratio(decl('--text-faint', 0)!, hover)).toBeLessThan(4.5);
  });

  it('stays distinguishable from the card and from the soft row hover it is documented against', () => {
    const hover = decl('--bg-hover', 0)!;
    expect(hover).not.toBe(decl('--bg-card', 0));
    expect(hover).not.toBe(decl('--bg-hover-soft', 0));
    expect(ratio(hover, decl('--bg-card', 0)!)).toBeGreaterThan(1.1);
  });
});
