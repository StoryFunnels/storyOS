import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1164 / #1165 — the two TEXT tokens that sit near gold, and the rule that keeps them honest.
 *
 *  - `--warning` is a FILL / ICON colour (#b8860b is 3.25:1 on white). Warning TEXT is `--warning-text`.
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
  it.each(['--warning-text'])('%s', (token) => {
    const fg = resolve(theme, token);
    const failing = surfaces(theme)
      .map((s) => [s, ratio(fg, resolve(theme, s))] as const)
      .filter(([, r]) => r < 4.5)
      .map(([s, r]) => `${token} ${fg} on ${s} ${resolve(theme, s)} = ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});

describe('--warning-text is not gold', () => {
  it('differs in hue from --accent-text in both themes (a warning is not an agent acting)', () => {
    const hue = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
      const mx = Math.max(r, g, b);
      const d = mx - Math.min(r, g, b);
      const h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const theme of [light, dark]) {
      expect(Math.abs(hue(resolve(theme, '--accent-text')) - hue(resolve(theme, '--warning-text')))).toBeGreaterThanOrEqual(8);
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
