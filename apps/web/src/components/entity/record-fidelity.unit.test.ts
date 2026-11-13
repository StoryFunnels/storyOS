import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_LABEL } from './section-label';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/** Ticket #1277 (child of #1272): the record page and panel against the design. One describe per numbered item. */
describe('item 1: one section-label style on the record', () => {
  const recordDetail = read('record-detail.tsx');
  const longText = read('long-text-block.tsx');
  const richText = read('rich-text-field.tsx');
  const collection = read('collection-section.tsx');

  it('is mono, 9px, regular, 0.14em tracking, caps, in the muted colour (a label is prose, never the faint glyph colour)', () => {
    expect(SECTION_LABEL).toContain('font-mono');
    expect(SECTION_LABEL).toContain('text-[9px]');
    expect(SECTION_LABEL).toContain('font-normal');
    expect(SECTION_LABEL).toContain('uppercase');
    expect(SECTION_LABEL).toContain('tracking-[0.14em]');
    expect(SECTION_LABEL).toContain('text-muted');
    expect(SECTION_LABEL).not.toContain('text-faint'); // under 4.5:1 on the cream page
  });

  it('Properties/Links groups, Description (open and quiet), rich-text headings and collection headings all use it', () => {
    expect(recordDetail).toMatch(/SECTION_LABEL\)\}\s*>\s*<ChevronRight/); // the group header button
    expect(recordDetail).toMatch(/hover:bg-hover hover:text-ink', SECTION_LABEL/); // the quiet "+ Description"
    expect(longText).toContain('<h2 className={SECTION_LABEL}>{label}</h2>'); // LongTextHeader: the open Description + rich text
    expect(richText).toContain('SECTION_LABEL'); // the quiet "+ <field>" button
    expect(collection).toContain('<h2 className={SECTION_LABEL}>{field.displayName}</h2>');
  });

  it('no record section heading is hand-rolled any more (the three drifting copies)', () => {
    for (const s of [recordDetail, longText, richText, collection]) {
      expect(s).not.toMatch(/text-(label|micro|meta) font-medium uppercase tracking-wider text-muted/);
    }
  });
});
