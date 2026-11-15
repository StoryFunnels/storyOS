import { describe, expect, it } from 'vitest';
import { DELETED_FIELD_LABEL, auditActorLabel, auditValueText, describeFieldChange } from './audit-values';

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

  const AUTH_ID = 'ksTxCVvB5IaDBmlsWRKJDyXSABVGDi09';

  it('a member id is the member; an id that is nobody we know is never printed, and the clause is omitted, not worded', () => {
    expect(describeFieldChange('Owner', null, 'u1abc', name).to).toBe('Ada Audit');
    for (const [from, to] of [[UUID, 'u1abc'], ['u1abc', AUTH_ID], [null, AUTH_ID], [[UUID], null], [null, [UUID, 'u1abc']]] as const) {
      const c = describeFieldChange('Owner', from, to, name);
      expect(c).toEqual({ field: 'Owner', kind: 'changed', from: null, to: null });
    }
  });

  it('no id (uuid or better-auth id) and no invented word survives in any value text', () => {
    for (const v of [UUID, AUTH_ID, [UUID], [AUTH_ID, 'plain'], { id: UUID }]) {
      const c = describeFieldChange('F', v, 'x', name);
      expect(JSON.stringify(c)).not.toContain(UUID);
      expect(JSON.stringify(c)).not.toContain(AUTH_ID);
      expect(JSON.stringify(c)).not.toMatch(/not shown|removed member/i);
    }
  });

  it('a member list resolves, and mixed with an unresolvable id the whole change is omitted rather than half-said', () => {
    expect(auditValueText(['u1abc', 'plain'], name)).toBe('Ada Audit, plain');
    expect(describeFieldChange('Team', ['u1abc'], ['u1abc', UUID], name)).toMatchObject({ kind: 'changed', from: null, to: null });
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

describe('auditActorLabel (#1287)', () => {
  const AUTH_ID = 'ksTxCVvB5IaDBmlsWRKJDyXSABVGDi09';
  it('a real name is shown', () => {
    expect(auditActorLabel('Ada Audit', 'u1abc', name)).toBe('Ada Audit');
  });
  it('an id-shaped actor name is never printed: a member by that id, else "Someone"', () => {
    expect(auditActorLabel(UUID, null, name)).toBe('Someone');
    expect(auditActorLabel(AUTH_ID, null, name)).toBe('Someone');
    expect(auditActorLabel('u1abc', null, name)).toBe('u1abc'); // short ordinary text is a name, not an id
  });
  it('"(unknown)" and missing names resolve by actor id when a member, else the neutral word, and never claim removal', () => {
    expect(auditActorLabel('(unknown)', 'u1abc', name)).toBe('Ada Audit');
    expect(auditActorLabel('(unknown)', 'system:members-projection', name)).toBe('Someone');
    expect(auditActorLabel(null, null, name)).toBe('Someone');
    expect(auditActorLabel('(unknown)', null, name)).not.toMatch(/removed|unknown/i);
  });
});
