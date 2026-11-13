import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAlwaysOnField } from './always-on-fields';

/** #1281 item 3 — the title column is always on: no Hide in its header menu, and a stale hidden id cannot remove it. */
const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('#1281 isAlwaysOnField', () => {
  it('is the title field', () => {
    expect(isAlwaysOnField({ type: 'title' })).toBe(true);
  });
  it('is nothing else: every other column keeps its Hide field (what must be KEPT)', () => {
    for (const type of ['text', 'number', 'select', 'user', 'relation', 'created_at', 'updated_at', 'date', 'checkbox', 'formula']) {
      expect(isAlwaysOnField({ type }), type).toBe(false);
    }
  });
});

describe('#1281 both ends use it', () => {
  it('the header menu withholds Hide field from the title but still gates on config/onPatch', () => {
    const header = read('../table-view/header-cell.tsx');
    expect(header).toContain('const canHide = Boolean(config && onPatch) && !isAlwaysOnField(field);');
    expect(header).toContain('Hide field');
  });
  it('the table ignores a title id already in hidden_field_ids, and still honours it for other fields', () => {
    const table = read('../table-view/table-view.tsx');
    expect(table).toContain('(isAlwaysOnField(f) || !(hiddenFieldIds ?? []).includes(f.id))');
  });
});
