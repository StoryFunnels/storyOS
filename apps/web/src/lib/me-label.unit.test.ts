import { describe, expect, it } from 'vitest';
import {
  findMeCondition,
  findMeView,
  meConditionText,
  meLabel,
  notMeLabel,
  publishedCopyBase,
  swapMeForUser,
  uniqueName,
} from './me-label';

describe('meLabel — Dara’s mapping (#928)', () => {
  it.each([
    ['Assignee', 'Assigned to me'],
    ['Assignees', 'Assigned to me'],
    ['Assigned to', 'Assigned to me'],
    ['Next', 'Assigned to me'],
    ['Owner', 'Owned by me'],
    ['Lead', 'Led by me'],
    ['Author', 'Written by me'],
    ['Editor', 'Edited by me'],
    ['Reviewer', 'Reviewed by me'],
    ['Requester', 'Requested by me'],
    ['Created by', 'Created by me'],
    ['Last edited by', 'Last edited by me'],
  ])('%s → %s', (field, label) => expect(meLabel(field)).toBe(label));

  it('falls back to "Me as <Field>" and matches the field name case-insensitively', () => {
    expect(meLabel('Account manager')).toBe('Me as Account manager');
    expect(meLabel('  assignee ')).toBe('Assigned to me');
  });
  it('negates', () => {
    expect(notMeLabel('Assignee')).toBe('Not assigned to me');
    expect(notMeLabel('Account manager')).toBe('Not me as Account manager');
  });
});

describe('meConditionText', () => {
  it('speaks only for Me alone, with has / eq / neq / has_none', () => {
    expect(meConditionText('Assignee', 'has', ['me'])).toBe('Assigned to me');
    expect(meConditionText('Assignee', 'eq', 'me')).toBe('Assigned to me');
    expect(meConditionText('Assignee', 'has_none', ['me'])).toBe('Not assigned to me');
    expect(meConditionText('Assignee', 'neq', 'me')).toBe('Not assigned to me');
  });
  it('leaves everything else to the ordinary description (what a filter must KEEP)', () => {
    expect(meConditionText('Next', 'has', ['me', 'u2'])).toBeNull(); // "Me plus other people stays a list"
    expect(meConditionText('Assignee', 'has', ['u2'])).toBeNull();
    expect(meConditionText('Assignee', 'is_empty', ['me'])).toBeNull();
    expect(meConditionText('Assignee', 'has', [])).toBeNull();
    expect(meConditionText('Assignee', 'has', undefined)).toBeNull();
  });
});

describe('findMeCondition / findMeView', () => {
  const persons = new Set(['assignee']);
  const mine = { field: 'assignee', op: 'has', value: ['me'] };
  it('finds a live Me condition, however deeply nested', () => {
    expect(findMeCondition({ and: [{ field: 'state', op: 'eq', value: 'x' }, { or: [mine] }] }, persons)).toBe(mine);
  });
  it('ignores a disabled one, a non-person field and a plain user id', () => {
    expect(findMeCondition({ and: [{ ...mine, disabled: true }] }, persons)).toBeUndefined();
    expect(findMeCondition({ and: [{ field: 'state', op: 'has', value: ['me'] }] }, persons)).toBeUndefined();
    expect(findMeCondition({ and: [{ field: 'assignee', op: 'has', value: ['u1'] }] }, persons)).toBeUndefined();
    expect(findMeCondition(undefined, persons)).toBeUndefined();
  });
  it('the tile reuses a view filtered to the field is me — but not a hand-built "me, Iris" list', () => {
    const a = { id: 'a', config: { filters: { and: [mine] } } };
    const b = { id: 'b', config: { filters: { and: [{ ...mine, value: ['me', 'u2'] }] } } };
    const c = { id: 'c', config: {} };
    expect(findMeView([c, b, a], 'assignee')).toBe(a);
    expect(findMeView([c, b], 'assignee')).toBeUndefined();
    expect(findMeView([a], 'owner')).toBeUndefined();
  });
});

describe('names', () => {
  it('uniqueName counts up on a clash', () => {
    expect(uniqueName('A', [])).toBe('A');
    expect(uniqueName('A', ['a'])).toBe('A 2');
    expect(uniqueName('A', ['A', 'A 2'])).toBe('A 3');
  });
  it('a copy named by its Me label swaps the person in; any other name gets "— Name’s records" (Otto, v32)', () => {
    expect(publishedCopyBase('Assigned to me', 'Assignee', 'Dara')).toBe('Assigned to Dara');
    expect(publishedCopyBase('Owned by me', 'Owner', 'Dara')).toBe('Owned by Dara');
    expect(publishedCopyBase('Me as Account manager', 'Account manager', 'Dara')).toBe('Dara as Account manager');
    expect(publishedCopyBase('Board', 'Assignee', 'Dara')).toBe('Board — Dara’s records');
    expect(publishedCopyBase('Assigned to me', null, 'Dara')).toBe('Assigned to me — Dara’s records');
  });
});

describe('swapMeForUser', () => {
  it('replaces Me with the author everywhere and unpins, keeping everything else', () => {
    const out = swapMeForUser(
      { and: [{ field: 'assignee', op: 'has', value: ['me', 'u2'], pinned: true }, { or: [{ field: 'x', op: 'eq', value: 'me' }] }] },
      'u1',
    );
    expect(out).toEqual({
      and: [
        { field: 'assignee', op: 'has', value: ['u1', 'u2'], pinned: false },
        { or: [{ field: 'x', op: 'eq', value: 'u1', pinned: false }] },
      ],
    });
  });
});
