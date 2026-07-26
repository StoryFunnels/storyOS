import { describe, expect, it } from 'vitest';
import {
  qualifiedDatabaseLabel,
  resolveDatabaseIds,
  serializeDatabaseIds,
} from './database-labels';

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
