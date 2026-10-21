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
 * The eight are the prototype's `--c1`..`--c8` (light and dark values in globals.css), each at least 3:1 against both
 * sidebars in both themes — the bar for a glyph; the light gold is darker than the prototype's, which is only 2.07:1.
 */
/**
 * The eight default colours, in HASH ORDER (index = hashId(id) % 8), each as its app token (`--c1`..`--c8`, which have a
 * light and a dark value in globals.css, the prototype's palette) and the picker palette NAME it corresponds to.
 * THE CONTRACT with the server's backfill of stored greys (ticket #1016): the same hash, the same order, so a backfilled
 * database is stored under the name of the colour its default already showed. Changing this list or the hash recolours
 * every workspace, which is why the test pins known ids.
 */
export const DEFAULT_ENTITY_PALETTE = [
  { token: 'c1', name: 'gold' },
  { token: 'c2', name: 'blue' },
  { token: 'c3', name: 'green' },
  { token: 'c4', name: 'red' },
  { token: 'c5', name: 'purple' },
  { token: 'c6', name: 'teal' },
  { token: 'c7', name: 'orange' },
  { token: 'c8', name: 'brown' },
] as const;
export const DEFAULT_ENTITY_COLORS = DEFAULT_ENTITY_PALETTE.map((p) => p.token);

/** A default-colour token key (`c1`..`c8`), as opposed to a picker palette name. */
export function isEntityToken(color: string | null | undefined): boolean {
  return /^c[1-8]$/.test(color ?? '');
}

/**
 * The CSS colour for a database colour value: a default token is `var(--cN)` (theme-aware, so dark mode gets the
 * prototype's dark set); a person-chosen picker name is its fixed palette hex, exactly as before.
 */
export function entityColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  return isEntityToken(color) ? `var(--${color})` : OPTION_COLORS[color];
}

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
export function defaultEntityColor(id: string): string {
  return DEFAULT_ENTITY_PALETTE[hashId(id) % DEFAULT_ENTITY_PALETTE.length]!.token;
}

/**
 * The colour a database's glyph should wear: the one it was given (when it names a real palette entry), else its
 * default. `null` only when there is no id to derive one from (a hit that carries no database id), never a grey.
 */
export function databaseColor(color: string | null | undefined, id: string | null | undefined): string | null {
  if (color && OPTION_COLORS[color]) return color;
  return id ? defaultEntityColor(id) : null;
}
