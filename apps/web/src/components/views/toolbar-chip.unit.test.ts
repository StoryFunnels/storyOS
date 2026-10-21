import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHIP_COUNT, TOOLBAR_BTN, chipClass } from './toolbar-chip';

const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8');

describe('toolbar chips (#992)', () => {
  it('an active chip carries the gold border and tint; an idle one does not', () => {
    expect(chipClass(true)).toMatch(/border-\[color-mix\(in_srgb,var\(--accent\)_55%/);
    expect(chipClass(true)).toMatch(/bg-\[color-mix\(in_srgb,var\(--accent\)_10%/);
    expect(chipClass(false)).not.toMatch(/--accent/);
    expect(chipClass(false)).toMatch(/border-border-default/);
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
