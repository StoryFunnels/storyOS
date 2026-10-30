import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1160 / #1163 — a switch's KNOB is `var(--bg-card)`, never a fixed white. Light: card-white on the navy track
 * (10.90:1). Dark: a card-coloured knob on the #7a92d6 track (5.62:1); a white knob there would be ~2.7:1.
 *
 * The set of switches is derived from the SOURCE (every file that declares `role="switch"`), not listed by name
 * (CLAUDE.md "a check wrong about what it checks"). In such a file this flags any fixed-white fill and requires a
 * `bg-card` rounded-full knob.
 */
const SRC = join(__dirname, '..', '..');

export function whiteFills(text: string): string[] {
  const re = /(?:^|[\s'"`])((?:[a-z0-9_[\]-]+:)*bg-(?:white|\[#(?:fff|ffffff)\]|\[white\]|on-dark|\[var\(--text-on-dark\)\]))(?=[\s'"`/])/gi;
  return [...text.matchAll(re)].map((m) => m[1]!);
}
export function hasCardKnob(text: string): boolean {
  return /rounded-full[^'"`]*\bbg-card\b|\bbg-card\b[^'"`]*rounded-full/.test(text);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) acc.push(p);
  }
  return acc;
}

describe('the scan itself (mutation checks)', () => {
  it.each(['bg-white', 'bg-[#fff]', 'bg-[#FFFFFF]', 'dark:bg-white', 'bg-on-dark'])('flags %s', (c) => {
    expect(whiteFills(`className="h-3 w-3 rounded-full ${c}"`)).toHaveLength(1);
  });
  it('keeps bg-card and white text that is not a fill', () => {
    expect(whiteFills('className="h-3 w-3 rounded-full bg-card"')).toEqual([]);
    expect(whiteFills('className="bg-card/50 text-white"')).toEqual([]);
  });
  it('requires a rounded-full bg-card knob', () => {
    expect(hasCardKnob('className="h-4 w-4 rounded-full bg-card shadow-sm"')).toBe(true);
    expect(hasCardKnob('className="h-4 w-4 rounded-full bg-white"')).toBe(false);
  });
});

describe('every switch in the app has a card-coloured knob', () => {
  const switches = walk(SRC).filter((f) => /role="switch"/.test(readFileSync(f, 'utf8')));
  it('finds the real population (ui/switch + the two view menus)', () => {
    expect(switches.length).toBeGreaterThanOrEqual(3);
  });
  it.each(switches.map((f) => [relative(SRC, f), f] as const))('%s', (_n, f) => {
    const text = readFileSync(f, 'utf8');
    expect(whiteFills(text)).toEqual([]);
    expect(hasCardKnob(text)).toBe(true);
  });
});
