import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_LABEL } from './section-label';
import { ROW_LABEL_CLS, ROW_VALUE_CLS } from './scalar-fields';

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

describe('item 2: field rows are the design\'s 30px row, label 13px regular', () => {
  const scalar = read('scalar-fields.tsx');
  const row = scalar.slice(scalar.indexOf('export function UnifiedFieldRow'), scalar.indexOf('export function TopChip'));

  it('the label is 13px (text-body) regular weight in the muted colour; the value inherits the secondary ink', () => {
    expect(ROW_LABEL_CLS).toBe('text-body font-normal text-muted');
    expect(ROW_VALUE_CLS).toBe('text-ink-secondary');
    expect(ROW_LABEL_CLS).not.toMatch(/font-medium/); // 500 made the labels compete with the values
  });

  it('the row is 30px: label and value cells both min-h-[30px], no extra vertical padding, a 13px glyph', () => {
    expect(row).toContain("flex min-h-[30px] items-center gap-1.5', ROW_LABEL_CLS");
    expect(row).toContain('flex min-h-[30px] min-w-0 items-center gap-1');
    expect(row).toContain('ROW_VALUE_CLS');
    expect(row).toContain('h-[13px] w-[13px]');
    expect(row).not.toMatch(/\bpy-0\.5\b|pt-0\.5/);
  });

  it('KEEPS the 150px label column (every value starts at one x), and the strip / body scalar keep their own label style', () => {
    expect(row).toContain('grid-cols-[150px_1fr]');
    expect(scalar).toMatch(/const FIELD_LABEL_CLS = 'text-label font-medium text-muted'/);
    const body = scalar.slice(scalar.indexOf('export function BodyScalar'));
    expect(body).toContain('FIELD_LABEL_CLS');
    expect(body).not.toContain('ROW_LABEL_CLS');
  });
});
