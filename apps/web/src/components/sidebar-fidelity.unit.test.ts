import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1273 — shell fidelity against the prototype (measured at 1270, light). Source-level pins, in the style of the other
 * sidebar tests: the geometry lives in class strings, so the class strings are what drifts.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
const rowSrc = read('sidebar-row.tsx');
const sidebarSrc = read('sidebar.tsx');
const aiSrc = read('sidebar-ai-section.tsx');

describe('item 2: tree rows are 22px with a 12px label', () => {
  it('SidebarRow, the one place that owns row geometry, is h-[22px] with the text-label (12px) step', () => {
    expect(rowSrc).toMatch(/group relative flex h-\[22px\] items-center justify-between rounded pr-2 text-label/);
    expect(rowSrc).not.toMatch(/group relative flex h-6\b/);
    expect(rowSrc).not.toMatch(/justify-between rounded pr-2 text-body/);
  });

  it('KEEPS the finger-sized phone heights: the density change is desktop-only', () => {
    expect(rowSrc).toContain("lens ? 'max-md:h-8' : 'max-md:h-[34px]'");
  });

  it('KEEPS the space header at 24px: the prototype\'s space header is taller than a row', () => {
    expect(sidebarSrc).toMatch(/group sticky z-20 h-6 /);
  });

  it('no row link restates text-body: children inherit the row\'s size, or the two drift again', () => {
    for (const src of [aiSrc, sidebarSrc]) {
      expect(src).not.toMatch(/flex min-w-0 flex-1 items-center gap-2 text-body/);
    }
  });
});
