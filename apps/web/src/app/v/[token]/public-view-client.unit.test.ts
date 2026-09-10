import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicViewClient } from './public-view-client';
import type { PublicViewDef } from './public-view-client';

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
