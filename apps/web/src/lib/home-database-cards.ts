import type { DatabaseSummary, Space } from './queries';

/**
 * Ticket #1207 — the model behind the workspace home's "Where to go" cards.
 *
 * A card is a database, in the order the list gives them. It carries what is needed to
 * draw the database's own glyph (the same inputs the sidebar hands `DatabaseGlyph`) and
 * the name of the space it lives in, because two databases can share a name and the
 * space is the only thing telling them apart.
 *
 * This decides nothing about WHICH databases are listed; the caller's list is the list.
 * A space the viewer's spaces list does not contain is not invented: the card simply
 * has no space line, rather than naming a space the viewer was never shown.
 */
export interface DatabaseCard {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  /** The space's name, or null when the viewer's spaces list does not contain it. */
  spaceName: string | null;
  /** The full "Database · Space" label, used for the tooltip (the visible lines truncate). */
  label: string;
}

/** "Projects · Client Work"; just the name when the space is unknown. */
export function databaseCardLabel(name: string, spaceName: string | null | undefined): string {
  const space = spaceName?.trim();
  return space ? `${name} · ${space}` : name;
}

export function buildDatabaseCards(
  databases: ReadonlyArray<Pick<DatabaseSummary, 'id' | 'name' | 'icon' | 'color' | 'spaceId'>>,
  spaces: ReadonlyArray<Pick<Space, 'id' | 'name'>>,
): DatabaseCard[] {
  const spaceNames = new Map(spaces.map((s) => [s.id, s.name]));
  return databases.map((d) => {
    const spaceName = spaceNames.get(d.spaceId) ?? null;
    return {
      id: d.id,
      name: d.name,
      icon: d.icon ?? null,
      color: d.color ?? null,
      spaceName,
      label: databaseCardLabel(d.name, spaceName),
    };
  });
}
