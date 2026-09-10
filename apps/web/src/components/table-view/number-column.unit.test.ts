import { describe, expect, it } from 'vitest';
import {
  NUMBER_SYSTEM_FIELD_ID,
  countHiddenFields,
  isFieldVisible,
  isNumberColumnHidden,
  toggleFieldVisibility,
} from './number-column';

/**
 * #659/#289 — the one entry in a view's `hidden_field_ids` whose polarity is
 * inverted (number defaults to hidden now, so presence means shown). Pinned
 * here so table-view.tsx's gutter and view-toolbar.tsx's Hide-fields picker
 * can't independently drift onto different readings of the same array.
 */

describe('isNumberColumnHidden', () => {
  it('defaults to hidden when the synthetic id is absent', () => {
    expect(isNumberColumnHidden([])).toBe(true);
    expect(isNumberColumnHidden(undefined)).toBe(true);
  });

  it('is shown once the synthetic id is explicitly present', () => {
    expect(isNumberColumnHidden([NUMBER_SYSTEM_FIELD_ID])).toBe(false);
  });

  it('a REAL number field row uses ordinary present-means-hidden semantics, default visible', () => {
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

  it('the number entry is visible ONLY when present in hidden (inverted)', () => {
    expect(isFieldVisible([], NUMBER_SYSTEM_FIELD_ID)).toBe(false);
    expect(isFieldVisible([NUMBER_SYSTEM_FIELD_ID], NUMBER_SYSTEM_FIELD_ID)).toBe(true);
  });

  it('toggling an ordinary field off adds it, on removes it', () => {
    expect(toggleFieldVisibility([], 'field-a', false)).toEqual(['field-a']);
    expect(toggleFieldVisibility(['field-a'], 'field-a', true)).toEqual([]);
  });

  it('toggling the number field ON adds it, OFF removes it — opposite of every other field', () => {
    expect(toggleFieldVisibility([], NUMBER_SYSTEM_FIELD_ID, true)).toEqual([NUMBER_SYSTEM_FIELD_ID]);
    expect(toggleFieldVisibility([NUMBER_SYSTEM_FIELD_ID], NUMBER_SYSTEM_FIELD_ID, false)).toEqual([]);
  });

  it('toggling the number field never disturbs other hidden entries', () => {
    const hidden = ['field-a', 'field-b'];
    expect(toggleFieldVisibility(hidden, NUMBER_SYSTEM_FIELD_ID, true).sort()).toEqual(
      ['field-a', 'field-b', NUMBER_SYSTEM_FIELD_ID].sort(),
    );
  });
});

describe('countHiddenFields — the picker\'s "N hidden" trigger label', () => {
  it('counts ordinary hidden fields normally', () => {
    expect(countHiddenFields(['a', 'b'], new Set(['a', 'b', 'c']))).toBe(2);
  });

  it('does not count the number entry\'s presence as a hidden field (it means shown)', () => {
    const candidates = new Set(['a', NUMBER_SYSTEM_FIELD_ID]);
    expect(countHiddenFields(['a', NUMBER_SYSTEM_FIELD_ID], candidates)).toBe(1);
  });

  it('counts the number field as hidden when it is a candidate and absent (the new default)', () => {
    const candidates = new Set(['a', NUMBER_SYSTEM_FIELD_ID]);
    expect(countHiddenFields([], candidates)).toBe(1);
  });

  it('never counts the number field when it is not a candidate (a real number field row exists)', () => {
    const candidates = new Set(['a']);
    expect(countHiddenFields([], candidates)).toBe(0);
  });
});
