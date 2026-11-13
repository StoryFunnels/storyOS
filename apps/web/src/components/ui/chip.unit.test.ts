import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OptionChip } from '../table-view/cells';
import { chipVariants } from './chip';

const root = join(__dirname, '..', '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
  });
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Ticket #1275 item 4 (Otto, 2026-11-13): the label chip is 12px / 600, 8px side padding, 19px tall, 4px radius, on every
 * surface. One place owns it (the `value` variant of ui/chip), and every surface that draws a select value goes through
 * OptionChip, which wears it.
 */
describe('the shared value chip (ticket #1275 item 4)', () => {
  it('the value variant is 12px / 600, 8px padding, 19px tall, 4px radius', () => {
    const cls = chipVariants({ variant: 'value' });
    for (const c of ['h-[19px]', 'px-2', 'text-label', 'font-semibold', 'rounded-[var(--radius-chip)]']) expect(cls, c).toContain(c);
    for (const c of ['text-meta', 'font-medium', 'px-1.5', 'py-0.5']) expect(cls, c).not.toContain(c);
  });

  it('KEEPS the reference variant as it was: outline, body size, 1.4px border, 6px padding (it is not a label chip)', () => {
    const cls = chipVariants({ variant: 'reference' });
    for (const c of ['border-[1.4px]', 'border-border-strong', 'px-1.5', 'py-0.5', 'text-body', 'text-ink']) expect(cls, c).toContain(c);
    for (const c of ['h-[19px]', 'font-semibold', 'text-label']) expect(cls, c).not.toContain(c);
  });

  it('an OptionChip anywhere renders that shape and keeps its tint', () => {
    const html = renderToStaticMarkup(createElement(OptionChip, { option: { id: 'o', label: 'Confirmed', color: 'green' } }));
    for (const c of ['h-[19px]', 'px-2', 'text-label', 'font-semibold', 'option-tint']) expect(html, c).toContain(c);
  });

  it('no surface re-draws a select value as its own tinted pill: the tint-by-option-colour recipe lives in cells.tsx alone', () => {
    // Not value chips, so not in scope: the calendar's event bars (a block that spans time, with a border) and the toolbar's
    // on/off toggle tint. Each is a different control; a NEW file using the recipe fails here and has to say why.
    const notAValueChip = ['calendar-time-grid.tsx', 'calendar-view.tsx', 'view-toolbar.tsx'];
    const offenders = walk(root).filter((f) => {
      const t = strip(readFileSync(f, 'utf8'));
      return /backgroundColor:\s*`\$\{[^}]+\}22`/.test(t) && !f.endsWith(join('table-view', 'cells.tsx')) && !notAValueChip.some((n) => f.endsWith(n));
    });
    expect(offenders.map((f) => f.slice(root.length))).toEqual([]);
  });
});
