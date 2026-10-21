import { EntityIcon } from '@/components/ui/icon-picker';
import { DbColorMarker } from '@/components/table-view/relation-cell';
import { databaseColor } from '@/lib/entity-color';

/**
 * #811 — a database's mark beside a chip: its icon, else its colour marker, else
 * NOTHING.
 *
 * "Nothing" is the decision and the point. Chips used to wrap the mark in a flex
 * item unconditionally, so a database with no icon and no usable colour left an
 * empty inline-flex span plus the parent's gap — a blank box before the title that
 * reads as an image that failed to load (Ievgen, 2026-10-01). Returning null here
 * means there is no child to be given a gap, so the text sits flush.
 *
 * What it must KEEP: a database WITH an icon shows it; one with only a colour shows
 * the colour marker (that cylinder is the product's identity for a database, shared
 * with relation chips — it is content, not an empty slot). An icon ref that fails to
 * resolve still falls back to the marker rather than vanishing.
 */
export function hasDbMarker(icon?: string | null, color?: string | null, id?: string | null): boolean {
  // #1001 — a database with an id always has a colour to wear (its stored one, else its stable default), so it always has a mark.
  return Boolean(icon) || Boolean(color) || Boolean(id);
}

export function DbMarker({ icon, color, id }: { icon?: string | null; color?: string | null; id?: string | null }) {
  if (!hasDbMarker(icon, color, id)) return null;
  const resolved = databaseColor(color, id);
  return (
    <EntityIcon
      icon={icon || null}
      color={resolved}
      fallback={<DbColorMarker color={resolved || 'gray'} />}
    />
  );
}
