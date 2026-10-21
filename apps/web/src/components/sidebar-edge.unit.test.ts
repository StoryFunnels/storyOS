import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1000 — the sidebar's right edge is one straight line.
 *
 * The defect: the resize line's hit area (`SidebarResizeHandle`) overlaps the panel's right edge, and at z-10 it sat
 * UNDER the sticky space headers (z-20) and the group band (z-30), so mid-drag the line was cut at every pinned header.
 * A render test cannot see it (jsdom does no paint), so the invariants that decide it are checked on the source:
 *
 *   1. the handle outranks every sticky row inside the sidebar;
 *   2. the sidebar is its own stacking context (`isolate`), so those local numbers never join the page's z-scale;
 *   3. sticky rows paint the SAME colour as the panel they sit on (bg-frame), or they read as steps in dark mode,
 *      where --bg-sidebar and --bg-frame differ.
 */
const src = readFileSync(join(__dirname, 'sidebar.tsx'), 'utf8');

function zOf(snippet: string): number {
  const m = /\bz-(\d+)\b/.exec(snippet);
  if (!m) throw new Error(`no z-index in: ${snippet}`);
  return Number(m[1]);
}

describe('the sidebar edge (#1000)', () => {
  const handleClasses = src.slice(src.indexOf("'group relative hidden shrink-0 cursor-col-resize"), src.indexOf('dragging && ', src.indexOf("'group relative hidden shrink-0 cursor-col-resize")));
  // The class strings of the sticky ROWS (they are the draggable ones), not comments that talk about them.
  const stickyClasses = [...src.matchAll(/['"]([^'"\n]*\bsticky\b[^'"\n]*\bcursor-grab\b[^'"\n]*)['"]/g)].map((m) => m[1]!);

  it('finds the sticky rows it is guarding (so the test cannot pass on an empty set)', () => {
    expect(stickyClasses.length).toBeGreaterThanOrEqual(2);
  });

  it('puts the resize handle above every sticky row in the sidebar', () => {
    const handleZ = zOf(handleClasses);
    for (const sticky of stickyClasses) expect(handleZ, sticky).toBeGreaterThan(zOf(sticky));
  });

  it('isolates the sidebar so its local z-indexes do not join the page scale', () => {
    expect(src).toMatch(/className="relative isolate flex h-full shrink-0"/);
  });

  it('paints every sticky row in the panel’s own background, not a near-miss token', () => {
    for (const sticky of stickyClasses) {
      expect(sticky, sticky).toMatch(/\bbg-frame\b/);
      expect(sticky, sticky).not.toMatch(/\bbg-sidebar\b/);
    }
    // ...and the panel those rows sit on is bg-frame.
    expect(src).toMatch(/className="flex h-full shrink-0 flex-col bg-frame"/);
  });
});
