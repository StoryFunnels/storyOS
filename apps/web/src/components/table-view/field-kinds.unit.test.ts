import { describe, expect, it } from 'vitest';
import { OPTIONED_TYPES, SINGLE_OPTION_TYPES, isOptioned, isSingleOption } from './field-kinds';

/**
 * #311 — the regression guard for a bug that shipped FIVE times.
 *
 * `workflow` (State/Status) is select-shaped, but it was added in #172 long after the
 * `select` allowlists were written, so surface after surface silently omitted it:
 * filter/sort/colour pickers (#267), the Fields picker (#272), the List group-by, the
 * collection-section columns, colour-by, paste, lookup targets and form fields.
 *
 * Every one was the same one-word omission. These tests fail if anyone rebuilds a
 * family that forgets it.
 */
describe('field kinds — workflow is select-shaped, always', () => {
  it('treats workflow as a single-option field, like select', () => {
    expect(isSingleOption({ type: 'select' })).toBe(true);
    expect(isSingleOption({ type: 'workflow' })).toBe(true);
  });

  it('does NOT treat multi_select as single-option — one card, one column', () => {
    expect(isSingleOption({ type: 'multi_select' })).toBe(false);
  });

  it('counts all three option-backed types as optioned', () => {
    for (const t of ['select', 'workflow', 'multi_select']) {
      expect(isOptioned({ type: t }), `${t} is option-backed`).toBe(true);
    }
  });

  it('rejects everything that is not option-backed', () => {
    for (const t of ['text', 'number', 'date', 'checkbox', 'user', 'relation', 'formula', 'rollup']) {
      expect(isOptioned({ type: t }), `${t} is not option-backed`).toBe(false);
      expect(isSingleOption({ type: t })).toBe(false);
    }
  });

  it('keeps the two sets in the documented relationship', () => {
    // Every single-option type is optioned; optioned adds exactly multi_select.
    for (const t of SINGLE_OPTION_TYPES) expect(OPTIONED_TYPES.has(t)).toBe(true);
    expect([...OPTIONED_TYPES].filter((t) => !SINGLE_OPTION_TYPES.has(t))).toEqual(['multi_select']);
  });

  it('both sets contain workflow — the omission that caused #267, #272 and #311', () => {
    expect(SINGLE_OPTION_TYPES.has('workflow')).toBe(true);
    expect(OPTIONED_TYPES.has('workflow')).toBe(true);
  });
});
