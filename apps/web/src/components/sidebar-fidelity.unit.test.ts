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

describe('item 3: ONE tier-label style (AI, Spaces, Favorites share it)', () => {
  const tierSrc = read('sidebar-tier-label.tsx');

  it('the shared label is mono, 9px, 0.16em tracking, caps, in the neutral muted colour', () => {
    expect(tierSrc).toMatch(/font-mono text-\[9px\] font-normal uppercase/);
    expect(tierSrc).toContain('tracking-[0.16em]');
    expect(tierSrc).toMatch(/text-muted'/);
    expect(tierSrc).not.toMatch(/text-faint/); // a label is prose; faint is the glyph colour and fails 4.5:1
  });

  it('Spaces and Favorites go through SidebarTierLabel, not a hand-rolled span/div', () => {
    expect(sidebarSrc).toMatch(/<SidebarTierLabel[^>]*>Spaces<\/SidebarTierLabel>/);
    expect(sidebarSrc).toMatch(/<SidebarTierLabel[^>]*>Favorites<\/SidebarTierLabel>/);
    expect(sidebarSrc).not.toMatch(/uppercase tracking-wider text-muted">Spaces</);
  });

  it('KEEPS the AI label gold (text-accent-text, in the agent allow-list file only) and a notch heavier', () => {
    expect(aiSrc).toMatch(/<SidebarTierLabel className="font-semibold text-accent-text">AI<\/SidebarTierLabel>/);
    expect(tierSrc).not.toMatch(/accent/); // gold must not enter the shared file (gold-agents-only)
  });
});

describe('item 4: the workspace header is 40px, name 14px/700 with -0.01em tracking', () => {
  const switcher = sidebarSrc.slice(sidebarSrc.indexOf('function WorkspaceSwitcher'), sidebarSrc.indexOf('The "Hidden" section'));

  it('the trigger is h-10 and the name is text-prose font-bold tracking-[-0.01em]', () => {
    expect(switcher).toMatch(/flex h-10 w-full items-center gap-2 border-b/);
    expect(switcher).toMatch(/text-prose font-bold tracking-\[-0\.01em\] text-ink/);
    expect(switcher).not.toMatch(/font-semibold/);
  });

  it('KEEPS the finger-sized 44px header in the phone drawer', () => {
    expect(switcher).toContain('max-md:h-11');
  });
});
