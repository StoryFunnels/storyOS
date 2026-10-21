import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('table header polish (#1018)', () => {
  it('the gutter header carries no count — that is the toolbar’s "N of M"', () => {
    const t = code('components/table-view/table-view.tsx');
    expect(t).not.toMatch(/useRecordCount|pluralNoun/);
  });
  it('the freeze mark is --c2, never the accent (gold is agency’s colour, #831)', () => {
    const h = code('components/table-view/header-cell.tsx');
    const mark = h.slice(h.indexOf('title="Frozen"') - 120, h.indexOf('title="Frozen"') + 40);
    expect(mark).toContain('text-[var(--c2)]');
    expect(mark).not.toMatch(/accent/);
  });
  it('the # column is wide enough for its label, the mark and ⋯', () => {
    expect(read('components/table-view/table-view.tsx')).toMatch(/ID_COLUMN_WIDTH = 7\d/);
  });
});

describe('a focus ring is for the keyboard (#1018)', () => {
  const css = read('app/globals.css');
  it('is hidden after a pointer press on everything but text fields', () => {
    expect(css).toMatch(/html\[data-modality='pointer'\] :focus-visible:not\(input, textarea, select, \[contenteditable='true'\]\)/);
  });
  it('a sidebar row’s ring is drawn on the row, not on its inner link', () => {
    expect(css).toMatch(/\[data-sidebar-row\]:has\(:is\(a, button\)\.flex-1:focus-visible\)/);
    expect(read('components/sidebar-row.tsx')).toContain('data-sidebar-row');
  });
});
