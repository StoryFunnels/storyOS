import { describe, expect, it } from 'vitest';
import type { DatabaseSummary, Space } from '@/lib/queries';
import { addWork, isCovered, pickerGroups, removeWork, watchableDatabases } from './works-in';
import type { WorkTarget } from './hire';
import { agentRelationField, isWatchableField, newRule, rebaseRules, singular } from './wake-rules';
import type { WakeRule } from './wake-rules';

const space = (id: string, name: string, position: number, personal = false) => ({ id, name, icon: null, color: null, position, personal }) as Space;
const db = (id: string, spaceId: string, name: string, position = 0, isSystem = false) => ({ id, spaceId, name, position, isSystem }) as DatabaseSummary;
const SPACES = [space('s2', 'Podcasts', 2), space('s1', 'Client Work', 1), space('sp', 'My Space', 0, true)];
const DBS = [db('a', 's1', 'Clients', 0), db('b', 's1', 'Contacts', 1), db('c', 's2', 'Episodes'), db('m', 's1', 'Members', 2, true), db('p', 'sp', 'Private')];

describe('the Works in picker list (ticket #1196)', () => {
  it('groups by space in the sidebar’s order, leaves out system databases and personal spaces', () => {
    const g = pickerGroups(SPACES, DBS, '');
    expect(g.map((x) => x.space.name)).toEqual(['Client Work', 'Podcasts']);
    expect(g[0]!.databases.map((d) => d.name)).toEqual(['Clients', 'Contacts']); // not Members
  });
  it('searching a database shows only the databases that match', () => {
    const g = pickerGroups(SPACES, DBS, 'cont');
    expect(g).toHaveLength(1);
    expect(g[0]!.databases.map((d) => d.name)).toEqual(['Contacts']);
  });
  it('searching a SPACE name keeps all of that space (a filter must keep what matches)', () => {
    expect(pickerGroups(SPACES, DBS, 'podcast')[0]!.databases.map((d) => d.name)).toEqual(['Episodes']);
    expect(pickerGroups(SPACES, DBS, 'client work')[0]!.databases).toHaveLength(2);
  });
  it('a system or private database is never findable by search', () => {
    expect(pickerGroups(SPACES, DBS, 'members')).toEqual([]);
    expect(pickerGroups(SPACES, DBS, 'private')).toEqual([]);
  });
  it('add, no duplicate, remove, and "already added" is read from the chips', () => {
    const t: WorkTarget = { kind: 'db', id: 'a', name: 'Clients', spaceId: 's1' };
    const one = addWork([], t);
    expect(addWork(one, t)).toHaveLength(1);
    expect(isCovered(one, DBS[0]!)).toBe(true);
    expect(isCovered(one, DBS[1]!)).toBe(false);
    expect(removeWork(one, 0)).toEqual([]);
  });
  it('a space target (once the API has one) replaces that space’s database chips and covers its databases', () => {
    const dbs: WorkTarget[] = [{ kind: 'db', id: 'a', name: 'Clients', spaceId: 's1' }, { kind: 'db', id: 'c', name: 'Episodes', spaceId: 's2' }];
    const next = addWork(dbs, { kind: 'space', id: 's1', name: 'Client Work' });
    expect(next.map((w) => `${w.kind}:${w.id}`)).toEqual(['db:c', 'space:s1']);
    expect(isCovered(next, DBS[1]!)).toBe(true);
  });
});

describe('rules follow Works in, and only offer what can be watched', () => {
  const rules: WakeRule[] = [
    { kind: 'sched', every: 'day', at: '09:00', weekday: 1, window: false },
    { kind: 'field', databaseId: 'a', fieldId: 'f' },
    { kind: 'new', databaseId: 'b' },
    { kind: 'assign', databaseId: 'b', relationFieldId: 'r' },
  ];
  it('a rule added from the menu starts in the quietest useful state: a schedule hourly (never every 10 minutes), field/new on the first database, field unchosen', () => {
    expect(newRule('sched', { databaseId: 'a' })).toMatchObject({ kind: 'sched', every: 'hour', window: false });
    expect(newRule('field', { databaseId: 'a' })).toEqual({ kind: 'field', databaseId: 'a', fieldId: null });
    expect(newRule('new', { databaseId: 'a' })).toEqual({ kind: 'new', databaseId: 'a' });
    expect(newRule('assign', { databaseId: 'a', relationFieldId: 'r' })).toEqual({ kind: 'assign', databaseId: 'a', relationFieldId: 'r' });
  });
  it('removing a database moves its rules to a remaining one (field choice cleared), drops an assign rule, keeps schedules', () => {
    expect(rebaseRules(rules, ['a'])).toEqual([
      rules[0],
      rules[1],
      { kind: 'new', databaseId: 'a' },
    ]);
    expect(rebaseRules(rules, ['b'])[1]).toEqual({ kind: 'field', databaseId: 'b', fieldId: null });
  });
  it('with nothing left, a database rule points at nothing (and the card says so)', () => {
    expect(rebaseRules(rules, [])).toEqual([rules[0], { kind: 'field', databaseId: null, fieldId: null }, { kind: 'new', databaseId: null }]);
  });
  it('a field that cannot be edited by a person is not offered; one that can, is', () => {
    for (const type of ['formula', 'rollup', 'lookup', 'relation', 'ai', 'button']) expect(isWatchableField({ type }), type).toBe(false);
    expect(isWatchableField({ type: 'select' })).toBe(true);
    expect(isWatchableField({ type: 'text', isSystem: true })).toBe(false);
    expect(isWatchableField({ type: 'text', deprecated: true })).toBe(false);
  });
  it('a database name reads as one record: Clients -> Client, Categories -> Category, Business and Status unchanged', () => {
    expect(singular('Clients')).toBe('Client');
    expect(singular('Categories')).toBe('Category');
    expect(singular('Business')).toBe('Business');
    expect(singular('Status')).toBe('Status');
    expect(singular('Client')).toBe('Client');
  });
  it('"when you assign it" needs a relation field that points at the Agents database', () => {
    const f = (id: string, target: string) => ({ id, type: 'relation', displayName: id, relation: { target_database_id: target } });
    expect(agentRelationField([f('x', 'tasks'), f('owner', 'AGENTS')], 'AGENTS')?.id).toBe('owner');
    expect(agentRelationField([f('x', 'tasks')], 'AGENTS')).toBeNull();
    expect(agentRelationField(undefined, 'AGENTS')).toBeNull();
  });
});

describe('what a wake rule may watch once a whole space is a chip (ticket #1289 item 7)', () => {
  const spaceChip: WorkTarget = { kind: 'space', id: 's1', name: 'Client Work' };
  it('a space chip makes its databases watchable, without the system ones', () => {
    expect(watchableDatabases([spaceChip], DBS).map((d) => d.id)).toEqual(['a', 'b']); // not Members (system), not Episodes (another space)
  });
  it('KEEPS named databases, once, whether or not their space is also a chip', () => {
    const named: WorkTarget = { kind: 'db', id: 'c', name: 'Episodes', spaceId: 's2' };
    const both: WorkTarget = { kind: 'db', id: 'a', name: 'Clients', spaceId: 's1' };
    expect(watchableDatabases([named], DBS).map((d) => d.id)).toEqual(['c']);
    expect(watchableDatabases([both, spaceChip, named], DBS).map((d) => d.id)).toEqual(['a', 'c', 'b']);
  });
  it('no chips, nothing to watch', () => expect(watchableDatabases([], DBS)).toEqual([]));
});
