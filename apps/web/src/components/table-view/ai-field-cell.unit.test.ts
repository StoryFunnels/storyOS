import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { CellDisplay } from './cells';
import { aiFieldState } from '@/lib/ai-field-state';
import type { Field } from './use-table-data';

/**
 * Ticket #620 — an AI field's failed state is drawn from what the API reports (`<id>:error`), asserted on
 * the rendered cell. There is deliberately no "computing" case: the API does not report one.
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
