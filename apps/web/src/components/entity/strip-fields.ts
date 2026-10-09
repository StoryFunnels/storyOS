import type { Field } from '@/components/table-view/use-table-data';
import type { Zone } from './entity-field-utils';
import { isCollection, zonesOf } from './entity-field-utils';

/**
 * #809 — which fields the chip row under the record title shows.
 *
 * The row reads the stored `top` zone (the same `entity_zones` the old pin-to-top strip wrote, so
 * there is no parallel setting). A database that has never been configured has NO field in `top`
 * — the default zone is `sidebar` — and for it the row falls back to today's type heuristic
 * (the workflow field, then the first user field, then the first date field), so an unconfigured
 * database renders exactly what it rendered before this existed ("unconfigured is not invalid").
 */
export interface StripSelection {
  fields: Field[];
  /** True when the row comes from stored config, false when it is the type heuristic. */
  configured: boolean;
}

export function stripFields({
  topFields,
  visibleFields,
  unifiedFields,
}: {
  /** Visible fields whose stored zones include `top`, in record order. */
  topFields: Field[];
  visibleFields: Field[];
  unifiedFields: Field[];
}): StripSelection {
  if (topFields.length > 0) return { fields: topFields, configured: true };
  const heuristic = [
    visibleFields.find((f) => f.type === 'workflow'),
    unifiedFields.find((f) => f.type === 'user'),
    unifiedFields.find((f) => f.type === 'date'),
  ].filter((f): f is Field => Boolean(f));
  return { fields: heuristic, configured: false };
}

/** What may sit in the row: a to-many relation or rich text is body-locked and never a chip. */
export function canPinToStrip(f: Field): boolean {
  return f.type !== 'rich_text' && !isCollection(f);
}

/** A field's zones with `top` added or removed. Removing the last zone returns it to the sidebar, never hides it. */
export function zonesWithTop(f: Field, on: boolean): Zone[] {
  const rest = zonesOf(f).filter((z) => z !== 'top');
  if (on) return ['top', ...rest];
  return rest.length > 0 ? rest : ['sidebar'];
}

export interface ZoneWrite {
  field: Field;
  zones: Zone[];
}

/**
 * The config writes that make `field` a member of the row (or not).
 *
 * When the row is still the automatic one, the first change MATERIALISES what is on screen
 * before applying it: otherwise pinning one field would make that field the whole row and
 * silently drop the state, assignee and due chips the person was looking at.
 */
export function stripPlan({
  current,
  field,
  on,
}: {
  current: StripSelection;
  field: Field;
  on: boolean;
}): ZoneWrite[] {
  const target = current.fields.filter((f) => f.id !== field.id);
  if (on) target.push(field);
  const targetIds = new Set(target.map((f) => f.id));
  const writes: ZoneWrite[] = [];
  for (const f of target) {
    if (!zonesOf(f).includes('top')) writes.push({ field: f, zones: zonesWithTop(f, true) });
  }
  // Only a configured row has fields to take OUT; the automatic one has nothing stored in `top`.
  if (current.configured) {
    for (const f of current.fields) {
      if (!targetIds.has(f.id)) writes.push({ field: f, zones: zonesWithTop(f, false) });
    }
  }
  return writes;
}
