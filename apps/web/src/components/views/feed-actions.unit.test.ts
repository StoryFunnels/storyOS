import { describe, expect, it } from 'vitest';
import { feedActionFields } from './feed-actions';
import type { Field } from '../table-view/use-table-data';

const field = (over: Partial<Field> & { type: string; id?: string }): Field =>
  ({
    id: over.id ?? `f_${over.type}`,
    apiName: over.apiName ?? over.type,
    displayName: over.displayName ?? over.type,
    config: over.config ?? {},
    isSystem: over.isSystem ?? false,
    ...over,
  }) as Field;

describe('feedActionFields — quick-actions availability (#76)', () => {
  it('omits every action when the schema has none of the relevant field types', () => {
    const fields = [field({ type: 'title' }), field({ type: 'text' })];
    expect(feedActionFields(fields, {})).toEqual({
      statusField: undefined,
      checkboxField: undefined,
      userField: undefined,
    });
  });

  it('picks the first select field as status when the view has no color-by field configured', () => {
    const select1 = field({ type: 'select', id: 'sel-1' });
    const select2 = field({ type: 'select', id: 'sel-2' });
    const fields = [field({ type: 'title' }), select1, select2];
    expect(feedActionFields(fields, {}).statusField).toBe(select1);
  });

  it('prefers the view-configured color-by field over the first select field (MN-102 convention)', () => {
    const select1 = field({ type: 'select', id: 'sel-1' });
    const select2 = field({ type: 'select', id: 'sel-2' });
    const fields = [select1, select2];
    expect(feedActionFields(fields, { color_by_field_id: 'sel-2' }).statusField).toBe(select2);
  });

  it('falls back to the first select field if the configured color-by field id no longer resolves to a select field', () => {
    const select1 = field({ type: 'select', id: 'sel-1' });
    const fields = [select1, field({ type: 'text', id: 'not-a-select' })];
    expect(feedActionFields(fields, { color_by_field_id: 'not-a-select' }).statusField).toBe(select1);
  });

  it('surfaces checkbox and user fields independently of the status field', () => {
    const checkbox = field({ type: 'checkbox' });
    const user = field({ type: 'user' });
    const fields = [field({ type: 'title' }), checkbox, user];
    const result = feedActionFields(fields, {});
    expect(result.statusField).toBeUndefined();
    expect(result.checkboxField).toBe(checkbox);
    expect(result.userField).toBe(user);
  });

  it('picks only the first field of each type when the schema has several', () => {
    const checkbox1 = field({ type: 'checkbox', id: 'chk-1' });
    const checkbox2 = field({ type: 'checkbox', id: 'chk-2' });
    const fields = [checkbox1, checkbox2];
    expect(feedActionFields(fields, {}).checkboxField).toBe(checkbox1);
  });
});
