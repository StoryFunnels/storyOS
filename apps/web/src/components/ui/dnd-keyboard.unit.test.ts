import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #815 — every drag-to-reorder surface must be operable from the keyboard.
 *
 * `useSortableSensors()` (components/ui/drag-presentation.tsx) is pointer + keyboard. A `<DndContext>` that builds its own
 * `useSensors(useSensor(PointerSensor…))` can be reordered by mouse and by nothing else (the handle takes focus, then
 * Space/arrows do nothing), and nothing fails to compile. So this reads the source: every file that mounts a DndContext
 * either uses the shared hook or is on the EXCLUDED list below WITH its reason. A new surface cannot be added silently.
 *
 * The exclusions are the genuinely two-dimensional ones: `sortableKeyboardCoordinates` assumes a one-dimensional list
 * (arrow keys step to the previous/next item), and writing a coordinate getter for a grid, a calendar or a time axis was
 * ruled out of scope for #815.
 */
const SRC = join(__dirname, '..', '..');

const EXCLUDED: Record<string, string> = {
  'components/views/board-view.tsx':
    '2D: a card moves between COLUMNS as well as within one (droppable columns + sortable cards); one arrow axis cannot address both.',
  'components/views/calendar-view.tsx':
    '2D: records drop onto day cells of a month grid; the target is a date, not a neighbour in a list.',
  'components/views/calendar-time-grid.tsx':
    'continuous 2D: an event drags across day columns AND a time axis; the target is a (day, time) coordinate.',
  'components/views/dashboard-view.tsx':
    '2D: blocks are laid out with rectSortingStrategy in a grid whose rows reflow; "next item" is not an arrow direction.',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' || name === '.next' ? [] : sourceFiles(p);
    return /\.tsx$/.test(name) ? [p] : [];
  });
}

const withDnd = sourceFiles(SRC)
  .map((p) => ({ rel: relative(SRC, p).split('\\').join('/'), text: readFileSync(p, 'utf8') }))
  // The shared module mentions `<DndContext>` in prose only.
  .filter((f) => f.rel !== 'components/ui/drag-presentation.tsx' && /<DndContext[\s>]/.test(f.text));

describe('keyboard-operable sortable lists (#815)', () => {
  it('finds the DndContext surfaces (so the guard cannot pass by finding none)', () => {
    expect(withDnd.length).toBeGreaterThanOrEqual(14);
  });

  it('every DndContext uses useSortableSensors(), or is a documented 2D exclusion', () => {
    const offenders = withDnd
      .filter((f) => !EXCLUDED[f.rel] && !/useSortableSensors\(\)/.test(f.text))
      .map((f) => f.rel);
    expect(offenders, 'these mount a DndContext with pointer-only sensors: use useSortableSensors() or add a reasoned exclusion').toEqual([]);
  });

  it('an excluded file is still a DndContext surface and does not also use the shared hook (no stale exclusions)', () => {
    const present = new Map(withDnd.map((f) => [f.rel, f.text]));
    for (const [rel, reason] of Object.entries(EXCLUDED)) {
      expect(present.has(rel), `${rel} is excluded but no longer mounts a DndContext: remove the exclusion`).toBe(true);
      expect(/useSortableSensors\(\)/.test(present.get(rel)!), `${rel} now uses useSortableSensors(): remove the exclusion`).toBe(false);
      expect(reason.length, `${rel} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('no non-excluded surface builds its own PointerSensor-only sensors', () => {
    const bad = withDnd.filter((f) => !EXCLUDED[f.rel] && /useSensors\(\s*useSensor\(PointerSensor/.test(f.text)).map((f) => f.rel);
    expect(bad).toEqual([]);
  });
});
