import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { CellDisplay } from './cells';
import type { Field } from './use-table-data';

/**
 * Ticket #886 — a `collect` rollup resolves to an ARRAY of attachment chips. The cell used to hand the
 * whole array to the single-chip branch and drew one "Untitled" chip. Asserted on what the cell renders.
 */
const rollup = { id: 'f', apiName: 'files', displayName: 'Files', type: 'rollup', config: {}, isSystem: false } as unknown as Field;
const chip = (id: string, filename: string, size = 2048) => ({ id, filename, size, mime_type: 'application/pdf', has_thumbnail: false });

function render(value: unknown, field: Field = rollup) {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(CellDisplay, { field, value, memberNames: new Map() })),
  );
}

describe('a collect rollup in a table cell (#886)', () => {
  it('renders one chip per collected file, named, and never "Untitled"', () => {
    const html = render([chip('a', 'brief.pdf'), chip('b', 'logo.png'), chip('c', 'notes.txt')]);
    for (const name of ['brief.pdf', 'logo.png', 'notes.txt']) expect(html).toContain(name);
    expect(html).not.toContain('Untitled');
    expect(html.match(/📎/g)?.length).toBe(3);
  });

  it('renders the SAME markup as an attachment field holding those files (one renderer, not a copy)', () => {
    const files = [chip('a', 'brief.pdf'), chip('b', 'logo.png')];
    const asAttachment = { ...rollup, type: 'attachment' } as unknown as Field;
    expect(render(files)).toBe(render(files, asAttachment));
  });

  it('an empty collection renders nothing, not an empty chip', () => {
    expect(render([])).not.toContain('Untitled');
    expect(render([])).not.toContain('📎');
  });

  it('first/last rollups still render their single chip, and numbers still render as numbers', () => {
    const single = render({ id: 'r1', title: 'Launch plan', database_id: 'd1' });
    expect(single).toContain('Launch plan');
    expect(render(42)).toContain('42');
  });
});
