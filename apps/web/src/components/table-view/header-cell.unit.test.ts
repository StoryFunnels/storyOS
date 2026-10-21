import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * #999 — a column header has exactly ONE menu trigger and never a button for freezing.
 *
 * The defect: the title column rendered two identical "Options" menus (the ordinary one and a title-only one holding
 * "Configure name…") plus a hover-only Freeze button, and `justify-between` spread the four across the cell. The
 * test drives the real component through its real props, for the three shapes the ticket names: a plain column, the
 * title column, and the frozen first column.
 */
vi.mock('@/lib/api', () => ({ api: {}, apiFetch: vi.fn() }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { DndContext } = await import('@dnd-kit/core');
const { SortableContext } = await import('@dnd-kit/sortable');
const { HeaderCell } = await import('./header-cell');
const { ConfirmProvider } = await import('@/components/ui/confirm-dialog');
const { TooltipProvider } = await import('@/components/ui/tooltip');

type Over = Record<string, unknown>;
function field(type: string, name: string, over: Over = {}) {
  return { id: `f-${name}`, apiName: name.toLowerCase(), displayName: name, type, config: {}, options: [], isSystem: false, ...over } as never;
}
function render(f: never, props: Over = {}) {
  const qc = new QueryClient();
  const config = { sorts: [], filters: undefined, hidden_field_ids: [] } as never;
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        ConfirmProvider,
        null,
      createElement(
        TooltipProvider,
        null,
      createElement(
        DndContext,
        null,
        createElement(
          SortableContext,
          { items: [(f as { id: string }).id] } as never,
          createElement(HeaderCell, {
            ws: 'w',
            db: 'd',
            field: f,
            fields: [f],
            width: 180,
            readOnly: false,
            onResize: () => {},
            reorderable: true,
            config,
            onPatch: () => {},
            ...props,
          } as never),
        ),
      ),
      ),
      ),
    ),
  );
}
const triggers = (html: string) => html.match(/aria-label="Options for [^"]*"/g) ?? [];

describe('HeaderCell (#999): one menu trigger, no freeze button', () => {
  it('a plain column has exactly one ⋯, and it is not hover-only', () => {
    const html = render(field('text', 'Notes'));
    expect(triggers(html)).toEqual(['aria-label="Options for Notes"']);
    expect(html).not.toMatch(/opacity-0/);
    expect(html).toContain('text-faint');
  });

  it('the title column has ONE ⋯ too (its "Configure name…" lives in the same menu, not a second trigger)', () => {
    const html = render(field('title', 'Name'), { isFirst: true, onTogglePin: () => {} });
    expect(triggers(html)).toHaveLength(1);
  });

  it('the first column never draws a Freeze / Unfreeze button, frozen or not', () => {
    for (const pinned of [false, true]) {
      const html = render(field('title', 'Name'), { isFirst: true, pinned, onTogglePin: () => {} });
      expect(html).not.toMatch(/aria-label="(Un)?[Ff]reeze column"/);
    }
  });

  it('shows the freeze mark beside the label only when the column IS frozen', () => {
    const frozen = render(field('title', 'Name'), { isFirst: true, pinned: true, onTogglePin: () => {} });
    const notFrozen = render(field('title', 'Name'), { isFirst: true, pinned: false, onTogglePin: () => {} });
    expect(frozen).toContain('aria-label="Frozen"');
    expect(notFrozen).not.toContain('aria-label="Frozen"');
    // A column that is not the first can never carry it, even if the flag is passed.
    expect(render(field('text', 'Notes'), { pinned: true })).not.toContain('aria-label="Frozen"');
  });

  it('shows the sort direction inline, with the rule number only when there is more than one rule', () => {
    const one = render(field('text', 'Notes'), { config: { sorts: [{ field: 'notes', direction: 'asc' }], hidden_field_ids: [] } });
    expect(one).toContain('↑');
    expect(one).not.toContain('<sup');
    const two = render(field('text', 'Notes'), {
      config: { sorts: [{ field: 'name', direction: 'asc' }, { field: 'notes', direction: 'desc' }], hidden_field_ids: [] },
    });
    expect(two).toContain('↓');
    expect(two).toMatch(/<sup[^>]*>2<\/sup>/);
    expect(render(field('text', 'Notes'))).not.toMatch(/[↑↓]/);
  });
});
