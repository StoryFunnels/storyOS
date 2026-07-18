import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_TYPES,
  patchFieldConfig,
  reorderFieldSelection,
  resolveFormFieldIds,
  toggleFieldSelection,
} from './form-fields';
import type { FormFieldCfg } from './form-fields';

describe('resolveFormFieldIds (#224 back-compat)', () => {
  it('uses form.fields when present, ignoring card_field_ids', () => {
    const formFields: FormFieldCfg[] = [{ field_id: 'a' }, { field_id: 'b' }];
    expect(resolveFormFieldIds(formFields, ['x', 'y'])).toEqual(['a', 'b']);
  });

  it('falls back to card_field_ids for a form saved before the sidebar shipped', () => {
    expect(resolveFormFieldIds([], ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('an empty legacy form (no cards, no form.fields) resolves to no fields', () => {
    expect(resolveFormFieldIds([], [])).toEqual([]);
  });
});

describe('toggleFieldSelection', () => {
  it('adds a field to the end of the selection', () => {
    const result = toggleFieldSelection(['a'], [{ field_id: 'a', required: true }], 'b');
    expect(result).toEqual([{ field_id: 'a', required: true }, { field_id: 'b' }]);
  });

  it('removes a field already on the form', () => {
    const cfgs: FormFieldCfg[] = [{ field_id: 'a' }, { field_id: 'b', label: 'B label' }];
    const result = toggleFieldSelection(['a', 'b'], cfgs, 'a');
    expect(result).toEqual([{ field_id: 'b', label: 'B label' }]);
  });

  it('re-adding a field after removal starts with a fresh (empty) config', () => {
    const cfgs: FormFieldCfg[] = [{ field_id: 'a', required: true, label: 'Name' }, { field_id: 'b' }];
    const afterRemove = toggleFieldSelection(['a', 'b'], cfgs, 'a');
    const afterReAdd = toggleFieldSelection(['b'], afterRemove, 'a');
    expect(afterReAdd).toContainEqual({ field_id: 'a' });
  });
});

describe('reorderFieldSelection', () => {
  const cfgs: FormFieldCfg[] = [{ field_id: 'a' }, { field_id: 'b' }, { field_id: 'c' }];

  it('moves a field earlier in the order', () => {
    const result = reorderFieldSelection(['a', 'b', 'c'], cfgs, 2, 0);
    expect(result.map((c) => c.field_id)).toEqual(['c', 'a', 'b']);
  });

  it('moves a field later in the order', () => {
    const result = reorderFieldSelection(['a', 'b', 'c'], cfgs, 0, 2);
    expect(result.map((c) => c.field_id)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op for an out-of-range index', () => {
    const result = reorderFieldSelection(['a', 'b', 'c'], cfgs, 0, 5);
    expect(result).toBe(cfgs);
  });

  it('preserves each field config across the move', () => {
    const withLabel: FormFieldCfg[] = [{ field_id: 'a', label: 'First' }, { field_id: 'b' }];
    const result = reorderFieldSelection(['a', 'b'], withLabel, 0, 1);
    expect(result).toEqual([{ field_id: 'b' }, { field_id: 'a', label: 'First' }]);
  });
});

describe('patchFieldConfig', () => {
  it('patches only the targeted field, leaving order and others untouched', () => {
    const cfgs: FormFieldCfg[] = [{ field_id: 'a' }, { field_id: 'b' }];
    const result = patchFieldConfig(['a', 'b'], cfgs, 'b', { required: true, label: 'Email' });
    expect(result).toEqual([{ field_id: 'a' }, { field_id: 'b', required: true, label: 'Email' }]);
  });

  it('initializes config for a selected field with no prior cfg entry', () => {
    const result = patchFieldConfig(['a'], [], 'a', { help: 'Pick one' });
    expect(result).toEqual([{ field_id: 'a', help: 'Pick one' }]);
  });
});

describe('FORM_FIELD_TYPES', () => {
  it('includes relation and user (#224) and excludes rich_text (unreachable via the sidebar)', () => {
    expect(FORM_FIELD_TYPES.has('relation')).toBe(true);
    expect(FORM_FIELD_TYPES.has('user')).toBe(true);
    expect(FORM_FIELD_TYPES.has('rich_text')).toBe(false);
  });

  it('excludes structural/computed types no form input could ever accept', () => {
    for (const t of ['formula', 'lookup', 'rollup', 'button', 'id', 'created_at', 'updated_at', 'created_by']) {
      expect(FORM_FIELD_TYPES.has(t)).toBe(false);
    }
  });
});
