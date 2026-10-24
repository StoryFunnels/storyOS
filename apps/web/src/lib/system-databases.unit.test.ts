import { describe, expect, it } from 'vitest';
import {
  AGENT_SYSTEM_LABELS,
  agentSystemDatabases,
  agentSystemKey,
  databaseDisplayName,
  isSystemOnlySpace,
} from './system-databases';

const sys = (name: string) => ({ id: name, name, isSystem: true });
const own = (name: string) => ({ id: name, name, isSystem: false });

describe('the Agentic OS system databases, as people see them (#1058)', () => {
  it('"Runs" is shown as "Agent runs", "Agent Triggers" as "Triggers", "Agents" unchanged: never a bare "Runs"', () => {
    expect(databaseDisplayName(sys('Runs'))).toBe('Agent runs');
    expect(databaseDisplayName(sys('Agent Triggers'))).toBe('Triggers');
    expect(databaseDisplayName(sys('Agents'))).toBe('Agents');
    expect(Object.values(AGENT_SYSTEM_LABELS)).not.toContain('Runs');
  });

  // The flag is the identity, never the name: a person's own "Runs" is theirs (#317/#318).
  it('a person\'s own database called "Runs", "Agents" or "Agent Triggers" is neither relabelled nor hidden', () => {
    for (const name of ['Runs', 'Agents', 'Agent Triggers']) {
      expect(agentSystemKey(own(name))).toBeNull();
      expect(databaseDisplayName(own(name))).toBe(name);
    }
    expect(agentSystemKey({ name: 'Runs' })).toBeNull();
  });

  it('Members is a system database too and is left exactly as it is (ADR-0017)', () => {
    expect(agentSystemKey(sys('Members'))).toBeNull();
    expect(databaseDisplayName(sys('Members'))).toBe('Members');
  });

  it('matches the stored name without caring about case or padding', () => {
    expect(agentSystemKey(sys(' agent triggers '))).toBe('agent triggers');
  });

  it('finds the three by key, and says so when a workspace has not set agents up', () => {
    const found = agentSystemDatabases([own('Tasks'), sys('Runs'), sys('Agents'), sys('Agent Triggers'), sys('Members')]);
    expect(Object.keys(found).sort()).toEqual(['agent triggers', 'agents', 'runs']);
    expect(agentSystemDatabases([own('Tasks'), sys('Members')])).toEqual({});
  });
});

describe('which space leaves the list (#1058)', () => {
  const none = { documents: 0, folders: 0, views: 0 };
  const allThree = [sys('Agents'), sys('Runs'), sys('Agent Triggers')];

  it('a space holding only the system databases leaves the list, once its contents are known to be empty', () => {
    expect(isSystemOnlySpace(allThree, none)).toBe(true);
  });

  it('and stays hidden while its contents are still loading, so it never flashes in', () => {
    expect(isSystemOnlySpace(allThree, undefined)).toBe(true);
  });

  // What a filter must KEEP: a person's own things in that space keep it on screen.
  it.each([
    ['a database of their own', [...allThree, own('My tasks')], none],
    ['a document', allThree, { ...none, documents: 1 }],
    ['a folder', allThree, { ...none, folders: 1 }],
    ['a view', allThree, { ...none, views: 1 }],
  ])('stays when it also holds %s', (_n, dbs, extras) => {
    expect(isSystemOnlySpace(dbs, extras)).toBe(false);
  });

  it('stays while loading if it already shows a database of their own', () => {
    expect(isSystemOnlySpace([...allThree, own('My tasks')], undefined)).toBe(false);
  });

  it('a brand-new empty space is not hidden (nothing system in it), and neither is the space holding Members', () => {
    expect(isSystemOnlySpace([], none)).toBe(false);
    expect(isSystemOnlySpace([sys('Members')], none)).toBe(false);
  });
});
