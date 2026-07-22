import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// icon-picker.tsx pulls OPTION_COLORS from table-view/cells.tsx, which has a
// (pre-existing, unrelated to #251) module-level circular import with
// ui/avatar.tsx that only resolves cleanly under Next's bundler — not under
// Vite/vitest's ESM evaluation order. Stub the one export this file needs so
// the test exercises icon-picker.tsx's own logic without dragging in that
// cycle (or table-view/cells.tsx's `@/lib/api` client, which isn't safe to
// construct outside the app runtime either).
vi.mock('@/components/table-view/cells', () => ({
  OPTION_COLORS: {
    gray: '#B5B0A5',
    brown: '#8B6F47',
    gold: '#D4A017',
    orange: '#D97E36',
    red: '#C0392B',
    pink: '#C05B7E',
    purple: '#7E5BA6',
    blue: '#3D5296',
    teal: '#057160',
    green: '#2D7A4F',
  },
}));

const { EntityIcon, IconColorPicker } = await import('./icon-picker');
const { BRAND_ICON_META } = await import('./icon-set');

/**
 * Real render tests (react-dom/server, no extra test deps needed — jsdom/RTL
 * aren't set up in this repo) for #251's picker and renderer changes:
 * - the picker no longer offers emoji at all (AC: "picker no longer offers
 *   emoji");
 * - EntityIcon still tolerates a raw legacy emoji string rather than
 *   blanking the tile (AC: "renderer tolerates a legacy emoji string").
 */

/** A sample of the pre-#251 picker's emoji vocabulary — none of these should
 * appear anywhere in the picker's rendered output any more. */
const FORMER_PICKER_EMOJI = ['📌', '📋', '✅', '🚀', '💼', '🤝', '👥', '💰'];

describe('IconColorPicker (#251: emoji retired from the picker)', () => {
  const markup = renderToStaticMarkup(
    createElement(IconColorPicker, { icon: null, color: null, onChange: () => {} }),
  );

  it('never renders any former picker emoji character', () => {
    for (const emoji of FORMER_PICKER_EMOJI) {
      expect(markup.includes(emoji), `unexpected "${emoji}" in picker markup`).toBe(false);
    }
  });

  it('has no Emoji tab/mode toggle', () => {
    expect(markup).not.toMatch(/>emoji</i);
    expect(markup).not.toContain('Search emoji');
  });

  it('still renders the icon-only search and category chips', () => {
    expect(markup).toContain('Search icons');
    expect(markup).toContain('Work');
    expect(markup).toContain('Status');
  });

  it('still offers the background colour palette', () => {
    expect(markup).toContain('Background');
  });

  it('offers a Brands chip alongside the curated categories (#298)', () => {
    expect(markup).toContain('Brands');
  });
});

describe('brand icon search data (#298: same search box matches slug + keywords)', () => {
  it('a slug substring matches its own entry, mirroring the picker\'s own filter (d.slug.includes(q))', () => {
    const q = 'git';
    const hits = BRAND_ICON_META.filter((d) => d.slug.includes(q) || d.keywords.includes(q));
    expect(hits.map((d) => d.slug)).toEqual(expect.arrayContaining(['github', 'gitlab']));
  });

  it('the X/Twitter entry is findable by both "x" and "twitter" (ticket-specified example)', () => {
    const bySlug = BRAND_ICON_META.find((d) => d.slug === 'x-twitter')!;
    expect(bySlug).toBeTruthy();
    expect(bySlug.slug.includes('x')).toBe(true);
    expect(bySlug.keywords.includes('twitter')).toBe(true);
  });

  it('includes the two hand-recreated StoryOS-sibling products', () => {
    const slugs = BRAND_ICON_META.map((d) => d.slug);
    expect(slugs).toContain('storyfunnels');
    expect(slugs).toContain('storypages');
  });

  it('has no duplicate slugs', () => {
    const slugs = BRAND_ICON_META.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('EntityIcon brand rendering (#298)', () => {
  it('renders a brand: ref as an <img> pointing at its vendored SVG, not as text', () => {
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, { icon: 'brand:github', color: null, fallback: null }),
    );
    expect(markup).toContain('<img');
    expect(markup).toContain('/brand-icons/github.svg');
    expect(markup).not.toContain('brand:github');
  });

  it('an unrecognized brand: slug renders the fallback, never the raw "brand:slug" string as text', () => {
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, {
        icon: 'brand:this-slug-does-not-exist',
        color: null,
        fallback: createElement('span', { className: 'the-fallback' }, 'FB'),
      }),
    );
    expect(markup).not.toContain('brand:this-slug-does-not-exist');
    expect(markup).toContain('the-fallback');
  });
});

describe('EntityIcon (#251 back-compat: tolerate a legacy emoji string)', () => {
  it('renders a raw emoji value literally instead of going blank', () => {
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, { icon: '🚀', color: null, fallback: null }),
    );
    expect(markup).toContain('🚀');
  });

  it('renders a set: ref as an SVG icon, not as text', () => {
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, { icon: 'set:rocket', color: null, fallback: null }),
    );
    expect(markup).toContain('<svg');
    expect(markup).not.toContain('set:rocket');
  });

  it('falls back to the provided fallback when there is no icon at all', () => {
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, {
        icon: null,
        color: null,
        fallback: createElement('span', { className: 'the-fallback' }, 'FB'),
      }),
    );
    expect(markup).toContain('the-fallback');
    expect(markup).toContain('FB');
  });

  it('an unrecognized set: name renders the fallback, never the raw "set:name" string as text', () => {
    // setIconName() rejects an unrecognized `set:` suffix (e.g. stale data
    // referencing a curated name that was renamed/removed). That string was
    // never meant to be human-visible — printing it literally (as this branch
    // once did) put "set:video" next to "Videos" in the sidebar. isSetIconRef()
    // distinguishes this case from a genuine legacy emoji glyph, which SHOULD
    // still render literally (see the raw-emoji test above).
    const markup = renderToStaticMarkup(
      createElement(EntityIcon, {
        icon: 'set:this-name-does-not-exist',
        color: null,
        fallback: createElement('span', { className: 'the-fallback' }, 'FB'),
      }),
    );
    expect(markup).not.toContain('set:this-name-does-not-exist');
    expect(markup).toContain('the-fallback');
  });
});
