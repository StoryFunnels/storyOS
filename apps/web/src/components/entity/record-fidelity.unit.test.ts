import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_LABEL } from './section-label';
import { ROW_LABEL_CLS, ROW_VALUE_CLS } from './scalar-fields';
import { describeScalarChange, formatActivityValue, isEmptyActivityValue } from './activity-format';
import { DEFAULT_REGIONAL, formatDate, formatDateTime } from '@/lib/format';

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

describe('item 3: the record title is 24px / 700 with -0.02em tracking (20px on a phone)', () => {
  const recordDetail = read('record-detail.tsx');
  const title = recordDetail.slice(recordDetail.indexOf('resize-none overflow-hidden whitespace-pre-wrap'), recordDetail.indexOf('read-only:cursor-default') + 60);

  it('is bold with -0.02em tracking, 20px below the sm breakpoint and 24px from it', () => {
    expect(title).toContain('font-bold');
    expect(title).toContain('tracking-[-0.02em]');
    expect(title).toContain('text-xl');
    expect(title).toContain('sm:text-2xl');
    expect(title).not.toContain('font-semibold');
  });

  it('KEEPS the editable-textarea behaviour: it still wraps, hides overflow, and is read-only aware', () => {
    expect(title).toContain('whitespace-pre-wrap break-words');
    expect(title).toContain('overflow-hidden');
    expect(title).toContain('placeholder:text-faint');
    expect(title).toContain('read-only:cursor-default');
  });
});

const nobody = () => undefined;
const dates = { date: (v: unknown) => formatDate(v, DEFAULT_REGIONAL), dateTime: (v: unknown) => formatDateTime(v, DEFAULT_REGIONAL) };

describe('item 7: Activity writes a date the way the date field above it does', () => {
  it('a date value goes through the shared formatter, not as the stored YYYY-MM-DD', () => {
    const shown = formatActivityValue('2026-11-13', 'date', nobody, dates);
    expect(shown).toBe(formatDate('2026-11-13', DEFAULT_REGIONAL)); // identical to what the cell prints
    expect(shown).not.toBe('2026-11-13');
  });

  it('a system timestamp shows day and time (the cell\'s own split); a plain date shows the day only', () => {
    expect(formatActivityValue('2026-11-13T09:30:00.000Z', 'created_at', nobody, dates)).toBe(formatDateTime('2026-11-13T09:30:00.000Z', DEFAULT_REGIONAL));
    expect(formatActivityValue('2026-11-13T09:30:00.000Z', 'date', nobody, dates)).toBe(formatDate('2026-11-13T09:30:00.000Z', DEFAULT_REGIONAL));
  });

  it('KEEPS: a text field that looks like a date stays as typed; an unreadable date and a caller with no formatter show the stored string; empty stays "empty"', () => {
    expect(formatActivityValue('2026-11-13', 'text', nobody, dates)).toBe('2026-11-13');
    expect(formatActivityValue('not a date', 'date', nobody, dates)).toBe('not a date'); // never blank
    expect(formatActivityValue('2026-11-13', 'date', nobody)).toBe('2026-11-13');
    expect(formatActivityValue(null, 'date', nobody, dates)).toBe('empty');
  });

  it('the panel hands the formatter to every scalar change', () => {
    expect(read('panels.tsx')).toMatch(/describeScalarChange\(change, fieldTypeFor\(change\.field\), \(id\) => nameById\.get\(id\), dates\)/);
  });
});

describe('item 8: an empty "from" is a set, an empty "to" is a clear', () => {
  it('empty old value: "set X to Y", never "X: → Y"', () => {
    for (const from of [null, undefined, '', []]) {
      expect(describeScalarChange({ from, to: 'Refresh emails' }, 'title', nobody)).toEqual({ kind: 'set', to: 'Refresh emails' });
    }
  });

  it('empty new value: "cleared X (was Y)"', () => {
    expect(describeScalarChange({ from: 'kurz 1', to: '' }, 'text', nobody)).toEqual({ kind: 'cleared', from: 'kurz 1' });
    expect(describeScalarChange({ from: ['a'], to: [] }, 'multi_select', nobody)).toEqual({ kind: 'cleared', from: 'a' });
  });

  it('KEEPS: value to value is still "A → B", and 0 / false are values, not empty', () => {
    expect(describeScalarChange({ from: 'Todo', to: 'Done' }, 'select', nobody)).toEqual({ kind: 'changed', from: 'Todo', to: 'Done' });
    expect(describeScalarChange({ from: null, to: 0 }, 'number', nobody)).toEqual({ kind: 'set', to: '0' });
    expect(describeScalarChange({ from: 0, to: null }, 'number', nobody)).toEqual({ kind: 'cleared', from: '0' });
    expect(describeScalarChange({ from: false, to: true }, 'checkbox', nobody)).toEqual({ kind: 'changed', from: 'false', to: 'true' });
    expect(isEmptyActivityValue(0)).toBe(false);
    expect(isEmptyActivityValue(false)).toBe(false);
  });

  it('the panel words the three kinds, and the rich-text diff keeps its own "changed Field:" lead', () => {
    const panels = read('panels.tsx');
    expect(panels).toMatch(/line\.kind === 'set'\) return <>set \{fieldLabel\} to/);
    expect(panels).toMatch(/line\.kind === 'cleared'\) return <>cleared \{fieldLabel\} \(was/);
    expect(panels).toMatch(/changed \{fieldLabel\}:\{' '\}\s*\{lines\.map/);
  });
});
