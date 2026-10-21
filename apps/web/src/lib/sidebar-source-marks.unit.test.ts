import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceMarks, type SourceMarkDatabase } from './sidebar-source-marks';

const db = (id: string): SourceMarkDatabase => ({ id, name: `DB ${id}` });
const all = new Map(['a', 'b', 'c', 'd', 'e'].map((id) => [id, db(id)]));

describe('sourceMarks (#1013): the first two glyphs, then +N', () => {
  it('draws none for a single-source or empty view: colour already says where it came from', () => {
    expect(sourceMarks(undefined, all)).toBeNull();
    expect(sourceMarks([], all)).toBeNull();
    expect(sourceMarks(['a'], all)).toBeNull();
    expect(sourceMarks(['a', 'a'], all)).toBeNull(); // the same database twice is still one source
  });

  it('two sources show two marks and no "+N"', () => {
    const m = sourceMarks(['a', 'b'], all)!;
    expect(m.shown.map((d) => d.id)).toEqual(['a', 'b']);
    expect(m.more).toBe(0);
  });

  it('five sources show the first two and "+3", in the API’s order', () => {
    const m = sourceMarks(['c', 'a', 'e', 'b', 'd'], all)!;
    expect(m.shown.map((d) => d.id)).toEqual(['c', 'a']);
    expect(m.more).toBe(3);
  });

  // The count must never understate how many databases a view reads.
  it('an id the workspace list does not hold is skipped for drawing but still counted', () => {
    const m = sourceMarks(['ghost', 'a', 'b'], all)!;
    expect(m.shown.map((d) => d.id)).toEqual(['a', 'b']);
    expect(m.more).toBe(1);
  });
});

describe('the sidebar view row draws them (#1013)', () => {
  const row = readFileSync(fileURLToPath(new URL('../components/sidebar-view-row.tsx', import.meta.url)), 'utf8');
  it('reads source_database_ids from the row payload and renders sourceMarks', () => {
    expect(row).toMatch(/source_database_ids\?: string\[\]/);
    expect(row).toMatch(/sourceMarks\(\s*view\.source_database_ids/);
    expect(row).toMatch(/data-testid="source-marks"/);
  });
});
