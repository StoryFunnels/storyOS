import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { newRecordHref, wantsTitleFocus } from './new-record';

const SRC = resolve(__dirname, '../..');
/** Every surface that creates a blank record and lands on it. */
const QUICK_ADD_SITES = [
  'components/views/board-view.tsx',
  'components/views/list-view.tsx',
  'components/views/calendar-view.tsx',
  'components/views/gallery-view.tsx',
  'components/views/feed-view.tsx',
  'app/w/[ws]/d/[db]/page.tsx',
  'components/record-templates/new-record-button.tsx',
  'components/quick-add-fab.tsx',
];

describe('ticket #1326 — quick-adds create an untitled record and focus its title', () => {
  for (const site of QUICK_ADD_SITES) {
    const src = readFileSync(resolve(SRC, site), 'utf8');
    it(`${site} never sends the literal name 'Untitled'`, () => {
      expect(src).not.toMatch(/name:\s*['"`]Untitled['"`]/);
    });
    it(`${site} opens the new record through newRecordHref`, () => {
      expect(src).toContain('newRecordHref(');
    });
  }

  it('the record page focuses the title on ?new=1 and drops the flag', () => {
    const src = readFileSync(resolve(SRC, 'components/entity/record-detail.tsx'), 'utf8');
    expect(src).toContain('wantsTitleFocus(window.location.search)');
    expect(src).toMatch(/searchParams\.delete\(NEW_RECORD_PARAM\)/);
  });

  it('builds the href and reads the flag', () => {
    expect(newRecordHref('w1', 'd1', 'r1')).toBe('/w/w1/d/d1/r/r1?new=1');
    expect(wantsTitleFocus('?new=1')).toBe(true);
    expect(wantsTitleFocus('?new=0')).toBe(false);
    expect(wantsTitleFocus('')).toBe(false);
    expect(wantsTitleFocus('?share=1')).toBe(false);
  });

  it('board add keeps the column value and calendar add keeps the date value, with no name', () => {
    const board = readFileSync(resolve(SRC, 'components/views/board-view.tsx'), 'utf8');
    expect(board).toMatch(/\[groupField\.apiName\]:/);
    const cal = readFileSync(resolve(SRC, 'components/views/calendar-view.tsx'), 'utf8');
    expect(cal).toContain('{ [dateField.apiName]: iso }');
  });
});
