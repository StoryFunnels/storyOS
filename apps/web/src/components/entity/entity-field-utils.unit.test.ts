import { describe, expect, it } from 'vitest';
import { NOT_INLINE, computedBadgeLabel } from './entity-field-utils';

/**
 * #776 — a computed field must never get the ordinary click-to-edit
 * affordance: it lies about being writable, and for `ai` specifically a write
 * attempt errors server-side (record-values.ts's `coerce()` has no case for
 * it). `ai` was added (#571) after this set was written and missed it.
 */
describe('NOT_INLINE', () => {
  it('rejects every computed field type', () => {
    expect(NOT_INLINE.has('lookup')).toBe(true);
    expect(NOT_INLINE.has('rollup')).toBe(true);
    expect(NOT_INLINE.has('formula')).toBe(true);
    expect(NOT_INLINE.has('button')).toBe(true);
    expect(NOT_INLINE.has('ai')).toBe(true);
  });

  it('keeps the audit fields it already covered', () => {
    expect(NOT_INLINE.has('created_at')).toBe(true);
    expect(NOT_INLINE.has('updated_at')).toBe(true);
    expect(NOT_INLINE.has('created_by')).toBe(true);
  });

  it('still allows a real typed field to inline-edit', () => {
    expect(NOT_INLINE.has('text')).toBe(false);
    expect(NOT_INLINE.has('number')).toBe(false);
    expect(NOT_INLINE.has('select')).toBe(false);
  });
});

describe('computedBadgeLabel (#811)', () => {
  it('badges the derived types, which is where the badge carries information', () => {
    expect(computedBadgeLabel('formula')).toBe('formula');
    expect(computedBadgeLabel('rollup')).toBe('rollup');
    expect(computedBadgeLabel('lookup')).toBe('lookup');
    expect(computedBadgeLabel('ai')).toBe('ai');
  });

  it('badges the audit fields as "system"', () => {
    expect(computedBadgeLabel('created_at')).toBe('system');
    expect(computedBadgeLabel('updated_at')).toBe('system');
    expect(computedBadgeLabel('created_by')).toBe('system');
  });

  it('does NOT badge a button: it holds no derived value and labels itself', () => {
    expect(computedBadgeLabel('button')).toBeNull();
  });

  it('does not badge an ordinary editable field', () => {
    for (const t of ['text', 'number', 'select', 'checkbox', 'relation', 'color']) {
      expect(computedBadgeLabel(t), t).toBeNull();
    }
  });
});
