import { DEFAULT_ENTITY_COLORS } from '@storyos/schemas';

/**
 * #1094 — a space made by one click is born with a colour: the NEXT hue of the default palette.
 *
 * The API stores whatever colour a create sends and sends none of its own (`SpacesService.create`: `color: input.color`), so
 * the choice is made here, from the palette the product already uses for default entity colours (`DEFAULT_ENTITY_COLORS` in
 * `@storyos/schemas`, the eight hues every surface draws with and all valid space colours). Nothing new is invented.
 *
 * "Next" = the hue after the one on the most recently created coloured space, wrapping round, so spaces made one after another
 * do not repeat a colour until the eight run out. With no coloured space yet it starts at the first hue. Existing uncoloured
 * spaces keep the neutral grey: nothing here writes to them (no backfill, no migration).
 */
export interface SpaceForColor {
  color: string | null;
  createdAt?: string | null;
  position: number;
  personal?: boolean;
}

export function nextSpaceColor(spaces: ReadonlyArray<SpaceForColor>): string {
  const palette: readonly string[] = DEFAULT_ENTITY_COLORS;
  const coloured = spaces.filter((s) => !s.personal && s.color && palette.includes(s.color));
  // Most recently created first; `position` stands in when the list carries no creation time (new spaces take the last slot).
  const latest = [...coloured].sort(
    (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.position - a.position,
  )[0];
  if (!latest) return palette[0]!;
  return palette[(palette.indexOf(latest.color!) + 1) % palette.length]!;
}
