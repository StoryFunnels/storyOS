import { describe, expect, it } from 'vitest';
import { DELETED_FIELD_LABEL, NOT_SHOWN, auditValueText, describeFieldChange } from './audit-values';

const UUID = '4db75d42-699b-49c9-a34c-4f7631f6782a';
const members: Record<string, string> = { u1abc: 'Ada Audit' };
const name = (id: string) => members[id];

describe('describeFieldChange (#1287)', () => {
  it('an empty "from" reads as a set, not "— → value"', () => {
    expect(describeFieldChange('Name', null, 'Refresh onboarding emails', name)).toEqual({ field: 'Name', kind: 'set', from: null, to: 'Refresh onboarding emails' });
    expect(describeFieldChange('Name', '', 'x', name).kind).toBe('set');
    expect(describeFieldChange('Tags', [], ['a'], name).kind).toBe('set');
  });

  it('KEEPS both values when both exist, and a real zero or false is a value, not empty', () => {
    expect(describeFieldChange('Name', 'Old', 'New', name)).toMatchObject({ kind: 'changed', from: 'Old', to: 'New' });
    expect(describeFieldChange('Estimate', 0, 5, name)).toMatchObject({ kind: 'changed', from: '0', to: '5' });
    expect(describeFieldChange('Done', false, true, name)).toMatchObject({ kind: 'changed', from: 'false', to: 'true' });
  });

  it('an emptied value reads as cleared, keeping what it was', () => {
    expect(describeFieldChange('Notes', 'Call back', null, name)).toEqual({ field: 'Notes', kind: 'cleared', from: 'Call back', to: null });
  });

  it('a deleted field is named as such, never by an id', () => {
    expect(describeFieldChange('(deleted field)', 'a', 'b', name).field).toBe(DELETED_FIELD_LABEL);
    expect(describeFieldChange(undefined, 'a', 'b', name).field).toBe(DELETED_FIELD_LABEL);
  });

  it('a member id is the member, an id that is nobody we know is not shown, and no uuid survives, alone or in a list', () => {
    expect(describeFieldChange('Owner', null, 'u1abc', name).to).toBe('Ada Audit');
    expect(describeFieldChange('Owner', UUID, 'u1abc', name).from).toBe(NOT_SHOWN);
    expect(auditValueText([UUID, 'u1abc', 'plain'], name)).toBe(`${NOT_SHOWN}, Ada Audit, plain`);
    for (const v of [UUID, [UUID], { id: UUID }]) expect(auditValueText(v, name) ?? '').not.toContain(UUID);
  });

  it('an object value is words, never [object Object]', () => {
    expect(auditValueText({ name: 'brief.pdf' }, name)).toBe('brief.pdf');
    expect(auditValueText({ a: 1 }, name)).toBe('(complex value)');
  });

  it('ordinary text that merely looks like an id is kept', () => {
    expect(auditValueText('Q4-2026', name)).toBe('Q4-2026');
    expect(auditValueText('u1abcd', name)).toBe('u1abcd');
  });
});
