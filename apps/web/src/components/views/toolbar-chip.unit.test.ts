import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHIP_COUNT, TOOLBAR_BTN, chipClass } from './toolbar-chip';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('toolbar chips (#992)', () => {
  // Ticket #1275 item 6 (Otto 2026-11-13; #1163 wins): an applied chip is neither gold nor the beige selection fill. It keeps the
  // default button background and takes a darker ink border; the count badge is the other half of the signal.
  it('an applied chip keeps the default fill and takes a darker ink border: never gold, never the beige selection fill', () => {
    const on = chipClass(true);
    const off = chipClass(false);
    expect(on).toMatch(/\bborder-ink-secondary\b/);
    expect(on).toMatch(/\bbg-card\b/); // the default button background, the same as an idle chip
    expect(on).not.toMatch(/bg-active|bg-hover|bg-primary|accent|gold|warning/);
    expect(on).not.toMatch(/border-border-(?:strong|default)/);
    // KEPT: an idle chip is exactly as before, and an applied one differs from it by its border alone.
    expect(off).toMatch(/border-border-default/);
    expect(off).toMatch(/\bbg-card\b/);
    expect(off).not.toMatch(/accent|bg-active|border-ink/);
  });

  it('the applied border, the label and the count clear 4.5:1 in light and dark', () => {
    const css = read('../../app/globals.css');
    const block = (sel: RegExp) => css.match(sel)![0];
    const light = block(/:root\s*\{[\s\S]*?\n\}/);
    const dark = block(/\.theme-dark-scope\s*\{[\s\S]*?\n\}/);
    const tok = (b: string, name: string) => b.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!;
    const lum = (hex: string) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    for (const [theme, b] of [['light', light], ['dark', dark]] as const) {
      const card = tok(b, 'bg-card');
      expect(ratio(tok(b, 'text-secondary'), card), `${theme} border (--text-secondary) on the card`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok(b, 'text-primary'), card), `${theme} label on the card`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tok(b, 'text-primary'), tok(b, 'border-default')), `${theme} count badge`).toBeGreaterThanOrEqual(4.5);
    }
    // and the class really draws those tokens
    expect(css).toMatch(/--color-ink-secondary:\s*var\(--text-secondary\)/);
    expect(CHIP_COUNT).toMatch(/bg-border-default[\s\S]*text-ink/);
  });

  it('every chip is 26px tall and the right-hand buttons 27px (the prototype’s .chip / .btn)', () => {
    expect(chipClass()).toMatch(/\bh-\[26px\]/);
    expect(TOOLBAR_BTN).toMatch(/\bh-\[27px\]/);
    expect(CHIP_COUNT).toMatch(/\bh-4 min-w-4\b/);
  });

  // The defect this prevents: each control re-drawing "a toolbar chip" with its own classes, and the copies drifting.
  it('Filter, Sort, Group, Find and Display draw their trigger from the shared classes', () => {
    expect(read('./view-toolbar.tsx')).toMatch(/className=\{chipClass\(buttonState\.yellow\)\}/);
    expect(read('./view-toolbar.tsx')).toMatch(/className=\{chipClass\(sorts\.length > 0\)\}/);
    expect(read('./group-chip.tsx')).toMatch(/className=\{chipClass\(Boolean\(groupField\)\)\}/);
    expect(read('./view-search-box.tsx')).toMatch(/className=\{chipClass\(\)\}/);
    expect(read('./view-search-box.tsx')).toMatch(/className=\{FIND_BOX\}/);
    expect(read('./display-menu.tsx')).toMatch(/className=\{TOOLBAR_BTN\}/);
  });
});
