import type { DatabaseSummary, Space } from './queries';

export function qualifiedDatabaseLabel(
  database: Pick<DatabaseSummary, 'name' | 'spaceId'>,
  spaces: Array<Pick<Space, 'id' | 'name'>>,
): string {
  const space = spaces.find((item) => item.id === database.spaceId);
  return space ? `${space.name} / ${database.name}` : database.name;
}

export function resolveDatabaseIds(
  value: unknown,
  databases: DatabaseSummary[],
  spaces: Space[],
): Array<{ id: string; label: string; missing: boolean }> {
  const ids = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : [];
  return ids.map((id) => {
    const database = databases.find((item) => item.id === id);
    return database
      ? { id, label: qualifiedDatabaseLabel(database, spaces), missing: false }
      : { id, label: 'Unavailable database', missing: true };
  });
}

/**
 * #105: the inverse of `resolveDatabaseIds` for persisting an edited selection.
 * The agent `target_databases` field is a plain text field whose canonical
 * storage is a comma-and-space-joined id list (see `architect.service.ts`'s
 * `targets.join(', ')`), so the picker writes back in exactly that shape.
 * Empties collapse to `null` so a cleared field reads as unset, not "".
 */
export function serializeDatabaseIds(ids: string[]): string | null {
  return ids.length ? ids.join(', ') : null;
}
