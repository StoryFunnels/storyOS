import type { Field } from '@/components/table-view/use-table-data';
import type { Zone } from './entity-field-utils';
import { isCollection, isEmptyValue, zonesOf } from './entity-field-utils';

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

/**
 * #937 — the fields the grid below the title shows: everything the row under the title does NOT already show,
 * and nothing that was promoted to its own block. A field appears once on the record page; unpinning it from
 * the row (so it leaves `strip.fields`) is what puts it back in the grid.
 */
export function gridFieldsExcludingStrip<T extends { id: string }>(
  unifiedFields: T[],
  strip: { fields: Array<{ id: string }> },
  promoted: Array<{ id: string }> = [],
): T[] {
  const hidden = new Set([...strip.fields, ...promoted].map((f) => f.id));
  return unifiedFields.filter((f) => !hidden.has(f.id));
}

/**
 * #1019 — what the strip draws, and what it keeps out of sight.
 *
 *   - `shown`: properties with a value, plus any the person has asked to fill in ("+ Add property"). Each is one
 *     chip; an empty property is NOT drawn as a grey placeholder box.
 *   - `absent`: empty properties, reachable through "+ Add property" and, as always, the Details section below —
 *     nothing loses its edit path.
 *   - `buttons`: action fields (Mark as Done). An action is a button, not a property chip, so it is kept apart
 *     and drawn as one.
 */
/**
 * Ticket #1060 — a field's value as the plain text a tooltip or screen reader says ("Low", "Illia", "StoryOS-security"), for the
 * strip's "Priority: Low". Never invents: a value this cannot read as words returns null and the name alone is used.
 */
export function plainValue(
  field: Field,
  value: unknown,
  names: ReadonlyMap<string, string>,
): string | null {
  if (isEmptyValue(value)) return null;
  const optionLabel = (id: unknown) => field.options?.find((o) => o.id === id)?.label;
  switch (field.type) {
    case 'select':
    case 'workflow':
      return optionLabel(value) ?? null;
    case 'multi_select':
      return Array.isArray(value) ? (value as unknown[]).map(optionLabel).filter(Boolean).join(', ') || null : null;
    case 'user':
    case 'created_by': {
      const ids = Array.isArray(value) ? (value as string[]) : [String(value)];
      return ids.map((id) => names.get(id) ?? '').filter(Boolean).join(', ') || null;
    }
    case 'relation':
      return Array.isArray(value)
        ? (value as Array<{ title?: string | null }>).map((c) => c.title || 'Untitled').join(', ') || null
        : null;
    case 'checkbox':
      return value === true ? 'Yes' : 'No';
    case 'number':
    case 'text':
    case 'email':
    case 'url':
    case 'date':
      return String(value);
    default:
      return null;
  }
}

/** "Priority: Low", or just "Priority" when the value cannot be said in words. */
export function fieldTitle(field: Field, value: unknown, names: ReadonlyMap<string, string>): string {
  const said = plainValue(field, value, names);
  return said ? `${field.displayName}: ${said}` : field.displayName;
}

/** Types a person can fill in from the strip. A computed, system or body-only field never is. */
const NOT_ADDABLE = new Set(['title', 'id', 'created_at', 'updated_at', 'created_by', 'lookup', 'rollup', 'formula', 'button', 'rich_text', 'ai']);

/**
 * "+ Add property" lists the EMPTY strip-eligible fields that are not already drawn: the strip's own empty ones and any other empty
 * field a person could fill in here. Nothing is offered that is computed, a system field, a body section or already shown.
 */
export function addableProperties(
  candidates: Field[],
  shown: Field[],
  valueOf: (f: Field) => unknown,
): Field[] {
  const drawn = new Set(shown.map((f) => f.id));
  return candidates.filter(
    (f) => !drawn.has(f.id) && !NOT_ADDABLE.has(f.type) && canPinToStrip(f) && isEmptyValue(valueOf(f)),
  );
}

export function partitionStrip(
  fields: Field[],
  valueOf: (f: Field) => unknown,
  revealed: ReadonlySet<string>,
): { shown: Field[]; absent: Field[]; buttons: Field[] } {
  const buttons = fields.filter((f) => f.type === 'button');
  const props = fields.filter((f) => f.type !== 'button');
  const shown = props.filter((f) => revealed.has(f.id) || !isEmptyValue(valueOf(f)));
  return { shown, absent: props.filter((f) => !shown.includes(f)), buttons };
}
