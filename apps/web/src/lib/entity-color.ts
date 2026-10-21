import { DEFAULT_ENTITY_COLORS as DEFAULT_ENTITY_NAMES, hashId } from '@storyos/schemas';
import { OPTION_COLORS } from '@/components/table-view/option-colors';

export { hashId };

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
 * The eight default colours, in HASH ORDER (index = hashId(id) % 8). The hash, the order and the picker NAMES come from
 * `@storyos/schemas` — ONE definition shared with the API and with the migration that backfills stored greys (ticket
 * #1016), so a database's default is the same colour in a response and in the sidebar. The web adds only the app TOKEN
 * for each (`--c1`..`--c8`, with a light and a dark value in globals.css, the prototype's palette).
 */
export const DEFAULT_ENTITY_PALETTE = DEFAULT_ENTITY_NAMES.map((name, i) => ({ token: `c${i + 1}`, name }));
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
