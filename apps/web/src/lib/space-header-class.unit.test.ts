import { describe, expect, it } from 'vitest';
import { spaceHeaderClass } from './space-header-class';

/** Ticket #1346 (send-back) — the header must stay positioned while a space is dragged, or the drop line anchors to the sidebar column. */
const BASE = 'group sticky z-20 h-6 cursor-grab touch-manipulation bg-frame active:cursor-grabbing';
const cls = (over: Partial<Parameters<typeof spaceHeaderClass>[1]> = {}) => spaceHeaderClass(BASE, { dragging: false, flash: false, isDragging: false, ...over }).split(/\s+/);
// A row is a containing block for an absolutely placed child only when it is positioned.
const positioned = (c: string[]) => c.includes('relative') || c.includes('sticky') || c.includes('absolute') || c.includes('fixed');

describe('#1346 spaceHeaderClass', () => {
  it('at rest the header is pinned (sticky), unchanged', () => {
    const c = cls();
    expect(c).toContain('sticky');
    expect(c).toContain('bg-frame');
    expect(c).not.toContain('relative');
  });

  it('while a space is dragged it is unpinned but STILL positioned, so the drop line anchors to it, never to the sidebar', () => {
    for (const isDragging of [false, true]) {
      const c = cls({ dragging: true, isDragging });
      expect(c, 'not pinned').not.toContain('sticky');
      expect(positioned(c), `positioned (isDragging=${isDragging})`).toBe(true);
      expect(c, 'a static row would hand the line to its ancestor').not.toContain('static');
    }
  });

  it('the landing flash swaps the panel colour for the hover tint, and only then', () => {
    expect(cls({ flash: true })).toContain('bg-hover');
    expect(cls({ flash: true })).not.toContain('bg-frame');
    expect(cls()).not.toContain('bg-hover');
  });

  it('the dragged space is the dimmed vacated slot; others are not', () => {
    expect(cls({ dragging: true, isDragging: true })).toContain('opacity-40');
    expect(cls({ dragging: true, isDragging: false })).not.toContain('opacity-40');
  });
});
