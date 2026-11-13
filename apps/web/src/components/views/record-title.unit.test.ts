import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_TITLE_WEIGHT } from '@/lib/record-title';

const code = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

// The five surfaces that draw a record's title as the row's subject (ticket #1275 item 1).
const SURFACES: Array<[string, string]> = [
  ['board card', 'components/views/board-view.tsx'],
  ['table title cell', 'components/table-view/cells.tsx'],
  ['calendar month/week/agenda event', 'components/views/calendar-view.tsx'],
  ['calendar time grid event', 'components/views/calendar-time-grid.tsx'],
  ['list row', 'components/views/list-view.tsx'],
];

describe('one weight for a record title (#1275 item 1)', () => {
  it('is 550, the design weight', () => {
    expect(RECORD_TITLE_WEIGHT).toBe('font-[550]');
  });
  it.each(SURFACES)('%s draws its title from the shared constant', (_n, rel) => {
    expect(code(rel)).toContain('RECORD_TITLE_WEIGHT');
  });
  it('no surface keeps its own weight on a {row.title} line', () => {
    for (const [, rel] of SURFACES) {
      for (const line of code(rel).split('\n')) {
        if (/\{row\.title \|\| 'Untitled'\}/.test(line)) expect(line).not.toMatch(/font-(medium|semibold|normal|bold|\[\d+\])/);
      }
    }
  });
  it('the calendar Undated chip and the list title take it too (they were 400)', () => {
    const cal = code('components/views/calendar-view.tsx');
    expect(cal.slice(cal.indexOf('function UndatedChip'))).toContain('RECORD_TITLE_WEIGHT');
    expect(code('components/views/list-view.tsx')).toMatch(/TITLE_SLOT, 'truncate text-title text-ink', RECORD_TITLE_WEIGHT/);
  });
  it('KEEPS what must not change: the board group-by caption and list group headings stay font-medium chrome', () => {
    expect(code('components/views/board-view.tsx')).toContain('font-medium text-ink">{groupField.displayName}');
    expect(code('components/views/list-view.tsx')).toContain('text-title font-medium text-ink">{group.label}');
  });
});
