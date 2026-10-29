import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * ticket #1155 — where a date condition is summarised or edited, a relative date reads in words. `describeCondition` is the one text
 * behind the pinned chip, the condition's default label and its "Edit name" placeholder; `FilterValueEditor` is the one value control
 * behind the panel row and the legacy chip. Same harness as filter-value-editor.unit.test.ts (the toolbar module needs the API client stubbed).
 */
vi.mock('@/lib/api', () => ({ api: {}, apiFetch: vi.fn() }));

const { describeCondition, FilterValueEditor, opsForField } = await import('./view-toolbar');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

const date = { id: 'f-d', apiName: 'last_reviewed', displayName: 'Last reviewed', type: 'date', config: {} } as never;
const cond = (op: string, value: unknown) => ({ field: 'last_reviewed', op, value });

function render(op: string, value: unknown): string {
  const ops = opsForField(date);
  const activeOp = ops.find((o) => o.op === op)!;
  const qc = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(FilterValueEditor, { field: date, members: [], activeOp, condition: cond(op, value), onChange: () => {}, fill: true }),
    ),
  );
}

describe('describeCondition on a date field', () => {
  it('reads a relative date in words, on the two ops the API accepts it for', () => {
    expect(describeCondition(date, cond('before', '$date:-90d'), [])).toBe('Last reviewed more than 90 days ago');
    expect(describeCondition(date, cond('after', '$date:+3d'), [])).toBe('Last reviewed more than 3 days from now');
    expect(describeCondition(date, cond('after', '$date:-14d'), [])).toBe('Last reviewed after 2 weeks ago');
  });
  it('keeps an absolute date exactly as it was', () => {
    expect(describeCondition(date, cond('before', '2026-07-31'), [])).toBe('Last reviewed before 2026-07-31');
    expect(describeCondition(date, cond('eq', '2026-07-31'), [])).toBe('Last reviewed on 2026-07-31');
  });
  it('falls back to the raw text for a token it does not understand, and for a token on an op that does not take one', () => {
    expect(describeCondition(date, cond('before', '$date:-ninety'), [])).toBe('Last reviewed before $date:-ninety');
    expect(describeCondition(date, cond('eq', '$date:-90d'), [])).toBe('Last reviewed on $date:-90d');
  });
  it('an unfinished condition still reads as just the field and operator', () => {
    expect(describeCondition(date, cond('before', ''), [])).toBe('Last reviewed before');
  });
});

describe('the date value editor', () => {
  it('shows a stored token as an amount and a unit, never as the raw token', () => {
    const html = render('before', '$date:-90d');
    expect(html).not.toContain('$date');
    expect(html).toContain('value="90"');
    expect(html).toMatch(/<option value="days-ago" selected="">days ago<\/option>/);
  });
  it('shows whole weeks as weeks', () => {
    const html = render('after', '$date:+14d');
    expect(html).toContain('value="2"');
    expect(html).toMatch(/<option value="weeks-ahead" selected="">weeks from now<\/option>/);
  });
  it('shows an absolute date as the exact-date kind with the date, as before', () => {
    const html = render('before', '2026-07-31');
    expect(html).toMatch(/<option value="date" selected="">exact date<\/option>/);
    expect(html).toContain('2026-07-31');
  });
  it('an unknown token renders (as an exact-date control holding the raw text) rather than crashing', () => {
    expect(() => render('before', '$date:-ninety')).not.toThrow();
    expect(render('before', '$date:-ninety')).toContain('$date:-ninety');
  });
  it('`on` and `is not` take a day, not a relative date: no kind select', () => {
    expect(render('eq', '2026-07-31')).not.toContain('Date kind');
  });
});
