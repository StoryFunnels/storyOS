import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { CellDisplay } from './cells';
import { aiFieldState, aiStateSpeaks, recordHasPendingAi } from '@/lib/ai-field-state';
import { AI_PENDING_STALE_MS } from '@storyos/schemas';
import type { Field } from './use-table-data';

/**
 * Ticket #620 — an AI field's states are drawn from what the API reports: `<id>:error` (failed), `<id>:computed_at`
 * (computed) and, since #925, `<id>:pending_at` (computing), asserted on the rendered cell. Nothing is inferred.
 */
const FIELD_ID = 'f-ai';
const ai = { id: FIELD_ID, apiName: 'summary', displayName: 'Summary', type: 'ai', config: {}, isSystem: false } as unknown as Field;

function render(value: unknown, computed: Record<string, unknown>) {
  const state = aiFieldState({ computed_values: computed }, FIELD_ID);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(CellDisplay, { field: ai, value, aiState: state, memberNames: new Map() }),
    ),
  );
}

describe('aiFieldState reads only what the API reports', () => {
  it('error wins; computed_at alone is computed; nothing is none; an empty error string is no error', () => {
    expect(aiFieldState({ computed_values: { [`${FIELD_ID}:error`]: 'rate limited', [`${FIELD_ID}:computed_at`]: '2026-10-15T10:00:00Z' } }, FIELD_ID)).toEqual({
      kind: 'failed', reason: 'rate limited', computedAt: '2026-10-15T10:00:00Z',
    });
    expect(aiFieldState({ computed_values: { [`${FIELD_ID}:computed_at`]: '2026-10-15T10:00:00Z', [`${FIELD_ID}:error`]: null } }, FIELD_ID).kind).toBe('computed');
    expect(aiFieldState({ computed_values: {} }, FIELD_ID).kind).toBe('none');
    expect(aiFieldState(undefined, FIELD_ID).kind).toBe('none');
    expect(aiFieldState({ computed_values: { [`${FIELD_ID}:error`]: '   ' } }, FIELD_ID).kind).toBe('none');
  });

  it("another field's error is not this field's", () => {
    expect(aiFieldState({ computed_values: { 'other:error': 'boom' } }, FIELD_ID).kind).toBe('none');
  });
});

describe('an AI field cell (#620)', () => {
  it('failed WITH a last good value: the value is shown dimmed AND the reason is on screen', () => {
    const html = render('A neat summary', { [`${FIELD_ID}:error`]: 'Model request timed out' });
    expect(html).toContain('data-ai-state="failed"');
    expect(html).toContain('A neat summary');
    expect(html).toContain('opacity-60');
    expect(html).toContain('Out of date: Model request timed out');
  });

  it('failed with NO value yet: not a blank cell, the reason is shown', () => {
    const html = render(null, { [`${FIELD_ID}:error`]: 'Prompt could not be rendered' });
    expect(html).toContain('Failed: Prompt could not be rendered');
    expect(html).not.toContain('opacity-60');
  });

  it('computed: a normal value, no failure marker', () => {
    const html = render('Fine', { [`${FIELD_ID}:computed_at`]: '2026-10-15T10:00:00Z', [`${FIELD_ID}:error`]: null });
    expect(html).toContain('Fine');
    expect(html).not.toContain('data-ai-state');
    expect(html).not.toContain('Failed');
  });

  it('other field types are unaffected by an aiState', () => {
    const text = { ...ai, type: 'text' } as unknown as Field;
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CellDisplay, { field: text, value: 'plain', aiState: { kind: 'failed', reason: 'x', computedAt: null }, memberNames: new Map() }),
      ),
    );
    expect(html).toContain('plain');
    expect(html).not.toContain('data-ai-state');
  });
});

describe('the computing state (#620 / #925)', () => {
  const NOW = Date.parse('2026-10-21T12:00:00Z');
  const fresh = new Date(NOW - 10_000).toISOString();
  const stale = new Date(NOW - AI_PENDING_STALE_MS - 1000).toISOString();
  const state = (computed: Record<string, unknown>) => aiFieldState({ computed_values: computed }, FIELD_ID, NOW);

  it('a fresh :pending_at marker is computing, and it wins over a failure and a computed stamp while it lasts', () => {
    expect(state({ [`${FIELD_ID}:pending_at`]: fresh })).toEqual({ kind: 'computing', since: fresh });
    expect(state({ [`${FIELD_ID}:pending_at`]: fresh, [`${FIELD_ID}:error`]: 'boom', [`${FIELD_ID}:computed_at`]: '2026-10-15T10:00:00Z' }).kind).toBe('computing');
  });

  it('a marker older than five minutes is NOT computing (a dead worker must not read as "computing" for ever)', () => {
    expect(state({ [`${FIELD_ID}:pending_at`]: stale }).kind).toBe('none');
    expect(state({ [`${FIELD_ID}:pending_at`]: stale, [`${FIELD_ID}:error`]: 'boom' }).kind).toBe('failed');
  });

  it('never inferred: an empty value, or a computed_at older than the edit, is not computing without the marker', () => {
    expect(state({}).kind).toBe('none');
    expect(state({ [`${FIELD_ID}:computed_at`]: '2020-01-01T00:00:00Z' }).kind).toBe('computed');
    expect(state({ [`${FIELD_ID}:pending_at`]: 'not a date' }).kind).toBe('none');
  });

  it("another field's marker is not this field's", () => {
    expect(state({ 'other:pending_at': fresh }).kind).toBe('none');
  });

  it('computing WITH a last good value: the value stays, dimmed, with "Computing…" beside it', () => {
    const html = render('A neat summary', { [`${FIELD_ID}:pending_at`]: new Date().toISOString() });
    expect(html).toContain('data-ai-state="computing"');
    expect(html).toContain('A neat summary');
    expect(html).toContain('opacity-60');
    expect(html).toContain('Computing…');
  });

  it('computing with NO value says "Computing…" and is never a blank cell', () => {
    const html = render(null, { [`${FIELD_ID}:pending_at`]: new Date().toISOString() });
    expect(html).toContain('data-ai-state="computing"');
    expect(html).toContain('Computing…');
  });

  it('the spinner is motion-safe, so reduced motion still gets the words', () => {
    expect(render(null, { [`${FIELD_ID}:pending_at`]: new Date().toISOString() })).toContain('motion-safe:animate-spin');
  });

  it('computing is distinct from failed and computed in the DOM', () => {
    const pending = new Date().toISOString();
    expect(render('v', { [`${FIELD_ID}:pending_at`]: pending })).not.toContain('data-ai-state="failed"');
    expect(render('v', { [`${FIELD_ID}:error`]: 'x' })).not.toContain('data-ai-state="computing"');
  });

  it('failed and computing both speak with no value; computed and none do not', () => {
    expect(aiStateSpeaks({ kind: 'computing', since: fresh })).toBe(true);
    expect(aiStateSpeaks({ kind: 'failed', reason: 'x', computedAt: null })).toBe(true);
    expect(aiStateSpeaks({ kind: 'computed', computedAt: fresh })).toBe(false);
    expect(aiStateSpeaks({ kind: 'none' })).toBe(false);
    expect(aiStateSpeaks(undefined)).toBe(false);
  });

  it('polling runs only while some AI field has a FRESH marker, on any field of the record', () => {
    expect(recordHasPendingAi({ computed_values: { 'a:pending_at': fresh, 'b:pending_at': stale } }, NOW)).toBe(true);
    expect(recordHasPendingAi({ computed_values: { 'a:pending_at': stale } }, NOW)).toBe(false);
    expect(recordHasPendingAi({ computed_values: { a: 'value', 'a:computed_at': fresh } }, NOW)).toBe(false);
    expect(recordHasPendingAi({}, NOW)).toBe(false);
    expect(recordHasPendingAi(undefined, NOW)).toBe(false);
  });
});
