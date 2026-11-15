import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1281 — a selected row must read differently from a hovered one.
 *
 * The reference's hover is #ebe6da and its active row #e7e0ce: only CIE76 3.9 apart, so selection was a hover with a
 * heavier font. `--bg-active` was darkened to #e1d8c0 (CIE76 8.2 from hover). This reads both tokens from globals.css
 * (not a copy) and fails if they drift back together, and checks the text that sits on the active row keeps AA.
 *
 * Dark is the reference's own pair (#1e2430 / #28303d), CIE76 5.6 and not part of this change, so its floor is 5: it
 * guards against dark getting worse, it does not claim dark meets the light bar.
 */
const css = readFileSync(join(__dirname, '..', 'app', 'globals.css'), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`no ${selector} block`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('unbalanced');
}
function props(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}
const light = props(block(':root {'));
const dark = { ...light, ...props(block(":root[data-theme='dark']")) };

const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function lab(hex: string): number[] {
  const [r, g, b] = rgb(hex).map(lin) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function cie76(a: string, b: string): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}
function ratio(a: string, b: string): number {
  const l = (h: string) => {
    const [r, g, bl] = rgb(h).map(lin) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [l(a), l(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function hex(theme: Record<string, string>, name: string): string {
  const v = theme[name];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a hex colour: ${v}`);
  return v;
}

describe('--bg-active is clearly different from --bg-hover (CIE76)', () => {
  it('light: at least 8', () => {
    expect(cie76(hex(light, '--bg-hover'), hex(light, '--bg-active'))).toBeGreaterThanOrEqual(8);
  });
  it('dark: at least 5 (the reference pair, 5.6 today)', () => {
    expect(cie76(hex(dark, '--bg-hover'), hex(dark, '--bg-active'))).toBeGreaterThanOrEqual(5);
  });
  it('the metric itself: the old pair is under the bar', () => {
    expect(cie76('#ebe6da', '#e7e0ce')).toBeLessThan(8);
  });
});

describe('text on --bg-active keeps AA', () => {
  for (const [theme, name] of [[light, 'light'], [dark, 'dark']] as const) {
    for (const t of ['--text-primary', '--text-secondary', '--text-muted']) {
      // Dark --text-muted on dark --bg-active is 4.41 today (the reference pair, untouched here): floor 4.4 so it cannot
      // get worse; the 4.5 bar is enforced where this change moved a token (light).
      const floor = name === 'dark' && t === '--text-muted' ? 4.4 : 4.5;
      it(`${name}: ${t} >= ${floor}:1`, () => {
        expect(ratio(hex(theme, t), hex(theme, '--bg-active'))).toBeGreaterThanOrEqual(floor);
      });
    }
  }
});
