import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PHONE_TAP } from '@/components/sidebar-row-style';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sidebar = read('./sidebar.tsx');
const drag = read('./ui/drag-presentation.tsx');
const css = read('../app/globals.css');
const layout = read('../app/w/[ws]/layout.tsx');
const fab = read('./quick-add-fab.tsx');

describe('the phone drawer scrolls and is tappable (#1065)', () => {
  it('no draggable sidebar row carries touch-none: it stopped the browser scrolling wherever a finger landed on a row', () => {
    // 49 of ~60 controls in a real workspace's drawer were `touch-action: none`, so a swipe over a row never scrolled.
    // The only touch-none left is the desktop-only resize handle (`hidden ... md:block`).
    const offenders = sidebar.split('\n').filter((l) => /\btouch-none\b/.test(l) && !/md:block/.test(l));
    expect(offenders).toEqual([]);
    expect(sidebar).toContain('touch-manipulation');
  });

  it("the sidebar's lists use the touch-safe sensors: a mouse drags at 5px, a finger only after a 250ms hold", () => {
    expect(sidebar).not.toMatch(/useSortableSensors\(\)/);
    expect((sidebar.match(/useSidebarSortableSensors\(\)/g) ?? []).length).toBe(2);
    const hook = drag.slice(drag.indexOf('export function useSidebarSortableSensors'));
    expect(hook).toMatch(/useSensor\(MouseSensor, \{ activationConstraint: \{ distance: 5 \} \}\)/);
    expect(hook).toMatch(/useSensor\(TouchSensor, \{ activationConstraint: \{ delay: 250, tolerance: 8 \} \}\)/);
    expect(hook, 'keyboard reordering must survive (#814)').toContain('KeyboardSensor');
    // A PointerSensor would fire for a touch pointer as well and put the drag back on the first 5px of any swipe.
    expect(hook).not.toContain('PointerSensor');
  });

  it('a phone row is 44px and its link is stretched to the row, so the name is tappable across the whole height', () => {
    const block = css.slice(css.indexOf('#1065 — the phone drawer'));
    expect(block).toContain('@media (max-width: 767.98px)');
    expect(block).toMatch(/\[data-mobile-drawer\] \[data-sidebar-row\] \{[^}]*height: 44px;[^}]*min-height: 44px/);
    expect(block).toMatch(/\[data-sidebar-row\] > a,\s*\[data-mobile-drawer\] \[data-sidebar-row\] > button \{\s*align-self: stretch/);
    expect(layout).toContain('data-mobile-drawer=""');
  });

  it('action icons are 44px boxes on a phone (the glyph stays small)', () => {
    expect(PHONE_TAP).toContain('max-md:h-11');
    expect(PHONE_TAP).toContain('max-md:w-11');
  });

  it('the other drawer controls reach 44px: search, close, switch workspace, From template, New space', () => {
    expect(sidebar).toMatch(/hover:border-border-strong max-md:min-h-11/); // search
    expect(sidebar).toMatch(/max-md:min-w-11 max-md:justify-center md:hidden/); // close
    expect(sidebar).toMatch(/hover:opacity-90 max-md:h-11 max-md:w-11/); // switch workspace
    expect(sidebar.match(/hover:bg-hover max-md:min-h-11/g)?.length).toBe(2); // From template, New space
  });

  it('the Quick add button sits UNDER the drawer scrim, so a tap meant to dismiss the drawer does not open Quick add', () => {
    expect(fab).toContain('z-[var(--z-sticky)]');
    expect(fab).not.toMatch(/className="[^"]*\bz-20\b/);
  });
});
