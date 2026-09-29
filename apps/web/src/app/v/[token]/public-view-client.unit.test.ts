import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicViewClient } from './public-view-client';
import type { PublicRecord, PublicViewDef, PublicViewField } from './public-view-client';

/**
 * #609 — paid-plan white-label on the public view page, mirroring the exact
 * `!def.hide_branding` conditional the public form page already uses (#269).
 */
function makeDef(hideBranding: boolean): PublicViewDef {
  return {
    view: { id: 'v1', name: 'My View', type: 'table' },
    database: { name: 'My Database' },
    fields: [],
    indexable: false,
    hide_branding: hideBranding,
    branding: { logo_url: null, accent_color: null },
    records: { data: [], next_cursor: null, has_more: false },
  };
}

describe('PublicViewClient — #609 hide_branding footer', () => {
  it('renders the "Powered by StoryOS" footer when hide_branding is false (free plan)', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, { token: 't1', initialDef: makeDef(false), embed: false }),
    );
    expect(html).toContain('Powered by StoryOS');
  });

  it('hides the footer when hide_branding is true (paid plan)', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, { token: 't1', initialDef: makeDef(true), embed: false }),
    );
    expect(html).not.toContain('Powered by StoryOS');
  });
});

/**
 * #539 — the operator's own brand (logo + accent colour), deliberately
 * unrelated to #609's hide_branding (that's OUR "Powered by StoryOS" footer,
 * paid-plan-gated; this is the operator's own mark, shown on every plan).
 */
describe('PublicViewClient — #539 operator branding', () => {
  function makeDef(branding: { logo_url: string | null; accent_color: string | null }): PublicViewDef {
    return {
      view: { id: 'v1', name: 'My View', type: 'table' },
      database: { name: 'My Database' },
      fields: [],
      indexable: false,
      hide_branding: false,
      branding,
      records: { data: [], next_cursor: null, has_more: false },
    };
  }

  it('renders nothing extra when branding is unset — the default, unbranded look', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: makeDef({ logo_url: null, accent_color: null }),
        embed: false,
      }),
    );
    expect(html).not.toContain('<img');
  });

  it('renders the operator logo as an <img>, from data — never dangerouslySetInnerHTML', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: makeDef({ logo_url: 'https://example.com/logo.png', accent_color: null }),
        embed: false,
      }),
    );
    expect(html).toContain('<img');
    expect(html).toContain('https://example.com/logo.png');
  });

  it('applies the accent colour only via inline style, never as raw injected markup', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: makeDef({ logo_url: null, accent_color: '#3366ff' }),
        embed: false,
      }),
    );
    expect(html).toContain('#3366ff');
    // The color reaches the page as a style declaration, not as a <script> or
    // an attribute an operator-supplied string could have escaped out of.
    expect(html).not.toContain('<script');
  });
});

/**
 * #610 — real field labels + the shared OptionChip for select cells, instead
 * of a humanized api_name and a bare option id/value.
 */
describe('PublicViewClient — #610 real labels + shared OptionChip', () => {
  function makeDefWithFields(): PublicViewDef {
    return {
      view: { id: 'v1', name: 'My View', type: 'table' },
      database: { name: 'My Database' },
      indexable: false,
      hide_branding: false,
      branding: { logo_url: null, accent_color: null },
      fields: [
        { api_name: 'stage', type: 'select', label: 'Deal Stage', options: [{ id: 'o1', label: 'In Review', color: 'teal' }] },
        {
          api_name: 'tags',
          type: 'multi_select',
          label: 'Tags',
          options: [
            { id: 't1', label: 'Urgent', color: 'red' },
            { id: 't2', label: 'VIP', color: 'purple' },
          ],
        },
      ],
      records: {
        data: [{ id: 'r1', title: 'Row 1', number: 1, values: { stage: 'o1', tags: ['t1', 't2'] } }],
        next_cursor: null,
        has_more: false,
      },
    };
  }

  it('renders the real field label in the column header, not a humanized api_name', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, { token: 't1', initialDef: makeDefWithFields(), embed: false }),
    );
    expect(html).toContain('Deal Stage');
    // The old fallback would have humanized the api_name to "Stage" — the
    // real label "Deal Stage" is a different string, so this also proves the
    // label is actually being read rather than happening to match.
    expect(html).not.toContain('>Stage<');
  });

  it('renders a select value through the shared OptionChip, with its real color', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, { token: 't1', initialDef: makeDefWithFields(), embed: false }),
    );
    expect(html).toContain('In Review');
    expect(html.toLowerCase()).toContain('#0d9488'); // teal, from OPTION_COLORS
  });

  it('renders every multi_select value as its own chip', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, { token: 't1', initialDef: makeDefWithFields(), embed: false }),
    );
    expect(html).toContain('Urgent');
    expect(html).toContain('VIP');
  });
});

/**
 * #709 (AC1) — the read-only public board, built to #728's spec: no bare
 * count while pagination is incomplete (B1), hide_empty_groups only once it
 * is complete (B2), and one unlabelled column when the grouping field is
 * unset (B3).
 */
describe('PublicViewClient — #709 board (AC1, B1–B3)', () => {
  const stageField: PublicViewField = {
    api_name: 'stage',
    type: 'select',
    label: 'Stage',
    options: [
      { id: 'todo', label: 'To Do', color: 'gray' },
      { id: 'done', label: 'Done', color: 'green' },
    ],
  };
  function record(id: string, stage: string): PublicRecord {
    return { id, title: `Issue ${id}`, number: Number(id), values: { stage } };
  }
  function boardDef(overrides: Partial<PublicViewDef> = {}): PublicViewDef {
    return {
      view: { id: 'v1', name: 'Roadmap', type: 'board' },
      database: { name: 'Issues' },
      fields: [stageField],
      indexable: false,
      hide_branding: false,
      branding: { logo_url: null, accent_color: null },
      records: { data: [record('1', 'todo'), record('2', 'done')], next_cursor: null, has_more: false },
      board: {
        group_by_field_api_name: 'stage',
        group_by_granularity: null,
        column_sort: null,
        hide_empty_groups: false,
        hide_empty_no_value_group: false,
      },
      ...overrides,
    };
  }

  it('groups records into columns by the option label, one card per record', () => {
    const html = renderToStaticMarkup(createElement(PublicViewClient, { token: 't1', initialDef: boardDef(), embed: false }));
    expect(html).toContain('To Do');
    expect(html).toContain('Done');
    expect(html).toContain('Issue 1');
    expect(html).toContain('Issue 2');
  });

  it('B1: shows a QUALIFIED "N loaded" count, never a bare number, while has_more is true', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: boardDef({ records: { data: [record('1', 'todo')], next_cursor: 'c1', has_more: true } }),
        embed: false,
      }),
    );
    expect(html).toContain('1 loaded');
    // A bare "1" badge (no qualifier) would be the exact defect this spec exists to prevent.
    expect(html).not.toMatch(/>1<\/span>/);
  });

  it('B1: shows a plain count once has_more is false — the loaded set IS the true set', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: boardDef({ records: { data: [record('1', 'todo')], next_cursor: null, has_more: false } }),
        embed: false,
      }),
    );
    expect(html).toContain('>1<');
    expect(html).not.toContain('loaded');
  });

  it('B2: does NOT hide an empty column while has_more is true, even if hide_empty_groups is set', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: boardDef({
          records: { data: [record('1', 'todo')], next_cursor: 'c1', has_more: true },
          board: {
            group_by_field_api_name: 'stage',
            group_by_granularity: null,
            column_sort: null,
            hide_empty_groups: true,
            hide_empty_no_value_group: false,
          },
        }),
        embed: false,
      }),
    );
    // "Done" has zero loaded rows here, but the set isn't complete yet — B2
    // says a column with nothing loaded YET is not the same as an empty one.
    expect(html).toContain('Done');
  });

  it('B2: DOES hide an empty column once has_more is false', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: boardDef({
          records: { data: [record('1', 'todo')], next_cursor: null, has_more: false },
          board: {
            group_by_field_api_name: 'stage',
            group_by_granularity: null,
            column_sort: null,
            hide_empty_groups: true,
            hide_empty_no_value_group: false,
          },
        }),
        embed: false,
      }),
    );
    expect(html).not.toContain('Done');
  });

  it('B3: renders one unlabelled column, not an error, when group_by_field_api_name is null', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: boardDef({
          board: {
            group_by_field_api_name: null,
            group_by_granularity: null,
            column_sort: null,
            hide_empty_groups: false,
            hide_empty_no_value_group: false,
          },
        }),
        embed: false,
      }),
    );
    expect(html).toContain('Issue 1');
    expect(html).toContain('Issue 2');
    // No group label anywhere, and no "grouping unavailable" notice — a
    // stranger has no way to act on that information (B3's own rule).
    expect(html).not.toContain('To Do');
    expect(html).not.toContain('unavailable');
  });

  it('AC3: a card is not a link and has no click affordance — there is no public record page', () => {
    const html = renderToStaticMarkup(createElement(PublicViewClient, { token: 't1', initialDef: boardDef(), embed: false }));
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('onclick');
  });
});

/**
 * #709 (AC2) — the read-only public dashboard, built to #728's spec: null
 * and a real zero must render differently (D1/D2), and a comparison is text
 * only, never an affordance (D3).
 */
describe('PublicViewClient — #709 dashboard (AC2, D1–D3)', () => {
  function dashboardDef(tiles: Array<{ id: string; label: string; op: string; field_api_name: string | null; value: number | null; layout: unknown; comparison: string | null }>): PublicViewDef {
    return {
      view: { id: 'v1', name: 'Overview', type: 'dashboard' },
      database: { name: 'Issues' },
      fields: [],
      indexable: false,
      hide_branding: false,
      branding: { logo_url: null, accent_color: null },
      records: { data: [], next_cursor: null, has_more: false },
      dashboard: { tiles },
    };
  }

  it('D1: renders a null value as "—", never as 0', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: dashboardDef([{ id: 't1', label: 'Avg. days to close', op: 'avg', field_api_name: 'age', value: null, layout: null, comparison: null }]),
        embed: false,
      }),
    );
    expect(html).toContain('Avg. days to close');
    expect(html).toContain('—');
    // A rendered "0" for a null aggregate is exactly the D1 defect: it
    // asserts a fact ("every issue closes the same day it opens") the
    // server explicitly declined to state.
    expect(html).not.toMatch(/>0</);
  });

  it('D2: renders a real 0 as 0, at full weight — not dimmed, not treated as missing', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: dashboardDef([{ id: 't1', label: 'Urgent', op: 'count', field_api_name: null, value: 0, layout: null, comparison: null }]),
        embed: false,
      }),
    );
    expect(html).toContain('Urgent');
    expect(html).toMatch(/>0</);
    // The muted "—" treatment must not also fire for a genuine zero.
    expect(html).not.toContain('text-neutral-300');
  });

  it('D3: renders a comparison as plain text, never as a clickable/arrow affordance', () => {
    const html = renderToStaticMarkup(
      createElement(PublicViewClient, {
        token: 't1',
        initialDef: dashboardDef([{ id: 't1', label: 'Done this week', op: 'count', field_api_name: null, value: 12, layout: null, comparison: '+4 vs last week' }]),
        embed: false,
      }),
    );
    expect(html).toContain('+4 vs last week');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
});
