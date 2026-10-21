/**
 * The ONE default colour for an entity that was never coloured: a database's glyph, derived from its id (tickets #1001 / #1016).
 *
 * Not random: a STABLE colour from the id, so the same database is the same colour on every load, device and viewer, in the app and in
 * an API response. It lived in the web (`apps/web/src/lib/entity-color.ts`) while the API carried a DIFFERENT hash over a different
 * list (a 31-multiplier hash over all fifteen palette names), so a database with no stored colour could be one colour in a response and
 * another in the sidebar. Now there is one function, here, and both import it. The migration that backfills `color = 'gray'` implements
 * the same function in SQL, and a test runs the two against each other.
 *
 * The eight are the picker's own palette names, in the ORDER the web fixed for its tokens c1..c8 (ticket #1016, agreed with the web
 * lane): the order is part of the function, because the index into it is what a database's colour is. Changing the order or the
 * algorithm recolours every workspace. Never grey: grey is a choice a person makes.
 */
export const DEFAULT_ENTITY_COLORS = ['gold', 'blue', 'green', 'red', 'purple', 'teal', 'orange', 'brown'] as const;
export type DefaultEntityColor = (typeof DEFAULT_ENTITY_COLORS)[number];

/** FNV-1a over UTF-16 code units: tiny, dependency-free, and the same everywhere (no locale, no platform). */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The default colour NAME for an id. */
export function defaultEntityColor(id: string): DefaultEntityColor {
  return DEFAULT_ENTITY_COLORS[hashId(id) % DEFAULT_ENTITY_COLORS.length]!;
}
