import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLongTextValue } from './cells';

const here = __dirname;
const src = (f: string) => readFileSync(join(here, f), 'utf8');

describe('#1232 isLongTextValue', () => {
  const text = (config: Record<string, unknown> = {}) => ({ type: 'text', config });
  it('opens the expanded editor for a Long text field, empty or not', () => {
    expect(isLongTextValue(text({ multiline: true }), null)).toBe(true);
  });
  it('opens it for a plain text value that holds a line break or runs long', () => {
    expect(isLongTextValue(text(), 'a\nb')).toBe(true);
    expect(isLongTextValue(text(), 'x'.repeat(121))).toBe(true);
  });
  it('KEEPS short text, title, url and email inline', () => {
    expect(isLongTextValue(text(), 'short')).toBe(false);
    expect(isLongTextValue(text(), null)).toBe(false);
    for (const type of ['title', 'url', 'email']) {
      expect(isLongTextValue({ type, config: { multiline: true } }, 'x'.repeat(500))).toBe(false);
    }
  });
});

describe('#1232 one frame per cell', () => {
  const cells = src('cells.tsx');
  it('the inline text editor adds no horizontal padding of its own', () => {
    expect(cells).toMatch(/data-cell-input\n\s*\/\/ #1232[^\n]*\n\s*className="h-full w-full bg-card px-0/);
  });
  it('the cell-editor and picker-search focus rules exist and keep an indicator', () => {
    const css = readFileSync(join(here, '../../app/globals.css'), 'utf8');
    expect(css).toMatch(/\[data-cell-input\]:focus-visible\s*\{\s*outline: none;/);
    expect(css).toMatch(/\[data-picker-search\]:focus-visible:not\(\.border-error\)\s*\{\s*border-color: var\(--border-strong\)/);
  });
  it('every picker search input is marked', () => {
    expect(cells).toMatch(/data-picker-search\n\s*value=\{query\}/);
    expect(src('relation-cell.tsx')).toContain('data-picker-search');
    expect(readFileSync(join(here, '../ui/date-picker.tsx'), 'utf8')).toContain('data-picker-search');
  });
});
