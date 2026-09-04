import { describe, expect, it } from 'vitest';
import { mappedFieldIds, normalizeFieldMapping, normalizeMappingEntry } from './field-mapping';

describe('normalizeMappingEntry (#280)', () => {
  it('a legacy bare-uuid entry normalizes to direction "in"', () => {
    expect(normalizeMappingEntry('field-1')).toEqual({ fieldId: 'field-1', direction: 'in' });
  });

  it('an object entry with an explicit direction is preserved', () => {
    expect(normalizeMappingEntry({ field_id: 'field-1', direction: 'out' })).toEqual({
      fieldId: 'field-1',
      direction: 'out',
    });
    expect(normalizeMappingEntry({ field_id: 'field-1', direction: 'both' })).toEqual({
      fieldId: 'field-1',
      direction: 'both',
    });
  });

  it('an object entry with NO direction defaults to "in" — unset behaves as in', () => {
    expect(normalizeMappingEntry({ field_id: 'field-1' } as never)).toEqual({
      fieldId: 'field-1',
      direction: 'in',
    });
  });

  it('a malformed value is null, not a throw', () => {
    expect(normalizeMappingEntry(undefined)).toBeNull();
    expect(normalizeMappingEntry(null as never)).toBeNull();
    expect(normalizeMappingEntry(42 as never)).toBeNull();
  });
});

describe('normalizeFieldMapping / mappedFieldIds (#280)', () => {
  it('a mapping mixing legacy and object entries normalizes every entry consistently', () => {
    const mapping = {
      legacy_key: 'field-1',
      out_key: { field_id: 'field-2', direction: 'out' as const },
      both_key: { field_id: 'field-3', direction: 'both' as const },
    };
    expect(normalizeFieldMapping(mapping)).toEqual({
      legacy_key: { fieldId: 'field-1', direction: 'in' },
      out_key: { fieldId: 'field-2', direction: 'out' },
      both_key: { fieldId: 'field-3', direction: 'both' },
    });
  });

  it('mappedFieldIds returns every field_id regardless of direction — the shape external_key_field_id validation needs', () => {
    const mapping = {
      a: 'field-1',
      b: { field_id: 'field-2', direction: 'out' as const },
    };
    expect(mappedFieldIds(mapping).sort()).toEqual(['field-1', 'field-2']);
  });
});
