/**
 * The colour palette. One list, one source (#399).
 *
 * There were three hardcoded copies: `OPTION_COLORS` (15), `databaseColorSchema`
 * (10) and `spaceColorSchema` (10). Counted rather than eyeballed, because the
 * ticket's first draft undercounted at two:
 *
 *   - the database list is a strict PREFIX of the option list;
 *   - the space list is byte-identical to the database one.
 *
 * So it was never three palettes. It was one palette and two copies of its first
 * ten, which is drift, not design.
 *
 * ## The decision, and why
 *
 * **Every surface gets all fifteen.**
 *
 * The alternative — keep containers at ten and call it a deliberate cap — was
 * rejected because there is no evidence anyone decided it. The five extras sit
 * at the END of the option list, which is the signature of a later addition that
 * the copies never received; neither copy carried a comment; and no rule a user
 * could infer explains why `indigo` is a valid status colour and an invalid
 * database colour. Inventing a justification for what was almost certainly an
 * oversight would be worse than removing it.
 *
 * Widening is also the only safe direction. Narrowing options to ten would
 * invalidate every existing `lime`/`cyan`/`indigo`/`magenta`/`rose` option —
 * the ticket's own constraint is that no database or option loses its current
 * colour.
 *
 * If a future reader DOES want a smaller set for a scannable surface, express it
 * as a filter of this list with the reason attached, never as a retyped copy.
 * That is what put us here.
 */
export const PALETTE = [
  'gray',
  'brown',
  'gold',
  'orange',
  'red',
  'pink',
  'purple',
  'blue',
  'teal',
  'green',
  'lime',
  'cyan',
  'indigo',
  'magenta',
  'rose',
] as const;

export type PaletteColor = (typeof PALETTE)[number];

/**
 * The ten that every surface has always accepted.
 *
 * Kept ONLY so a test can assert that the widening is additive — that nothing
 * which used to be a valid container colour stopped being one. Not for
 * validation: nothing should narrow to this set without a stated reason.
 */
export const LEGACY_CONTAINER_COLORS = PALETTE.slice(0, 10);
