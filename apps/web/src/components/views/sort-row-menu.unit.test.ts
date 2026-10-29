import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MenuSelect } from '@/components/ui/menu-select';

/**
 * #1118 — the Sort builder's rows drew a native `<select>` for the field and for the direction (#1114 migrated
 * Display and the primary pick list but left these). A native select's popup ignores the theme. The guard is scoped to
 * the thing it claims: the `SortRow` function body, extracted by its own boundaries, not a grep over the whole file
 * (view-toolbar.tsx legitimately keeps other native selects that are not part of this ticket).
 */
const src = readFileSync(fileURLToPath(new URL('./view-toolbar.tsx', import.meta.url)), 'utf8');
const start = src.indexOf('function SortRow(');
const end = src.indexOf('\n}\n', start);
const sortRow = src.slice(start, end);

describe('Sort builder row (#1118)', () => {
  it('found the SortRow body it is guarding', () => {
    expect(start).toBeGreaterThan(0);
    expect(sortRow).toContain('useSortable');
    expect(sortRow).toContain('Remove sort'); // the tail of the row, so the slice is not a prefix of it
  });

  it('draws no native <select>', () => {
    expect(sortRow).not.toMatch(/<select[\s>]/);
    expect(sortRow).not.toMatch(/<option[\s>]/);
  });

  it('draws the field and the direction through the shared MenuSelect, keeping their accessible names', () => {
    expect(sortRow.match(/<MenuSelect/g)).toHaveLength(2);
    expect(sortRow).toContain('label="Sort field"');
    expect(sortRow).toContain('label="Sort direction"');
  });

  it('keeps the rules the native selects enforced: a field used by another key is not offered, the own field is', () => {
    expect(sortRow).toContain('f.apiName === sort.field || !usedElsewhere.has(f.apiName)');
  });
});

describe('MenuSelect as the Sort row uses it', () => {
  const options = [
    { value: 'asc', label: 'A → Z' },
    { value: 'desc', label: 'Z → A' },
  ];
  it('names the current choice on the trigger and carries the accessible label', () => {
    const html = renderToStaticMarkup(createElement(MenuSelect, { label: 'Sort direction', value: 'desc', onChange: () => {}, options }));
    expect(html).toContain('aria-label="Sort direction"');
    expect(html).toContain('Z → A');
    expect(html).not.toContain('A → Z'); // the closed trigger shows only the current choice
  });
  it('lets a row override the width without losing the shared look', () => {
    const html = renderToStaticMarkup(createElement(MenuSelect, { label: 'Sort field', value: 'asc', onChange: () => {}, options, className: 'min-w-0 max-w-none flex-1' }));
    expect(html).toContain('flex-1');
    expect(html).toContain('border-border-default'); // still the shared trigger chrome
    expect(html).not.toContain('min-w-[7rem]'); // the override replaced the conflicting default
  });
});
