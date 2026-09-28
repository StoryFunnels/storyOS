import { describe, expect, it } from 'vitest';
import { NOT_INLINE } from './entity-field-utils';

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
