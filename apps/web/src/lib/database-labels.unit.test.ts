import { describe, expect, it } from 'vitest';
import {
  isAgentConfigRefField,
  isAgentConfigRefValue,
  looksLikeUuid,
  qualifiedDatabaseLabel,
  resolveDatabaseId,
  resolveDatabaseIds,
  resolveFieldLabel,
  resolveOptionLabel,
  serializeDatabaseIds,
  type RefField,
} from './database-labels';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

const spaces = [
  { id: 's1', name: 'Client Work', icon: null, color: null, position: 0 },
  { id: 's2', name: 'Internal', icon: null, color: null, position: 1 },
];
const databases = [
  {
    id: 'd1',
    spaceId: 's1',
    folderId: null,
    name: 'Projects',
    icon: null,
    color: null,
    apiSlug: 'projects',
    position: 0,
  },
  {
    id: 'd2',
    spaceId: 's2',
    folderId: null,
    name: 'Projects',
    icon: null,
    color: null,
    apiSlug: 'projects',
    position: 1,
  },
];

describe('qualified database labels', () => {
  it('disambiguates duplicate database names by space', () => {
    expect(qualifiedDatabaseLabel(databases[0]!, spaces)).toBe('Client Work / Projects');
    expect(qualifiedDatabaseLabel(databases[1]!, spaces)).toBe('Internal / Projects');
  });

  it('resolves comma-separated agent target ids without leaking missing UUIDs', () => {
    expect(resolveDatabaseIds('d1, missing-id', databases, spaces)).toEqual([
      { id: 'd1', label: 'Client Work / Projects', missing: false },
      { id: 'missing-id', label: 'Unavailable database', missing: true },
    ]);
  });
});

describe('serializeDatabaseIds (#105: writing an edited target-databases selection back)', () => {
  it('joins ids in the canonical comma-and-space shape the field is stored in', () => {
    expect(serializeDatabaseIds(['d1', 'd2'])).toBe('d1, d2');
  });

  it('collapses an empty selection to null so a cleared field reads as unset', () => {
    expect(serializeDatabaseIds([])).toBeNull();
  });

  it('round-trips through resolveDatabaseIds — parse, drop one, re-serialize', () => {
    const parsed = resolveDatabaseIds('d1, d2', databases, spaces);
    const kept = parsed.filter((target) => target.id !== 'd2').map((target) => target.id);
    expect(serializeDatabaseIds(kept)).toBe('d1');
  });
});

describe('#317 residual — agent-config id gating', () => {
  it('only recognises UUID-shaped ids', () => {
    expect(looksLikeUuid(U1)).toBe(true);
    expect(looksLikeUuid('  ' + U1 + '  ')).toBe(true);
    expect(looksLikeUuid('Postgres')).toBe(false);
    expect(looksLikeUuid('d1')).toBe(false);
    expect(looksLikeUuid(42)).toBe(false);
  });

  it('flags the four agent-config ref fields', () => {
    for (const name of ['target_databases', 'database', 'state_field', 'state_option']) {
      expect(isAgentConfigRefField(name)).toBe(true);
    }
    expect(isAgentConfigRefField('title')).toBe(false);
  });

  it('captures a value only when the field is a ref AND the payload is id-shaped', () => {
    // A user's own text field named "database" holding plain text is left alone.
    expect(isAgentConfigRefValue('database', 'Postgres')).toBe(false);
    expect(isAgentConfigRefValue('database', U1)).toBe(true);
    // A non-agent field is never captured, even with a UUID value.
    expect(isAgentConfigRefValue('notes', U1)).toBe(false);
    // state_field / state_option gate on a single UUID.
    expect(isAgentConfigRefValue('state_field', U2)).toBe(true);
    expect(isAgentConfigRefValue('state_option', 'todo')).toBe(false);
  });

  it('target_databases captures a comma-joined UUID list, but not partial/plain lists', () => {
    expect(isAgentConfigRefValue('target_databases', `${U1}, ${U2}`)).toBe(true);
    expect(isAgentConfigRefValue('target_databases', `${U1}, not-a-uuid`)).toBe(false);
    expect(isAgentConfigRefValue('target_databases', '')).toBe(false);
  });
});

describe('#317 residual — single-database, field & option resolution', () => {
  it('resolves a single database id, disambiguated by space', () => {
    expect(resolveDatabaseId('d1', databases, spaces)).toEqual({
      id: 'd1',
      label: 'Client Work / Projects',
      missing: false,
    });
    expect(resolveDatabaseId('d2', databases, spaces)).toEqual({
      id: 'd2',
      label: 'Internal / Projects',
      missing: false,
    });
  });

  it('flags a deleted / inaccessible database instead of leaking the id', () => {
    expect(resolveDatabaseId('gone', databases, spaces)).toEqual({
      id: 'gone',
      label: 'Unavailable database',
      missing: true,
    });
  });

  const fields: RefField[] = [
    { id: 'f1', displayName: 'Status', options: [{ id: 'o1', label: 'Todo' }, { id: 'o2', label: 'Done' }] },
    { id: 'f2', displayName: 'Priority', options: [{ id: 'o3', label: 'High' }] },
  ];

  it('resolves a state_field id to its field name, else Unavailable', () => {
    expect(resolveFieldLabel('f1', fields)).toEqual({ label: 'Status', missing: false });
    expect(resolveFieldLabel('missing', fields)).toEqual({ label: 'Unavailable field', missing: true });
  });

  it('resolves a state_option id across every field, else Unavailable', () => {
    expect(resolveOptionLabel('o3', fields)).toEqual({ label: 'High', missing: false });
    expect(resolveOptionLabel('o1', fields)).toEqual({ label: 'Todo', missing: false });
    expect(resolveOptionLabel('gone', fields)).toEqual({ label: 'Unavailable option', missing: true });
  });
});
