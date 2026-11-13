import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POPOVER_SECTION, POPOVER_TITLE } from './popover-heading';

/**
 * #1281 item 1 — Filter, Sort and Display each drew their own heading (mono 9px, mono 10px/600, none + Figtree 11px/600).
 * This reads source, as the other view guards do: the property is "every toolbar popover title goes through the one constant".
 */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');
const toolbar = read('view-toolbar.tsx');
const display = read('display-menu.tsx');
const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');

function lum(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
/** The token's value inside the `:root` block (light) or the `.dark`/`[data-theme=dark]` block (dark): first / second declaration. */
function token(name: string, which: 0 | 1) {
  const m = [...css.matchAll(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`, 'g'))];
  return m[which]![1]!;
}

describe('#1281 one heading style across the toolbar popovers', () => {
  it('the title is mono 9px uppercase tracking 0.13em weight 400', () => {
    expect(POPOVER_TITLE).toContain('font-mono');
    expect(POPOVER_TITLE).toContain('text-[9px]');
    expect(POPOVER_TITLE).toContain('uppercase');
    expect(POPOVER_TITLE).toContain('tracking-[0.13em]');
    expect(POPOVER_TITLE).toContain('font-normal');
    expect(POPOVER_SECTION).toContain(POPOVER_TITLE);
  });

  it('Filter, Sort and Display titles all use it, and none keeps its own mono/caps heading', () => {
    expect(toolbar).toMatch(/className=\{POPOVER_TITLE\}>Filter</);
    expect(toolbar).toMatch(/className=\{POPOVER_TITLE\}>Sort by</);
    expect(display).toMatch(/className=\{POPOVER_TITLE\}>Display</);
    // the old divergent Sort heading is gone; the old Display labels are the shared section style
    expect(toolbar).not.toContain('font-mono text-micro font-semibold uppercase tracking-wider');
    expect(display).not.toContain('text-meta font-semibold uppercase tracking-wider');
  });

  it('keeps the Filter header\'s "N of M applied" readout (a different element, not a heading)', () => {
    expect(toolbar).toContain('of {buttonState.configured} applied');
  });

  it('is words, so it clears 4.5:1 on the card in both themes (faint does not)', () => {
    expect(POPOVER_TITLE).toContain('text-muted');
    expect(POPOVER_TITLE).not.toContain('text-faint');
    expect(ratio(token('--text-muted', 0), token('--bg-card', 0))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('--text-muted', 1), token('--bg-card', 1))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token('--text-faint', 0), token('--bg-card', 0))).toBeLessThan(4.5);
  });
});

describe('#1281 item 2 one radius across the toolbar popovers', () => {
  it('Filter and Sort panels use the popover radius the menus and Display already use, not the card radius', () => {
    expect(toolbar).not.toMatch(/phone-sheet[^"]*rounded-\[var\(--radius-card\)\]/);
    expect(toolbar.match(/rounded-\[var\(--radius-popover\)\] border border-border-default bg-card shadow-\[var\(--shadow-popover\)\]/g)?.length).toBe(2);
    expect(readFileSync(join(__dirname, '../ui/popover.tsx'), 'utf8')).toContain('rounded-[var(--radius-popover)]');
    expect(readFileSync(join(__dirname, '../ui/dropdown-menu.tsx'), 'utf8')).toContain('rounded-[var(--radius-popover)]');
  });
});
