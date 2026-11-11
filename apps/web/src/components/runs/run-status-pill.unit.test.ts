import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from '@/lib/embed-theme';

/**
 * AA is the floor for the run status pills. The `wait` pill measured 4.42:1 on --bg-card (3.50 on --bg-active) in light mode.
 * Nothing fails to compile when a colour-mix drifts, so this reads the pill's own classes from source, resolves the
 * `color-mix(...)` against the tokens globals.css declares for each theme, and measures the text against the pill's 15-20%
 * wash over EVERY `--bg-*` surface (the set is the stylesheet's, so a new surface is covered the day it is declared).
 */
const SRC = join(__dirname, '..', '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
const pill = readFileSync(join(__dirname, 'run-status-pill.tsx'), 'utf8');

function block(selector: string): string {
  const open = css.indexOf('{', css.indexOf(selector));
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

function hex(theme: Record<string, string>, name: string): string {
  let v = theme[name];
  for (let i = 0; i < 5 && v?.startsWith('var('); i++) v = theme[v.slice(4, v.indexOf(')')).trim()];
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${name} is not a hex colour: ${v}`);
  return v;
}
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** `pct` of `a` over `b`. */
const mix = (a: string, b: string, pct: number) => toHex(rgb(a).map((v, i) => (v * pct) / 100 + rgb(b)[i]! * (100 - pct) / 100));

/** The `wait` entry's classes, as written in the component. */
const waitClasses = /wait:\s*'([^']+)'/.exec(pill)?.[1] ?? '';

function waitColours(theme: Record<string, string>, isDark: boolean) {
  const text = /(?:^|\s)text-\[color-mix\(in_srgb,var\((--[a-z-]+)\)_(\d+)%,var\((--[a-z-]+)\)\)\]/.exec(waitClasses);
  const wash = /(?:^|\s)bg-\[color-mix\(in_srgb,var\((--[a-z-]+)\)_(\d+)%,transparent\)\]/.exec(waitClasses);
  if (!text || !wash) throw new Error(`cannot read the wait pill classes: ${waitClasses}`);
  const fg = isDark && /(?:^|\s)dark:text-ink(?:\s|$)/.test(waitClasses) ? hex(theme, '--text-primary') : mix(hex(theme, text[1]!), hex(theme, text[3]!), Number(text[2]));
  return { fg, wash: [hex(theme, wash[1]!), Number(wash[2])] as const };
}

describe.each([
  ['light', light, false],
  ['dark', dark, true],
] as const)('wait pill, %s', (_n, theme, isDark) => {
  const surfaces = Object.keys(theme).filter((k) => /^--bg-/.test(k) && /^#[0-9a-f]{6}$/i.test(theme[k]!));
  it('finds the real surface set', () => {
    expect(surfaces).toEqual(expect.arrayContaining(['--bg-app', '--bg-sidebar', '--bg-card', '--bg-active']));
  });
  it('its text clears AA (4.5:1) on its own wash over every surface', () => {
    const { fg, wash } = waitColours(theme, isDark);
    const failing = surfaces
      .map((s) => [s, contrastRatio(fg, mix(wash[0], theme[s]!, wash[1]))] as const)
      .filter(([, r]) => r < 4.5)
      .map(([s, r]) => `${fg} on ${s} = ${r.toFixed(2)}`);
    expect(failing).toEqual([]);
  });
});
