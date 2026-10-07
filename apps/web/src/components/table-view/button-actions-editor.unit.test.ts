import { describe, expect, it } from 'vitest';
import { initialSetValue, settableFieldsForSetValues } from './button-actions-editor';
import type { Field } from './use-table-data';

function field(type: string, isSystem = false): Field {
  return { id: type, apiName: type, displayName: type, type, config: {}, isSystem };
}

/**
 * #729 — the picker used to exclude `title` and `relation` outright, even
 * though the API already accepts both. This guards the corrected exclusion
 * list: only field types that genuinely have no meaningful "set" (computed,
 * system, or lacking a value control here) stay out.
 */
describe('settableFieldsForSetValues (#729)', () => {
  it('includes title and relation — the two exclusions this ticket fixed', () => {
    const kept = settableFieldsForSetValues([field('title'), field('relation')]);
    expect(kept.map((f) => f.type)).toEqual(['title', 'relation']);
  });

  it('still excludes computed and system field types', () => {
    const excluded = ['lookup', 'rollup', 'button', 'rich_text', 'created_at', 'updated_at', 'created_by'];
    const kept = settableFieldsForSetValues(excluded.map((t) => field(t)));
    expect(kept).toEqual([]);
  });

  it('still excludes any field flagged isSystem, regardless of type', () => {
    const kept = settableFieldsForSetValues([field('text', true)]);
    expect(kept).toEqual([]);
  });

  it('keeps every ordinary field type working exactly as before', () => {
    const ordinary = ['text', 'number', 'select', 'multi_select', 'user', 'date', 'checkbox'];
    const kept = settableFieldsForSetValues(ordinary.map((t) => field(t)));
    expect(kept.map((f) => f.type)).toEqual(ordinary);
  });
});

describe('initialSetValue (#729)', () => {
  it('starts a relation field at an empty array, like multi_select', () => {
    expect(initialSetValue(field('relation'))).toEqual([]);
    expect(initialSetValue(field('multi_select'))).toEqual([]);
  });
});
