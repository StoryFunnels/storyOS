import type { Field } from '@/components/table-view/use-table-data';

/**
 * #739 AC1/T1 — a fresh table view's default column set: ID, Name, State,
 * Priority, Type, Next. Matched by api_name against the database's ACTUAL
 * fields, not asserted as a universal default (Dara's own J2: the general
 * rule for "which fields distinguish one record from another" is a per-
 * database judgement call nobody has designed a heuristic for). ID and the
 * title field are handled unconditionally elsewhere (table-view.tsx's own
 * numberEntry default-visible logic, and title never being hideable at all)
 * — this only needs to name the four that vary and may not exist at all on
 * a non-Issues-shaped database, in which case they're simply absent from the
 * result rather than hidden-and-offered.
 */
const DEFAULT_VISIBLE_API_NAMES = new Set(['state', 'priority', 'type', 'next']);

/**
 * The `hidden_field_ids` to stamp onto a BRAND-NEW table view at creation
 * time: every field other than title and the four default-visible names
 * above starts hidden, still addable from Fields. Computed once at creation
 * (not derived at render time from an empty array) because `hidden_field_ids:
 * []` already has an established meaning post-#743 — "nothing hidden, ordinary
 * fields all visible" — so there's no empty-vs-fresh distinction left to hang
 * a runtime default on; the default has to be written down when the view is
 * born.
 */
export function defaultTableHiddenFieldIds(fields: Field[]): string[] {
  return fields
    .filter((f) => f.type !== 'title' && !DEFAULT_VISIBLE_API_NAMES.has(f.apiName))
    .map((f) => f.id);
}
