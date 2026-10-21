import { defaultEntityColor } from '@storyos/schemas';

/**
 * A database's palette colour as an API response states it: the persisted value if it has one, else the default derived from its id.
 *
 * The default is `defaultEntityColor` in `@storyos/schemas`: the SAME function the app draws with (ticket #1016). It used to be a
 * different hash over a different list, so a database with no stored colour could be one colour here and another in the sidebar.
 * Read-time only for a NULL colour (databases created before MN-299), so it never fights a manual override
 * (`DatabasesService.update()` via the icon-picker swatch UI).
 */
export function resolveDatabaseColor(id: string, color: string | null): string {
  return color ?? defaultEntityColor(id);
}
