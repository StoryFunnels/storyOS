import { describe, expect, it } from 'vitest';
import { looksLikeFilterError, queryErrorMessage } from './query-error';

/**
 * #346 — a failed records query used to render as an empty grid, so "your filter
 * was rejected" and "you have no records" looked identical. The API is careful to
 * keep those apart (records.service.ts errors rather than returning an empty page,
 * precisely so nobody conflates them); the UI threw that distinction away at the
 * last step.
 *
 * These pin the part with real logic: pulling the useful sentence out of whatever
 * shape the failure arrives in, and recognising a filter failure so the message can
 * point at the fix.
 */
describe('queryErrorMessage (#346)', () => {
  it('reads the API envelope thrown verbatim by the query hooks', () => {
    // The exact 422 that made every record disappear in #345.
    const err = {
      error: {
        code: 'validation_failed',
        message: 'op "has_none" on "status" expects a non-empty array of ids',
        request_id: 'req-1x',
      },
    };
    expect(queryErrorMessage(err)).toBe('op "has_none" on "status" expects a non-empty array of ids');
  });

  it('reads a bare { message } and a real Error', () => {
    expect(queryErrorMessage({ message: 'Internal server error' })).toBe('Internal server error');
    expect(queryErrorMessage(new Error('Failed to fetch'))).toBe('Failed to fetch');
  });

  it('reads a plain string', () => {
    expect(queryErrorMessage('boom')).toBe('boom');
  });

  it('returns null when there is genuinely nothing to say', () => {
    // Must be null, not '' — the component decides whether to render the line, and
    // an empty <p> reads as a rendering bug.
    expect(queryErrorMessage(null)).toBeNull();
    expect(queryErrorMessage(undefined)).toBeNull();
    expect(queryErrorMessage({})).toBeNull();
    expect(queryErrorMessage({ error: {} })).toBeNull();
    expect(queryErrorMessage({ message: '   ' })).toBeNull();
  });

  it('prefers the API envelope over an outer message', () => {
    // openapi-fetch style: the envelope carries the specific reason, the outer
    // message is usually a generic "Unprocessable Entity".
    const err = { message: 'Unprocessable Entity', error: { message: 'filter nesting exceeds 3 levels' } };
    expect(queryErrorMessage(err)).toBe('filter nesting exceeds 3 levels');
  });
});

describe('looksLikeFilterError (#346)', () => {
  it('recognises the compiler rejections a user can actually fix', () => {
    expect(looksLikeFilterError({ error: { message: 'op "has_none" on "status" expects a non-empty array of ids' } })).toBe(true);
    expect(looksLikeFilterError({ error: { message: 'op "contains" not valid for date' } })).toBe(true);
    expect(looksLikeFilterError({ error: { message: 'filter nesting exceeds 3 levels' } })).toBe(true);
  });

  it('does NOT blame the filter for an unrelated failure', () => {
    // Telling someone to fix their filter when the API is down wastes their time
    // on the wrong thing.
    expect(looksLikeFilterError({ message: 'Failed to fetch' })).toBe(false);
    expect(looksLikeFilterError({ error: { message: 'Internal server error' } })).toBe(false);
    expect(looksLikeFilterError(null)).toBe(false);
  });
});

/**
 * The AC in its own words: "a rejected query renders the error state and NOT the
 * empty state". Rendered with `renderToStaticMarkup`, the same bare-render
 * approach `public-form-smoke.unit.test.ts` uses.
 */
describe('ViewQueryError renders an error, never an empty view (#346)', () => {
  async function render(error: unknown) {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { ViewQueryError } = await import('./query-error');
    return renderToStaticMarkup(createElement(ViewQueryError, { error }));
  }

  it('says the view failed and shows the API reason', async () => {
    const html = await render({ error: { message: 'op "has_none" on "status" expects a non-empty array of ids' } });
    expect(html).toContain('couldn');
    expect(html).toContain('expects a non-empty array of ids');
    expect(html).toContain('role="alert"');
  });

  it('never uses empty-state wording — that conflation IS the bug', async () => {
    const html = await render({ error: { message: 'op "has_none" on "status" expects a non-empty array of ids' } });
    expect(html.toLowerCase()).not.toContain('no records');
    expect(html.toLowerCase()).not.toContain('nothing here');
    // And it says the data is fine, because "empty grid" taught users otherwise.
    expect(html).toContain('records are safe');
  });

  it('points at the filter when the filter is the cause', async () => {
    const html = await render({ error: { message: 'op "contains" not valid for date' } });
    expect(html).toContain('filter');
  });

  it('does NOT blame the filter for an unrelated failure', async () => {
    const html = await render(new Error('Failed to fetch'));
    expect(html).toContain('Failed to fetch');
    expect(html).not.toContain('Adjust or remove the filter');
  });
});
