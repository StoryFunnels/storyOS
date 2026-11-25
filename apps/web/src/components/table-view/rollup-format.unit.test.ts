import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { CellDisplay, formatNumberValue } from './cells';
import type { Field } from './use-table-data';

/**
 * Ticket #1256 — a sum/avg/min/max rollup inherits the number format of the field it aggregates; the API puts it in the
 * rollup's config at read time. Asserted on what the cell (CellDisplay, which the table, the record page and the board
 * all draw through) renders, against formatNumberValue so the expectation is the number field's own formatting.
 */
const rollup = (op: string, config: Record<string, unknown> = {}) =>
  ({ id: 'r', apiName: 'quote_total', displayName: 'Quote Total', type: 'rollup', config: { op, ...config }, isSystem: false }) as unknown as Field;

function render(field: Field, value: unknown) {
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(CellDisplay, { field, value, memberNames: new Map() })),
  );
}

describe('a rollup draws with the format it inherits (#1256)', () => {
  const eur = { format: 'currency', currency_code: 'EUR', precision: 2, format_inherited: true };

  it('a currency-inheriting sum renders as currency, the way the number field does', () => {
    const expected = formatNumberValue({ config: eur }, 5740);
    expect(expected).toContain('5,740.00');
    expect(render(rollup('sum', eur), 5740)).toContain(expected);
    expect(render(rollup('sum', eur), 5740)).not.toContain('>5740<');
  });

  it('a percent-inheriting avg renders with the percent sign', () => {
    const html = render(rollup('avg', { format: 'percent', precision: 1, format_inherited: true }), 57.25);
    expect(html).toContain('57.3%');
  });

  it('a non-integer with no precision is held to two places, not the whole float', () => {
    const html = render(rollup('avg', { format: 'plain', format_inherited: true }), 10 / 3);
    expect(html).toContain('3.33<');
    expect(html).not.toContain('3.333');
  });

  it('a count rollup stays a plain integer', () => {
    const html = render(rollup('count'), 3);
    expect(html).toContain('>3<');
    expect(html).not.toContain('3.00');
    expect(html).not.toMatch(/[$€£]/);
  });

  it('a rollup with no format is unchanged: integer as is, non-integer to two places', () => {
    expect(render(rollup('sum'), 5740)).toContain('>5740<');
    expect(render(rollup('sum'), 2.5)).toContain('>2.50<');
  });

  it('an explicit format in config wins over what the source would give (the cell draws what config carries)', () => {
    const html = render(rollup('sum', { format: 'currency', currency_code: 'GBP', precision: 0 }), 5740);
    expect(html).toContain(formatNumberValue({ config: { format: 'currency', currency_code: 'GBP', precision: 0 } }, 5740));
    expect(html).not.toContain('EUR');
  });

  it('null and undefined draw nothing', () => {
    for (const v of [null, undefined]) {
      const html = render(rollup('sum', eur), v);
      expect(html).not.toMatch(/\d/);
    }
  });
});
