import { SYSTEM_FIELDS, isSystemFieldApiName, systemFieldId } from '@storyos/schemas';
import type { FilterOp, SystemFieldType } from '@storyos/schemas';
import type { Field } from '../table-view/use-table-data';

/**
 * Web-side overlay for the canonical SYSTEM-FIELD registry (#352, building on
 * #351/#353/#354). The filter/sort controls must offer the built-in record
 * columns — Number, ID, Created, Last edited, Created by, Last edited by —
 * alongside user-defined fields, with type-appropriate operator widgets, and
 * they must enumerate them from the SAME source of truth the API validates
 * against (`@storyos/schemas` SYSTEM_FIELDS) rather than a bespoke hardcoded
 * list. This module is the single seam that turns that registry into the
 * `{ op, label, input }` shape the view-toolbar's OPS_BY_TYPE already speaks,
 * plus the sortable set, direction labels and display labels.
 *
 * Kept dependency-light (only type-only imports besides the registry) so it can
 * be unit-tested in the node/vitest env without pulling in the toolbar's React
 * tree.
 */

/** The value-editor widget kinds the toolbar's FilterValueEditor understands. */
export type FilterInput =
  | 'text'
  | 'number'
  | 'date'
  | 'options'
  | 'relative'
  | 'boolean'
  | 'records'
  | 'none';

export interface OpSpec {
  op: string;
  label: string;
  input: FilterInput;
}

/**
 * User-facing labels for the system fields (ticket #352 copy). Overrides the
 * stored field row's display_name so every view surface reads consistently,
 * regardless of how the row was seeded ("Created at" → "Created", etc.).
 */
export const SYSTEM_FIELD_LABELS: Record<string, string> = {
  number: 'Number',
  id: 'ID',
  created_at: 'Created',
  updated_at: 'Last edited',
  created_by: 'Created by',
  updated_by: 'Last edited by',
};

/**
 * Per-operator widget + label metadata, grouped by the system field's value
 * category. The op SET is never hardcoded here — it's derived from the registry
 * (SYSTEM_FIELDS[].filter_ops) at build time below, and an op is only surfaced
 * if this table knows a widget for it. That guarantees we never render a control
 * for an op the backend rejects, while staying resilient if the registry's op
 * list changes.
 */
const NUMBER_OP_META: Record<string, { label: string; input: FilterInput }> = {
  eq: { label: '=', input: 'number' },
  neq: { label: '≠', input: 'number' },
  gt: { label: '>', input: 'number' },
  gte: { label: '≥', input: 'number' },
  lt: { label: '<', input: 'number' },
  lte: { label: '≤', input: 'number' },
  is_empty: { label: 'is empty', input: 'none' },
  not_empty: { label: 'is not empty', input: 'none' },
};

const DATE_OP_META: Record<string, { label: string; input: FilterInput }> = {
  eq: { label: 'on', input: 'date' },
  neq: { label: 'is not', input: 'date' },
  before: { label: 'before', input: 'date' },
  after: { label: 'after', input: 'date' },
  within: { label: 'within', input: 'relative' },
  is_empty: { label: 'is empty', input: 'none' },
  not_empty: { label: 'is not empty', input: 'none' },
};

/**
 * User (created_by/updated_by) widgets. We deliberately expose only the
 * set-membership idiom (has/has_none) plus emptiness — those carry an array
 * value the members picker produces and the compiler's IN-list branch accepts.
 * `eq`/`neq` are valid registry ops but expect a scalar user id; rather than
 * ship a second single-select widget that could send an array to a scalar op,
 * we present "is any of"/"is none of", which cover the same intent safely.
 */
const USER_OP_META: Record<string, { label: string; input: FilterInput }> = {
  has: { label: 'is any of', input: 'options' },
  has_none: { label: 'is none of', input: 'options' },
  is_empty: { label: 'is empty', input: 'none' },
  not_empty: { label: 'is not empty', input: 'none' },
};

const OP_META_BY_TYPE: Record<SystemFieldType, Record<string, { label: string; input: FilterInput }>> = {
  id: NUMBER_OP_META,
  created_at: DATE_OP_META,
  updated_at: DATE_OP_META,
  created_by: USER_OP_META,
  updated_by: USER_OP_META,
};

/** Preserve the registry's op order, keep only ops we can render a widget for. */
function opsFor(type: SystemFieldType, filterOps: readonly FilterOp[]): OpSpec[] {
  const meta = OP_META_BY_TYPE[type];
  const out: OpSpec[] = [];
  for (const op of filterOps) {
    const widget = meta[op];
    if (widget) out.push({ op, label: widget.label, input: widget.input });
  }
  return out;
}

/**
 * OPS_BY_TYPE fragment for the system field compiler types, derived from the
 * registry. Merged into the toolbar's OPS_BY_TYPE so a system field passes the
 * `OPS_BY_TYPE[f.type]` filterability gate and gets the right operator menu.
 * Keyed by compiler `type` — `number` and `id` share type `id`.
 */
export const SYSTEM_FIELD_OPS: Record<string, OpSpec[]> = (() => {
  const out: Record<string, OpSpec[]> = {};
  for (const spec of SYSTEM_FIELDS) {
    // number and id share the `id` compiler type — build once.
    if (out[spec.type]) continue;
    out[spec.type] = opsFor(spec.type, spec.filter_ops);
  }
  return out;
})();

/** The system field compiler types that are sortable (all of them, per #351). */
export const SYSTEM_SORTABLE_TYPES: string[] = SYSTEM_FIELDS.filter((f) => f.sortable).map((f) => f.type);

/** Direction-label idioms for the sort builder, per system value category. */
export const SYSTEM_DIRECTION_LABELS: Record<string, { asc: string; desc: string }> = {
  id: { asc: '1 → 9', desc: '9 → 1' },
  created_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  updated_at: { asc: 'Oldest → newest', desc: 'Newest → oldest' },
  created_by: { asc: 'A → Z', desc: 'Z → A' },
  updated_by: { asc: 'A → Z', desc: 'Z → A' },
};

/** The compiler types treated as "user" (member-picker) system fields. */
export const SYSTEM_USER_TYPES: ReadonlySet<string> = new Set(['created_by', 'updated_by']);

/**
 * Augment the introspected field list with the full canonical system-field set,
 * so filter & sort surfaces can enumerate all six. Real fields always win: a
 * user-defined field literally named `number` keeps its own label and blocks the
 * synthetic overlay (registry semantics — additive, real wins). System fields
 * that already exist as stored rows (id/created_at/updated_at/created_by) are
 * relabeled to the ticket copy; the two with no stored row (number/updated_by)
 * are appended as synthetic read-only fields.
 */
export function withSystemFields(fields: Field[]): Field[] {
  const relabeled = fields.map((f) =>
    f.isSystem && isSystemFieldApiName(f.apiName)
      ? { ...f, displayName: SYSTEM_FIELD_LABELS[f.apiName] ?? f.displayName }
      : f,
  );
  const present = new Set(fields.map((f) => f.apiName));
  const synthetic: Field[] = SYSTEM_FIELDS.filter((s) => !present.has(s.api_name)).map((s) => ({
    id: systemFieldId(s.api_name),
    apiName: s.api_name,
    displayName: SYSTEM_FIELD_LABELS[s.api_name] ?? s.display_name,
    type: s.type,
    config: {},
    isSystem: true,
  }));
  return [...relabeled, ...synthetic];
}
