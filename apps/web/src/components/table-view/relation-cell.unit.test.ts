import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// relation-cell.tsx imports the real API client (@/lib/api) at module scope for
// RelationEditor's fetch/mutation hooks — not needed by (and not safe to
// construct outside the app runtime for, see icon-picker.unit.test.ts) the two
// presentational exports under test here, RelationChip/RelationChips. Stub it
// so the module loads under vitest's plain-node ESM evaluation.
vi.mock('@/lib/api', () => ({ api: {}, apiErrorMessage: () => '' }));

const {
  RelationChip,
  RelationChips,
  SelectedRelationChip,
  DbColorMarker,
  patchRelationProjection,
} = await import('./relation-cell');

describe('#310 relation cache projections', () => {
  const chips = [{ id: 'linked-1', title: 'Linked now' }];

  it('patches a record-detail projection by the row UUID, independent of its query-key slug', () => {
    const old = { id: 'record-uuid', title: 'Source', values: { related: [] } };
    expect(patchRelationProjection(old, 'record-uuid', 'related', chips)).toEqual({
      ...old,
      values: { related: chips },
    });
  });

  it('patches the same relation in every records-list projection', () => {
    const other = { id: 'other', title: 'Other', values: { related: [] } };
    const source = { id: 'record-uuid', title: 'Source', values: { related: [] } };
    const old = { pages: [{ data: [source, other] }], pageParams: [null] };
    const next = patchRelationProjection(old, 'record-uuid', 'related', chips) as typeof old;
    expect(next.pages[0]!.data[0]!.values.related).toEqual(chips);
    expect(next.pages[0]!.data[1]).toBe(other);
  });
});

/**
 * #293: relation chips had no way to open the linked record — only ever a
 * remove (×) affordance, and only inside the picker popover (the "main cell
 * display" render path, RelationChips/RelationChip, had no button at all —
 * verified by reading the pre-fix source; the ticket's claim that the main
 * display also rendered a × turned out not to match the code). These are
 * static-render structural checks (react-dom/server; no jsdom/RTL in this
 * repo, per vitest.config.ts) — they assert on the markup a browser would
 * receive, not on simulated click events.
 */

describe('RelationChip (#293 click-to-open)', () => {
  it('renders a link to the record page when href is given', () => {
    const markup = renderToStaticMarkup(createElement(RelationChip, { title: 'Q3 Launch', href: '/w/acme/d/db-1/r/q3-launch-42' }));
    expect(markup).toContain('href="/w/acme/d/db-1/r/q3-launch-42"');
    expect(markup).toContain('target="_blank"');
    // rel="noreferrer" — a new-tab link to another workspace page shouldn't
    // leak a referrer or grant the opened tab a handle back to this one.
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('Q3 Launch');
  });

  it('renders a plain, non-interactive span when no href is given (unchanged call sites)', () => {
    const markup = renderToStaticMarkup(createElement(RelationChip, { title: 'Q3 Launch' }));
    expect(markup).not.toContain('<a ');
    expect(markup).toContain('Q3 Launch');
  });

  it('falls back to "Untitled" for a chip with a blank title, same as before', () => {
    const markup = renderToStaticMarkup(createElement(RelationChip, { title: '', href: '/w/acme/d/db-1/r/x' }));
    expect(markup).toContain('Untitled');
  });
});

describe('RelationChips (#293: builds each chip\'s link from ws + targetDb + the chip itself)', () => {
  const chips = [
    { id: 'rec-1', title: 'Alpha', number: 1 },
    { id: 'rec-2', title: 'Beta', number: 2 },
  ];

  it('links every shown chip to its own record page — same recordHref helper the record page itself uses', () => {
    const markup = renderToStaticMarkup(
      createElement(RelationChips, { chips, ws: 'acme', targetDb: 'db-blocked-by' }),
    );
    expect(markup).toContain('href="/w/acme/d/db-blocked-by/r/alpha-1"');
    expect(markup).toContain('href="/w/acme/d/db-blocked-by/r/beta-2"');
  });

  it('renders no links at all when ws/targetDb are omitted (every pre-#293 call site)', () => {
    const markup = renderToStaticMarkup(createElement(RelationChips, { chips }));
    expect(markup).not.toContain('<a ');
    expect(markup).toContain('Alpha');
    expect(markup).toContain('Beta');
  });

  it('the "+N" overflow pill is untouched by the link change (never itself a link)', () => {
    const many = [...chips, { id: 'rec-3', title: 'Gamma', number: 3 }, { id: 'rec-4', title: 'Delta', number: 4 }];
    const markup = renderToStaticMarkup(
      createElement(RelationChips, { chips: many, max: 2, ws: 'acme', targetDb: 'db-blocked-by' }),
    );
    expect(markup).toContain('+2');
  });
});

describe('DbColorMarker (MN-299: the shared cylinder marker every chip render site reuses)', () => {
  it('renders an svg filled with the palette hex for a known color name', () => {
    const markup = renderToStaticMarkup(createElement(DbColorMarker, { color: 'blue' }));
    expect(markup).toContain('<svg');
    expect(markup).toContain('#3D5296'); // blue, same hex as cells.tsx's OPTION_COLORS
  });

  it('falls back to the gray hex for an unrecognized color name', () => {
    const markup = renderToStaticMarkup(createElement(DbColorMarker, { color: 'not-a-real-color' }));
    expect(markup).toContain('#B5B0A5'); // gray
  });

  it('renders nothing when color is null/undefined (no marker for chips with no known target color)', () => {
    expect(renderToStaticMarkup(createElement(DbColorMarker, { color: null }))).toBe('');
    expect(renderToStaticMarkup(createElement(DbColorMarker, {}))).toBe('');
  });
});

describe('RelationChip/RelationChips/SelectedRelationChip forward color to DbColorMarker (MN-299)', () => {
  it('RelationChip renders the marker before the title when a color is given', () => {
    const markup = renderToStaticMarkup(createElement(RelationChip, { title: 'Q3 Launch', color: 'red' }));
    expect(markup).toContain('#C0392B'); // red
    expect(markup.indexOf('#C0392B')).toBeLessThan(markup.indexOf('Q3 Launch'));
  });

  it('RelationChips forwards one color to every chip (all chips share the same target database)', () => {
    const chips = [
      { id: 'rec-1', title: 'Alpha', number: 1 },
      { id: 'rec-2', title: 'Beta', number: 2 },
    ];
    const markup = renderToStaticMarkup(createElement(RelationChips, { chips, color: 'teal' }));
    expect(markup.split('<svg').length - 1).toBe(2); // one marker per chip
    expect(markup).toContain('#057160'); // teal
  });

  it('SelectedRelationChip renders the marker alongside the × button', () => {
    const chip = { id: 'rec-1', title: 'Alpha', number: 1 };
    const markup = renderToStaticMarkup(
      createElement(SelectedRelationChip, { chip, ws: 'acme', targetDb: 'db-blocked-by', onRemove: () => {}, color: 'purple' }),
    );
    expect(markup).toContain('#7E5BA6'); // purple
    expect(markup).toContain('<button');
  });
});

describe('SelectedRelationChip (#293: the picker\'s "selected" row — the only place a × ever existed)', () => {
  const chip = { id: 'rec-1', title: 'Alpha', number: 1 };

  it('links to the record page and preserves the × remove button, as two siblings', () => {
    const markup = renderToStaticMarkup(
      createElement(SelectedRelationChip, { chip, ws: 'acme', targetDb: 'db-blocked-by', onRemove: () => {} }),
    );
    expect(markup).toContain('href="/w/acme/d/db-blocked-by/r/alpha-1"');
    expect(markup).toContain('<button');
  });

  it('the × button is a sibling of the link, never nested inside it — a click on one can never structurally reach the other', () => {
    const markup = renderToStaticMarkup(
      createElement(SelectedRelationChip, { chip, ws: 'acme', targetDb: 'db-blocked-by', onRemove: () => {} }),
    );
    // The <a> for this chip's link closes (</a>) before the <button> for its ×
    // opens — i.e. they're siblings under the same wrapping <span>, not one
    // nested inside the other.
    const aClose = markup.indexOf('</a>');
    const buttonOpen = markup.indexOf('<button');
    expect(aClose).toBeGreaterThan(-1);
    expect(buttonOpen).toBeGreaterThan(aClose);
  });
});
