import type { Field } from '@/components/table-view/use-table-data';

/**
 * #739 AC1/T1, CORRECTED per Otto post-ship — a fresh table view's default
 * column set, DERIVED from the schema rather than enumerated by name.
 *
 * The original version hardcoded `['state', 'priority', 'type', 'next']` —
 * the exact defect CLAUDE.md rule 3's file list was deleted for, reproduced
 * inside this ticket's own AC by the product owner who wrote it. Measured
 * cost: on two of seven real databases Dara sampled, none of those four
 * names exist, so the "default" degraded to ID + Name alone — worse than
 * the pre-#739 24-column table for exactly the users this ticket was for.
 *
 * THE RULE (Otto, corrected): ID and the title field are always visible —
 * both handled unconditionally elsewhere (table-view.tsx's own numberEntry
 * default-visible logic, and title never being hideable at all), so this
 * function only selects the up-to-FOUR fields alongside them:
 *
 *   1. Prefer fields by TYPE, in this order: workflow, select, user,
 *      relation — the types most likely to distinguish one record from
 *      another at a glance. Within one type, schema (field.position) order.
 *   2. If fewer than four preferred-type fields exist, fill the remaining
 *      slots from any other eligible field, in schema order — a sparse
 *      database still gets the best six columns it has, not a four-or-fewer
 *      column table for lack of a workflow/select/user/relation field.
 *   3. Eligible excludes: rich_text (#739 AC2 — never offered as a column
 *      at all), HIDDEN_TYPES (id/created_by — never rendered as an ordinary
 *      column), system dates (created_at/updated_at — off by default per
 *      AC3, not promoted into the default six), and button (an action, not
 *      a value).
 *
 * On storyos/issues (state:workflow, priority:select, assignee:user,
 * type:select, epic:relation, agents/"Next":relation, in that schema
 * order) this yields ID / Name / State / Priority / Type / ASSIGNEE — not
 * "Next". That is the rule working as designed, not a regression: "Next"
 * is an agents-relation specific to this workspace's own ten-agent fleet,
 * not a pattern every workspace has: Assignee is. A hand-picked list that
 * happened to encode OUR workflow as if it were universal is exactly the
 * failure this derivation exists to prevent.
 */
const PREFERRED_TYPE_ORDER = ['workflow', 'select', 'user', 'relation'] as const;
const INELIGIBLE_TYPES = new Set(['rich_text', 'id', 'created_by', 'created_at', 'updated_at', 'button']);
const DEFAULT_COLUMN_COUNT = 4;

/**
 * The `hidden_field_ids` to stamp onto a BRAND-NEW table view at creation
 * time: every field other than title and the derived default-visible set
 * above starts hidden, still addable from Fields. Computed once at creation
 * (not derived at render time from an empty array) because `hidden_field_ids:
 * []` already has an established meaning post-#743 — "nothing hidden, ordinary
 * fields all visible" — so there's no empty-vs-fresh distinction left to hang
 * a runtime default on; the default has to be written down when the view is
 * born.
 */
export function defaultTableHiddenFieldIds(fields: Field[]): string[] {
  const eligible = fields.filter((f) => f.type !== 'title' && !INELIGIBLE_TYPES.has(f.type));
  const preferred = PREFERRED_TYPE_ORDER.flatMap((type) => eligible.filter((f) => f.type === type));
  const rest = eligible.filter((f) => !(PREFERRED_TYPE_ORDER as readonly string[]).includes(f.type));
  const defaultVisible = new Set([...preferred, ...rest].slice(0, DEFAULT_COLUMN_COUNT).map((f) => f.id));

  return fields.filter((f) => f.type !== 'title' && !defaultVisible.has(f.id)).map((f) => f.id);
}
