import { describe, expect, it } from 'vitest';
import { Virtualizer, elementScroll } from '@tanstack/react-virtual';

/**
 * #1230 — switching Display > Row height left the row pitch at the old value.
 * The table feeds `estimateSize: () => rowHeight` to TanStack Virtual, which
 * caches sizes and only re-reads them on `measure()`; table-view.tsx calls
 * `measure()` from an effect keyed on `rowHeight`. This drives the same
 * virtualizer headlessly (the repo has no DOM test env) to pin both halves:
 * the cache really is stale without it, and `measure()` fixes the pitch.
 */
function makeVirtualizer(rowHeight: number, count = 50) {
  const scrollElement = {} as unknown as HTMLDivElement;
  const options = (h: number) => ({
    count,
    getScrollElement: () => scrollElement,
    estimateSize: () => h,
    overscan: 20,
    scrollToFn: elementScroll,
    observeElementRect: (_i: unknown, cb: (r: { width: number; height: number }) => void) => {
      cb({ width: 800, height: 400 });
      return () => {};
    },
    observeElementOffset: (_i: unknown, cb: (o: number, scrolling: boolean) => void) => {
      cb(0, false);
      return () => {};
    },
  });
  const v = new Virtualizer<HTMLDivElement, Element>(options(rowHeight));
  v._didMount();
  v._willUpdate();
  return { v, setHeight: (h: number) => v.setOptions({ ...v.options, ...options(h) }) };
}

const pitch = (v: Virtualizer<HTMLDivElement, Element>) => {
  const [a, b] = v.getVirtualItems();
  return b!.start - a!.start;
};

describe('row height change re-measures the virtualizer (#1230)', () => {
  it('premise: without measure(), the pitch stays at the old height', () => {
    const { v, setHeight } = makeVirtualizer(40);
    expect(pitch(v)).toBe(40);
    setHeight(28);
    expect(pitch(v)).toBe(40); // the bug: new estimate ignored
  });

  it.each([
    [40, 28],
    [28, 40],
    [32, 28],
    [28, 32],
    [40, 32],
  ])('pitch follows %i -> %i after measure(), with no gaps or overlaps', (from, to) => {
    const { v, setHeight } = makeVirtualizer(from);
    expect(pitch(v)).toBe(from);
    setHeight(to);
    v.measure();
    expect(pitch(v)).toBe(to);
    const items = v.getVirtualItems();
    items.forEach((it, i) => {
      expect(it.size).toBe(to);
      expect(it.start).toBe(it.index * to);
      if (i > 0) expect(it.start).toBe(items[i - 1]!.end);
    });
    expect(v.getTotalSize()).toBe(50 * to);
  });
});
