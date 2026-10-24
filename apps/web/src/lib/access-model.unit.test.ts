import { describe, expect, it } from 'vitest';
import {
  accessCards,
  accessMode,
  accessView,
  addablePeople,
  canManageAccess,
  nameList,
  openPreview,
  restrictPreview,
  showsLock,
} from './access-model';
import type { DatabaseTarget, Grant, GrantRole, Person, SpaceTarget } from './access-model';

const person = (userId: string, workspaceRole: Person['workspaceRole']): Person => ({ userId, name: userId, workspaceRole });
const ada = person('Ada', 'admin');
const otto = person('Otto', 'member');
const mira = person('Mira', 'member');
const iris = person('Iris', 'member');
const lena = person('Lena', 'guest');
const gus = person('Gus', 'guest');
const people = [ada, otto, mira, iris, lena, gus];

let n = 0;
const onSpace = (userId: string, role: GrantRole, spaceId = 's1'): Grant => ({ id: `g${++n}`, userId, role, spaceId, databaseId: null });
const onDb = (userId: string, role: GrantRole, databaseId: string): Grant => ({ id: `g${++n}`, userId, role, spaceId: null, databaseId });

const openSpace: SpaceTarget = { kind: 'space', id: 's1', name: 'Client Work', restricted: false };
const closedSpace: SpaceTarget = { ...openSpace, restricted: true };
const db = (over: Partial<DatabaseTarget> = {}, spaceRestricted = false): DatabaseTarget => ({
  kind: 'database',
  id: 'd1',
  name: 'Clients',
  restricted: false,
  isSystem: false,
  space: { id: 's1', name: 'Client Work', restricted: spaceRestricted },
  ...over,
});
const names = (xs: Array<{ person: Person }> | Person[]) => xs.map((x) => ('person' in x ? x.person.userId : x.userId)).sort();

describe('who may manage access (#924)', () => {
  it('only an admin, in this one place', () => {
    expect(canManageAccess('admin')).toBe(true);
    for (const r of ['member', 'guest', undefined]) expect(canManageAccess(r)).toBe(false);
  });

  it('a lock only on an item whose OWN flag is set, never on one closed by inheritance alone', () => {
    expect(showsLock({ restricted: true })).toBe(true);
    expect(showsLock({ restricted: false })).toBe(false);
    expect(showsLock({})).toBe(false);
  });
});

describe('the mode of a target (#924)', () => {
  it('system databases are decided by the flag, and are never restrictable', () => {
    expect(accessMode(db({ isSystem: true }))).toBe('system');
    expect(accessMode(db({ isSystem: true, restricted: true }))).toBe('system');
  });
  it('everyone / restricted / inherited', () => {
    expect(accessMode(openSpace)).toBe('everyone');
    expect(accessMode(closedSpace)).toBe('restricted');
    expect(accessMode(db())).toBe('everyone');
    expect(accessMode(db({}, true))).toBe('inherited');
    expect(accessMode(db({ restricted: true }, true))).toBe('restricted'); // sticky: its own flag wins
  });
});

describe('the radio cards are data (#924)', () => {
  it('two cards for a space and an open-space database; the first names the space for a database in a restricted one', () => {
    expect(accessCards(openSpace).map((c) => c.key)).toEqual(['everyone', 'restricted']);
    expect(accessCards(db())[0]!.label).toBe('Everyone in the workspace');
    expect(accessCards(db({}, true))[0]!.label).toBe('Everyone in Client Work');
  });
});

describe('the view of who has access (#924)', () => {
  it('everyone: one summary row with the counts, and only guests are listed as editable rows', () => {
    const v = accessView(openSpace, people, [onSpace('Lena', 'viewer'), onSpace('Otto', 'viewer')]);
    expect(v.everyone).toEqual({ admins: 1, members: 3 });
    expect(names(v.added)).toEqual(['Lena']);
    expect(names(v.membersWithGrants)).toEqual(['Otto']); // the note: they keep access if it is restricted (ADR §8)
  });

  it('restricted: admins first and never as grants; every grant holder, member or guest, is a row', () => {
    const v = accessView(closedSpace, people, [onSpace('Otto', 'editor'), onSpace('Lena', 'viewer'), onSpace('Ada', 'viewer')]);
    expect(v.admins.map((a) => a.userId)).toEqual(['Ada']);
    expect(names(v.added)).toEqual(['Lena', 'Otto']);
    expect(v.empty).toBe(false);
  });

  it('restricted with nobody but admins is the empty state', () => {
    expect(accessView(closedSpace, people, []).empty).toBe(true);
    expect(accessView(openSpace, people, []).empty).toBe(false);
  });

  it('inherited: the space\'s holders are read-only rows, direct ones editable, and a person in both says the other role', () => {
    const grants = [onSpace('Otto', 'viewer'), onSpace('Mira', 'editor'), onDb('Mira', 'viewer', 'd1'), onDb('Gus', 'commenter', 'd1')];
    const v = accessView(db({}, true), people, grants);
    expect(v.mode).toBe('inherited');
    expect(names(v.inherited)).toEqual(['Otto']); // Mira is shown once, under "added here"
    expect(v.inherited.every((r) => r.fromSpace)).toBe(true);
    expect(names(v.added)).toEqual(['Gus', 'Mira']);
    expect(v.added.find((r) => r.person.userId === 'Mira')!.alsoFromSpaceRole).toBe('editor');
  });

  it('sticky: a restricted database in a restricted space is opened only by its own grants; space holders without one are named', () => {
    const grants = [onSpace('Mira', 'editor'), onSpace('Lena', 'viewer'), onSpace('Otto', 'editor'), onDb('Otto', 'editor', 'd1')];
    const v = accessView(db({ restricted: true }, true), people, grants);
    expect(v.inherited).toEqual([]);
    expect(names(v.added)).toEqual(['Otto']);
    expect(names(v.stickyHidden)).toEqual(['Lena', 'Mira']);
  });

  it('a database in an OPEN space lists guests that come from the space, but not members (they see everything)', () => {
    const v = accessView(db(), people, [onSpace('Lena', 'viewer'), onSpace('Otto', 'viewer')]);
    expect(names(v.inherited)).toEqual(['Lena']);
  });
});

describe('who the add box offers (#924)', () => {
  it('everyone mode offers guests only, restricted offers members and guests, never an admin, never someone already added', () => {
    expect(names(addablePeople(openSpace, people, [onSpace('Lena', 'viewer')]))).toEqual(['Gus']);
    expect(names(addablePeople(closedSpace, people, [onSpace('Otto', 'viewer')]))).toEqual(['Gus', 'Iris', 'Lena', 'Mira']);
    expect(addablePeople(db({ isSystem: true }), people, [])).toEqual([]);
  });
  it('a person who holds only the space grant can still be added directly to a database in it', () => {
    expect(names(addablePeople(db({}, true), people, [onSpace('Lena', 'viewer')]))).toContain('Lena');
  });
});

describe('Everyone → Restricted: who loses access (#924)', () => {
  it('an open space: every member without a grant here, as Editor; guests only through a grant, so none', () => {
    const lose = restrictPreview(openSpace, people, [onSpace('Lena', 'viewer')]);
    expect(names(lose)).toEqual(['Iris', 'Mira', 'Otto']);
    expect(lose.every((l) => l.keepAs === 'editor' && l.via === 'workspace')).toBe(true);
  });

  it('people who already have a grant here keep access and are not listed; admins never are', () => {
    const lose = restrictPreview(openSpace, people, [onSpace('Otto', 'viewer'), onSpace('Ada', 'viewer')]);
    expect(names(lose)).toEqual(['Iris', 'Mira']);
  });

  it('a database in an open space ALSO loses the guests whose only access was the space grant, keeping their current role', () => {
    const lose = restrictPreview(db(), people, [onSpace('Lena', 'commenter')]);
    const l = lose.find((x) => x.person.userId === 'Lena')!;
    expect(l).toMatchObject({ keepAs: 'commenter', via: 'space' });
    expect(names(lose)).toEqual(['Iris', 'Lena', 'Mira', 'Otto']);
  });

  it('a database in a restricted space: the space\'s grant holders without a direct grant (members keep as Editor)', () => {
    const lose = restrictPreview(db({}, true), people, [onSpace('Mira', 'viewer'), onSpace('Lena', 'viewer'), onSpace('Otto', 'editor'), onDb('Otto', 'editor', 'd1')]);
    expect(names(lose)).toEqual(['Lena', 'Mira']);
    expect(lose.find((x) => x.person.userId === 'Mira')!.keepAs).toBe('editor');
    expect(lose.find((x) => x.person.userId === 'Lena')!.keepAs).toBe('viewer');
  });

  it('nobody loses access when nobody but admins could see it', () => {
    expect(restrictPreview(db({}, true), people, [])).toEqual([]);
  });
});

describe('Restricted → Everyone: what widens (#924)', () => {
  it('names the members who gain access and the members whose role widens to creator, with what they are today', () => {
    const p = openPreview(closedSpace, people, [onSpace('Otto', 'editor'), onSpace('Mira', 'viewer'), onSpace('Iris', 'creator')]);
    expect(p.members).toBe(3);
    expect(p.gaining).toEqual([]);
    expect(p.widening.map((w) => `${w.person.userId}:${w.today}`)).toEqual(['Mira:viewer', 'Otto:editor']);
    const q = openPreview(closedSpace, people, [onSpace('Otto', 'editor')]);
    expect(names(q.gaining)).toEqual(['Iris', 'Mira']);
  });

  it('a space names its own restricted databases, which stay closed', () => {
    expect(openPreview(closedSpace, people, [], ['Contacts', 'Payroll']).staysClosed).toEqual(['Contacts', 'Payroll']);
    expect(openPreview(db({ restricted: true }), people, []).staysClosed).toEqual([]);
  });

  it('a database falling back to its restricted space is not a workspace-wide widening: it names the space holders who gain', () => {
    const p = openPreview(db({ restricted: true }, true), people, [onSpace('Mira', 'viewer'), onSpace('Otto', 'editor'), onDb('Otto', 'editor', 'd1')]);
    expect(p.withinSpace).toBe(true);
    expect(p.widening).toEqual([]);
    expect(names(p.gaining)).toEqual(['Mira']);
  });
});

describe('name lists (#924)', () => {
  it('reads as a sentence', () => {
    expect(nameList([])).toBe('');
    expect(nameList(['Iris'])).toBe('Iris');
    expect(nameList(['Iris', 'Marek'])).toBe('Iris and Marek');
    expect(nameList(['Iris', 'Marek', 'Vera'])).toBe('Iris, Marek and Vera');
    expect(nameList(['a', 'b', 'c', 'd', 'e', 'f'], 3)).toBe('a, b, c and 3 more');
  });
});
