import { describe, expect, it } from 'vitest';
import {
  NUMBER_SYSTEM_FIELD_ID,
  countHiddenFields,
  isFieldVisible,
  isNumberColumnHidden,
  toggleFieldVisibility,
} from './number-column';

/**
 * #743 — the record number is visible by default, using the SAME ordinary
 * present-means-hidden semantics as every other entry in a view's
 * `hidden_field_ids`. Pinned here so table-view.tsx's gutter and
 * view-toolbar.tsx's Hide-fields picker can't independently drift onto
 * different readings of the same array.
 */

describe('isNumberColumnHidden', () => {
  it('defaults to visible when the synthetic id is absent', () => {
    expect(isNumberColumnHidden([])).toBe(false);
    expect(isNumberColumnHidden(undefined)).toBe(false);
  });

  it('is hidden once the synthetic id is explicitly present', () => {
    expect(isNumberColumnHidden([NUMBER_SYSTEM_FIELD_ID])).toBe(true);
  });

  it('a REAL number field row uses the same ordinary semantics, default visible', () => {
    const realId = 'a-real-field-uuid';
    expect(isNumberColumnHidden([], realId)).toBe(false);
    expect(isNumberColumnHidden([realId], realId)).toBe(true);
    // The synthetic id in the array is irrelevant once a real row exists.
    expect(isNumberColumnHidden([NUMBER_SYSTEM_FIELD_ID], realId)).toBe(false);
  });
});

describe('isFieldVisible / toggleFieldVisibility — the Hide-fields picker', () => {
  it('an ordinary field is visible unless present in hidden', () => {
    expect(isFieldVisible([], 'field-a')).toBe(true);
    expect(isFieldVisible(['field-a'], 'field-a')).toBe(false);
  });

  it('the number entry follows the exact same rule — visible unless present', () => {
    expect(isFieldVisible([], NUMBER_SYSTEM_FIELD_ID)).toBe(true);
    expect(isFieldVisible([NUMBER_SYSTEM_FIELD_ID], NUMBER_SYSTEM_FIELD_ID)).toBe(false);
  });

  it('toggling an ordinary field off adds it, on removes it', () => {
    expect(toggleFieldVisibility([], 'field-a', false)).toEqual(['field-a']);
    expect(toggleFieldVisibility(['field-a'], 'field-a', true)).toEqual([]);
  });

  it('toggling the number field follows the same rule — off adds it, on removes it', () => {
    expect(toggleFieldVisibility([], NUMBER_SYSTEM_FIELD_ID, false)).toEqual([NUMBER_SYSTEM_FIELD_ID]);
    expect(toggleFieldVisibility([NUMBER_SYSTEM_FIELD_ID], NUMBER_SYSTEM_FIELD_ID, true)).toEqual([]);
  });

  it('toggling the number field never disturbs other hidden entries', () => {
    const hidden = ['field-a', 'field-b'];
    expect(toggleFieldVisibility(hidden, NUMBER_SYSTEM_FIELD_ID, false).sort()).toEqual(
      ['field-a', 'field-b', NUMBER_SYSTEM_FIELD_ID].sort(),
    );
  });
});

describe('countHiddenFields — the picker\'s "N hidden" trigger label', () => {
  it('counts ordinary hidden fields normally', () => {
    expect(countHiddenFields(['a', 'b'], new Set(['a', 'b', 'c']))).toBe(2);
  });

  it('counts the number entry the same way as any other candidate', () => {
    const candidates = new Set(['a', NUMBER_SYSTEM_FIELD_ID]);
    expect(countHiddenFields(['a', NUMBER_SYSTEM_FIELD_ID], candidates)).toBe(2);
  });

  it('does not count the number field when it is absent (the new default: shown)', () => {
    const candidates = new Set(['a', NUMBER_SYSTEM_FIELD_ID]);
    expect(countHiddenFields([], candidates)).toBe(0);
  });

  it('never counts the number field when it is not a candidate (a real number field row exists)', () => {
    const candidates = new Set(['a']);
    expect(countHiddenFields([NUMBER_SYSTEM_FIELD_ID], candidates)).toBe(0);
  });
});
