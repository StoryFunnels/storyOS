import { OPTION_COLORS } from '@/components/table-view/option-colors';

/**
 * #1001 — a database with no colour of its own still gets one.
 *
 * Every database that nobody coloured drew the same grey cylinder, so a space of four databases read as four copies of
 * one thing. The rule (Otto's ruling on the ticket): not random — a STABLE default derived from the id, so the same
 * database is the same colour on every load, device and viewer. A colour a person set always wins, and clearing it falls
 * back to this. It is display-only: nothing is written to the row, so the picker still says "no colour chosen".
 *
 * ONE helper, used by every surface that draws a database's glyph (sidebar, page header, relation chips, My Work, ⌘K,
 * quick add, the relations diagram…). A surface that reads `database.color` directly keeps the grey, which is the bug
 * returning; `entity-color.unit.test.ts` sweeps the source for exactly that.
 *
 * The eight are the picker's own palette names (`OPTION_COLORS`), chosen for distinct hues and for contrast: each is at
 * least 3:1 against both the light (#f4efe5) and the dark (#0a0d12) sidebar, which is the bar for a glyph. The palette is
 * one fixed hex per name, with no separate dark set, so the contrast test pins the table the app really has.
 */
export const DEFAULT_ENTITY_COLORS = ['blue', 'teal', 'green', 'orange', 'red', 'pink', 'purple', 'gold'] as const;

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
export function defaultEntityColor(id: string): (typeof DEFAULT_ENTITY_COLORS)[number] {
  return DEFAULT_ENTITY_COLORS[hashId(id) % DEFAULT_ENTITY_COLORS.length]!;
}

/**
 * The colour a database's glyph should wear: the one it was given (when it names a real palette entry), else its
 * default. `null` only when there is no id to derive one from (a hit that carries no database id), never a grey.
 */
export function databaseColor(color: string | null | undefined, id: string | null | undefined): string | null {
  if (color && OPTION_COLORS[color]) return color;
  return id ? defaultEntityColor(id) : null;
}
