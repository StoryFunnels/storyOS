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
