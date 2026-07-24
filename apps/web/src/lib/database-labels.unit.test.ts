import { describe, expect, it } from 'vitest';
import { qualifiedDatabaseLabel, resolveDatabaseIds } from './database-labels';

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
