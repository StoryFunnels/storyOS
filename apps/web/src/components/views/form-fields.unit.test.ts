import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_TYPES,
  canAddFormField,
  patchFieldConfig,
  reorderFieldSelection,
  resolveFormFieldIds,
  toggleFieldSelection,
} from './form-fields';
import type { FormFieldCfg } from './form-fields';

/**
 * #724 — a literal copy of apps/api/src/forms/forms.service.ts's `SUPPORTED`
 * set, NOT a cross-package import: it's a private constant in an app the web
 * package can't reach at build time. This is the same limitation #724 itself
 * hit — form-fields.ts's own comment claimed to mirror SUPPORTED, and that
 * claim drifted the moment #710 added `attachment` there. A literal mirror
 * still beats a comment: it turns "does the picker offer everything the
 * server accepts" into an assertion that fails the moment either side
 * changes without the other, instead of a claim nobody re-checks. Keep this
 * list in sync with forms.service.ts's SUPPORTED by hand when either changes.
 */
const API_SUPPORTED_MIRROR = new Set([
  'title',
  'text',
  'rich_text',
  'number',
  'date',
  'checkbox',
  'url',
  'email',
  'select',
  'multi_select',
  'workflow',
  'user',
  'relation',
  'attachment',
]);

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
  it('includes relation, user and attachment (#224, #724) and excludes rich_text (unreachable via the sidebar)', () => {
    expect(FORM_FIELD_TYPES.has('relation')).toBe(true);
    expect(FORM_FIELD_TYPES.has('user')).toBe(true);
    expect(FORM_FIELD_TYPES.has('attachment')).toBe(true);
    expect(FORM_FIELD_TYPES.has('rich_text')).toBe(false);
  });

  it('excludes structural/computed types no form input could ever accept', () => {
    for (const t of ['formula', 'lookup', 'rollup', 'button', 'id', 'created_at', 'updated_at', 'created_by']) {
      expect(FORM_FIELD_TYPES.has(t)).toBe(false);
    }
  });

  it('#724 — matches the API SUPPORTED set exactly, minus the one documented exclusion (rich_text)', () => {
    const expected = new Set(API_SUPPORTED_MIRROR);
    expected.delete('rich_text');
    const missing = [...expected].filter((t) => !FORM_FIELD_TYPES.has(t));
    const extra = [...FORM_FIELD_TYPES].filter((t) => !expected.has(t));
    expect(missing, 'a type the API accepts but the builder never offers').toEqual([]);
    expect(extra, 'a type the builder offers that the API would reject').toEqual([]);
  });
});

describe('canAddFormField (#724 — at most one attachment field per form)', () => {
  it('allows an attachment field when none is selected yet', () => {
    expect(canAddFormField(['text', 'email'], 'attachment')).toBe(true);
  });

  it('refuses a second attachment field', () => {
    expect(canAddFormField(['text', 'attachment'], 'attachment')).toBe(false);
  });

  it('never blocks a non-attachment field, regardless of what is already selected', () => {
    expect(canAddFormField(['attachment'], 'text')).toBe(true);
    expect(canAddFormField(['attachment'], 'relation')).toBe(true);
  });
});
