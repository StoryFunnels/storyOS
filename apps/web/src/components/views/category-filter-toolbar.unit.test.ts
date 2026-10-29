import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * #1159 — the builder offers `category_is` / `category_is_not` exactly where the API accepts them (query-compiler.ts compileCategory:
 * select and workflow, never multi_select), in the MCP's order, and never lets their value be read as option ids.
 */
vi.mock('@/lib/api', () => ({ api: {}, apiFetch: vi.fn() }));

const {
  OPS_BY_TYPE,
  FilterValueEditor,
  defaultValueFor,
  opsForField,
  usesChipSet,
  remapConditionToField,
  describeCondition: describe_,
} = await import('./view-toolbar');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

const field = (type: string) =>
  ({ id: `f-${type}`, apiName: type, displayName: type, type, config: {}, options: [{ id: 'opt-1', label: 'One' }] }) as never;

const render = (node: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));

describe('operator lists', () => {
  it('offers both on select and workflow, in the MCP order, and nowhere else', () => {
    for (const type of ['select', 'workflow']) {
      expect(OPS_BY_TYPE[type]!.map((o) => o.op)).toEqual([
        'eq',
        'neq',
        'has',
        'has_none',
        'category_is',
        'category_is_not',
        'is_empty',
        'not_empty',
      ]);
    }
    for (const [type, ops] of Object.entries(OPS_BY_TYPE)) {
      if (type === 'select' || type === 'workflow') continue;
      expect(ops.map((o) => o.op), type).not.toContain('category_is');
      expect(ops.map((o) => o.op), type).not.toContain('category_is_not');
    }
  });

  it('keeps workflow identical to select, operator for operator', () => {
    expect(OPS_BY_TYPE.workflow).toEqual(OPS_BY_TYPE.select);
  });

  it('leaves the option-based operators exactly as they were', () => {
    const labels = Object.fromEntries(opsForField(field('workflow')).map((o) => [o.op, [o.label, o.input]]));
    expect(labels).toMatchObject({
      eq: ['is', 'option'],
      neq: ['is not', 'option'],
      has: ['is any of', 'options'],
      has_none: ['is none of', 'options'],
    });
    expect(labels['category_is']).toEqual(['is in category', 'categories']);
    expect(labels['category_is_not']).toEqual(['is not in category', 'categories']);
  });
});

describe('the chip / row label (describeCondition)', () => {
  const { describeCondition } = { describeCondition: describe_ };
  const state = { ...(field('workflow') as object), displayName: 'State' } as never;
  const c = (op: string, value: unknown) => ({ field: 'workflow', op, value }) as never;

  it('reads a stored category condition in words, never as "is"', () => {
    expect(describeCondition(state, c('category_is', ['completed', 'canceled']), [])).toBe('State is done or canceled');
    expect(describeCondition(state, c('category_is_not', ['completed']), [])).toBe('State is not done');
    expect(describeCondition(state, c('category_is_not', []), [])).toBe('State is not in category');
  });

  it('does not touch the option-based ones', () => {
    expect(describeCondition(state, c('neq', 'opt-1'), [])).toBe('State is not One');
    expect(describeCondition(state, c('has_none', ['opt-1']), [])).toBe('State is none of One');
    expect(describeCondition(state, c('has', ['opt-1']), [])).toBe('State is any of One');
  });

  it('falls back to words, not a crash, on a category op the field type does not offer', () => {
    const multi = { ...(field('multi_select') as object), displayName: 'Tags' } as never;
    expect(() => describeCondition(multi, c('category_is', ['completed']), [])).not.toThrow();
  });
});

describe('the value control', () => {
  const activeOp = { op: 'category_is', label: 'is in category', input: 'categories' };

  it('starts empty (an unfinished condition) and a category op on a new row keeps no stale option ids', () => {
    expect(defaultValueFor('categories')).toEqual([]);
    const moved = remapConditionToField({ field: 'x', op: 'eq', value: 'opt-1' }, field('workflow'));
    expect(moved).toMatchObject({ op: 'eq', value: '' });
  });

  it('is a chip set under the rule in the row, whatever the field\'s own option count', () => {
    expect(usesChipSet(field('workflow'), activeOp, [])).toBe(true);
    expect(usesChipSet(field('workflow'), { input: 'option' }, [])).toBe(false);
  });

  it('in the compact chip it is the searchable picker over the five categories, not the field\'s options', () => {
    const html = render(
      createElement(FilterValueEditor, {
        field: field('workflow'),
        members: [],
        activeOp,
        condition: { field: 'workflow', op: 'category_is', value: ['completed', 'canceled'] },
        onChange: () => {},
      }),
    );
    expect(html).toContain('Done');
    expect(html).toContain('Canceled');
    expect(html).not.toContain('One'); // the field's option label is never a category
  });

  it('renders nothing of its own in a row (the row draws the chips), and never crashes on a stored string or garbage', () => {
    for (const value of ['completed', 'archived', null, 7, [null, 'x']]) {
      expect(() =>
        render(
          createElement(FilterValueEditor, {
            field: field('workflow'),
            members: [],
            activeOp,
            condition: { field: 'workflow', op: 'category_is', value } as never,
            onChange: () => {},
            fill: true,
          }),
        ),
      ).not.toThrow();
    }
  });
});
