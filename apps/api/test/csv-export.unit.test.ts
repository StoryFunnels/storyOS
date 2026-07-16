import { describe, expect, it } from 'vitest';
import { csvCell, csvFilename, serializeCell, serializeCsv, type ExportField } from '../src/export/csv';
import { splitTargets } from '../src/import/import.service';

const field = (over: Partial<ExportField> & { type: string }): ExportField => ({
  id: 'f1',
  displayName: 'F',
  apiName: 'f',
  ...over,
});

describe('csv escaping (MN-075, RFC 4180)', () => {
  it('quotes only when it must', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('has,comma')).toBe('"has,comma"');
    expect(csvCell('has "quotes"')).toBe('"has ""quotes"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('survives a title that is itself CSV-shaped', () => {
    // The nastiest real case: a title that would otherwise blow the column count.
    const nasty = 'Fix "the, thing"\nnow';
    const csv = serializeCsv(
      [field({ type: 'title', displayName: 'Name' })],
      [{ number: 1, title: nasty, values: {} }],
    );
    expect(csv).toBe(`Name\r\n"Fix ""the, thing""\nnow"\r\n`);
  });
});

describe('cell serialization mirrors the importer (MN-075)', () => {
  const users = new Map([['u1', 'Maya Rodriguez']]);
  const rec = (values: Record<string, unknown>) => ({ number: 7, title: 'T', values });

  it('title and id come off the record, not values', () => {
    expect(serializeCell(field({ type: 'title' }), rec({}), users)).toBe('T');
    expect(serializeCell(field({ type: 'id' }), rec({}), users)).toBe('7');
  });

  it('checkbox is true/false — what the importer parses back', () => {
    expect(serializeCell(field({ type: 'checkbox' }), rec({ f: true }), users)).toBe('true');
    expect(serializeCell(field({ type: 'checkbox' }), rec({ f: false }), users)).toBe('false');
  });

  it('relations and multi-selects are comma-separated titles/labels', () => {
    const chips = [{ id: 'a', title: 'Apollo' }, { id: 'b', title: 'Zephyr' }];
    expect(serializeCell(field({ type: 'relation' }), rec({ f: chips }), users)).toBe('Apollo, Zephyr');
    expect(serializeCell(field({ type: 'multi_select' }), rec({ f: ['urgent', 'backend'] }), users)).toBe(
      'urgent, backend',
    );
  });

  it('users render as names', () => {
    expect(serializeCell(field({ type: 'user' }), rec({ f: 'u1' }), users)).toBe('Maya Rodriguez');
    expect(serializeCell(field({ type: 'user' }), rec({ f: ['u1', 'unknown'] }), users)).toBe(
      'Maya Rodriguez, unknown',
    );
  });

  it('rich text becomes Markdown, not block JSON', () => {
    const blocks = [
      { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Title', styles: {} }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Body', styles: {} }] },
    ];
    expect(serializeCell(field({ type: 'rich_text' }), rec({ f: blocks }), users)).toBe('## Title\n\nBody');
  });

  it('empty and missing values are empty cells, not "undefined"', () => {
    expect(serializeCell(field({ type: 'text' }), rec({}), users)).toBe('');
    expect(serializeCell(field({ type: 'text' }), rec({ f: null }), users)).toBe('');
    expect(serializeCell(field({ type: 'relation' }), rec({ f: [] }), users)).toBe('');
  });

  it('drops buttons — they hold no data', () => {
    const csv = serializeCsv(
      [field({ type: 'title', displayName: 'Name' }), field({ id: 'b', type: 'button', displayName: 'Go' })],
      [{ number: 1, title: 'x', values: {} }],
    );
    expect(csv.split('\r\n')[0]).toBe('Name');
  });
});

describe('export → import round-trip (MN-075 AC)', () => {
  it('a multi-target relation cell splits back into the same titles', () => {
    const chips = [{ id: 'a', title: 'Apollo' }, { id: 'b', title: 'Zephyr' }];
    const cell = serializeCell(field({ type: 'relation' }), { number: 1, title: 'T', values: { f: chips } }, new Map());
    // Before this ticket the importer read the whole cell as ONE title, so a
    // many-to-many export could never round-trip.
    expect(splitTargets(cell)).toEqual(['Apollo', 'Zephyr']);
  });

  it('a single target still round-trips', () => {
    expect(splitTargets('Apollo')).toEqual(['Apollo']);
  });

  it('ignores empty segments from a trailing separator', () => {
    expect(splitTargets('Apollo, ,Zephyr,')).toEqual(['Apollo', 'Zephyr']);
  });
});

describe('filename', () => {
  it('slugifies and dates it', () => {
    expect(csvFilename('Client Work / Tasks', new Date('2026-07-16T10:00:00Z'))).toBe(
      'Client-Work-Tasks-2026-07-16.csv',
    );
    expect(csvFilename('   ', new Date('2026-07-16T10:00:00Z'))).toBe('export-2026-07-16.csv');
  });
});
