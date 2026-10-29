import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1164 / #1165 — the two TEXT tokens that sit near gold, and the rule that keeps them honest.
 *
 *  - `--warning` is a FILL / ICON colour (the old #b8860b was 3.25:1 on white and gold-hued). Warning TEXT is `--warning-text`.
 *  - `--accent-text` is agent-gold TEXT; it must clear 4.5:1 on every surface, including `--bg-active` (selected rows).
 *
 * Both are measured against EVERY background token the stylesheet declares for that theme (the `--bg-*` set plus
 * `--accent-soft`, read from globals.css), not against a hand-picked list of surfaces: a new `--bg-foo` is covered the
 * day it is declared. (CLAUDE.md "a check wrong about what it checks".)
 */
const SRC = join(__dirname, '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');

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
  const body = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

const light = props(block(':root {'));
const dark = { ...light, ...props(block(":root[data-theme='dark']")) };

function resolve(theme: Record<string, string>, name: string): string {
  let v = theme[name];
  for (let i = 0; i < 5 && v && v.startsWith('var('); i++) v = theme[v.slice(4, v.indexOf(')')).trim()];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} did not resolve to a hex colour: ${v}`);
  return v;
}

function lum(hex: string): number {
  const ch = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2);
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Every opaque background token of a theme: `--bg-*` and `--accent-soft`. */
function surfaces(theme: Record<string, string>): string[] {
  return Object.keys(theme).filter((k) => /^--bg-/.test(k) || k === '--accent-soft');
}

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('text tokens clear 4.5:1 on every %s background token', (_name, theme) => {
  it('finds the real surface set', () => {
    expect(surfaces(theme)).toEqual(expect.arrayContaining(['--bg-app', '--bg-sidebar', '--bg-card', '--bg-hover', '--bg-active', '--accent-soft']));
  });
  it.each(['--warning-text', '--accent-text'])('%s', (token) => {
    const fg = resolve(theme, token);
    const failing = surfaces(theme)
      .map((s) => [s, ratio(fg, resolve(theme, s))] as const)
      .filter(([, r]) => r < 4.5)
      .map(([s, r]) => `${token} ${fg} on ${s} ${resolve(theme, s)} = ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

describe('--warning fills and icons clear the 3:1 non-text bar on every background token', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s', (_n, theme) => {
    const fg = resolve(theme, '--warning');
    const failing = surfaces(theme)
      .map((s) => [s, ratio(fg, resolve(theme, s))] as const)
      .filter(([, r]) => r < 3)
      .map(([s, r]) => `--warning ${fg} on ${s} = ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

/** The pills `bg-warning/10 text-warning-text` (members, admin, packs/submit): the text sits on a 10% warning tint of the surface. */
describe('warning-text on its own 10% tint clears 4.5:1 on every background token', () => {
  const blend = (fg: string, bg: string, a: number) =>
    '#' + [0, 1, 2].map((i) => Math.round(parseInt(fg.slice(1 + i * 2, 3 + i * 2), 16) * a + parseInt(bg.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a)).toString(16).padStart(2, '0')).join('');
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s', (_n, theme) => {
    const failing = surfaces(theme)
      .map((s) => [s, ratio(resolve(theme, '--warning-text'), blend(resolve(theme, '--warning'), resolve(theme, s), 0.1))] as const)
      .filter(([, r]) => r < 4.5)
      .map(([s, r]) => `${s} ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

/** CIEDE2000 between two hex colours (Sharma et al.). */
export function deltaE2000(h1: string, h2: string): number {
  const lab = (hex: string) => {
    const f = (i: number) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const [R, G, B] = [f(0), f(1), f(2)];
    const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
    const Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
    const g = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
    return [116 * g(Y) - 16, 500 * (g(X) - g(Y)), 200 * (g(Y) - g(Z))] as const;
  };
  const [L1, a1, b1] = lab(h1);
  const [L2, a2, b2] = lab(h2);
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1);
  const C2 = Math.hypot(a2p, b2);
  const hh = (a: number, b: number) => ((Math.atan2(b, a) / rad) + 360) % 360;
  const ha = hh(a1p, b1);
  const hb2 = hh(a2p, b2);
  let dh = hb2 - ha;
  if (Math.abs(dh) > 180) dh -= Math.sign(dh) * 360;
  const dL = L2 - L1;
  const dC = C2 - C1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2;
  const Cp = (C1 + C2) / 2;
  let hm = (ha + hb2) / 2;
  if (Math.abs(ha - hb2) > 180) hm += 180;
  hm %= 360;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cp;
  const SH = 1 + 0.015 * Cp * T;
  const RT = -2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

describe('warning text is neither agent gold nor error red (Dara: every pair at least 13.5 CIEDE2000)', () => {
  it('measures the metric itself (black vs white is 100)', () => {
    expect(deltaE2000('#000000', '#ffffff')).toBeGreaterThan(99);
    expect(deltaE2000('#336699', '#336699')).toBe(0);
  });
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s: --warning-text is >= 13 from --accent-text and from --error; the old pair (~10) would fail', (_n, theme) => {
    const w = resolve(theme, '--warning-text');
    expect(deltaE2000(w, resolve(theme, '--accent-text'))).toBeGreaterThanOrEqual(13);
    expect(deltaE2000(w, resolve(theme, '--error'))).toBeGreaterThanOrEqual(13);
  });
  it('--warning (fills) is >= 13 from the gold fill and from --error', () => {
    for (const theme of [light, dark]) {
      expect(deltaE2000(resolve(theme, '--warning'), resolve(theme, '--accent'))).toBeGreaterThanOrEqual(13);
      expect(deltaE2000(resolve(theme, '--warning'), resolve(theme, '--error'))).toBeGreaterThanOrEqual(13);
    }
  });
});

/** ---- the usage rule: `--warning` is never a TEXT colour; text uses `--warning-text` ---- */

/** Utility / var() forms that paint TEXT with `--warning`: `text-warning`, `text-warning/80`, `text-[var(--warning…)]`, `color: var(--warning)`. */
const WARNING_AS_TEXT = /(?:^|[\s'"`!:])(?:[a-z-]+:)*text-warning(?![\w-])|text-\[(?:color:)?var\(--warning(?![\w-])|(?<![\w-])color\s*:\s*var\(--warning(?![\w-])/;

/** The names a file imports from lucide-react: a component line `<AlertTriangle className="… text-warning" />` is an ICON. */
function lucideNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'lucide-react'/g)) {
    for (const n of m[1]!.split(',')) names.add(n.trim().split(/\s+as\s+/).pop()!);
  }
  return names;
}

export function warningTextUses(text: string): string[] {
  const icons = lucideNames(text);
  const out: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line) || !WARNING_AS_TEXT.test(line)) return;
    const comp = /<([A-Z]\w*)\s[^>]*text-warning/.exec(line)?.[1];
    if (comp && icons.has(comp)) return; // an icon keeps --warning
    out.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(name) && !/\.(unit\.)?test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('the scan itself (mutation checks)', () => {
  it.each([
    '<span className="text-warning">x</span>',
    '<p className="mt-1 text-label text-warning">x</p>',
    '<p className="hover:text-warning">x</p>',
    '<p className="text-warning/80">x</p>',
    "cond && 'text-warning'",
    '<i className="text-[var(--warning)]" />',
    '<i className="text-[var(--warning,#92400e)]" />',
    '.x { color: var(--warning); }',
  ])('flags %s', (line) => {
    expect(warningTextUses(line)).toHaveLength(1);
  });
  it.each([
    '<span className="text-warning-text">x</span>',
    '<span className="bg-warning/10 text-warning-text">x</span>',
    "import { AlertTriangle } from 'lucide-react';\n<AlertTriangle className=\"h-4 w-4 text-warning\" />",
    '<div className="border-warning bg-warning/10" />',
    "'--warning-border': 'var(--warning)',",
    '  // text-warning is the old class',
  ])('keeps %s', (src) => {
    expect(warningTextUses(src)).toEqual([]);
  });
  it('an icon is only an icon when the component really comes from lucide-react', () => {
    expect(warningTextUses('<AlertTriangle className="text-warning" />')).toHaveLength(1);
  });
});

describe('no component paints text with --warning', () => {
  const files = walk(SRC);
  it('scans a real population', () => {
    expect(files.length).toBeGreaterThan(300);
  });
  it('every text use of --warning is --warning-text (fills and icons keep --warning)', () => {
    const hits: string[] = [];
    for (const f of files) for (const h of warningTextUses(readFileSync(f, 'utf8'))) hits.push(`${relative(SRC, f)}:${h}`);
    expect(hits).toEqual([]);
  });
});
