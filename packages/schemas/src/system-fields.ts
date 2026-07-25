import type { FilterOp } from './query';
import type { FieldDef } from './record-values';

/**
 * The canonical SYSTEM-FIELD registry (#351) — the single source of truth for
 * the built-in columns every database has, so the filter/sort resolver, the API,
 * the MCP `describe_database`, and any UI enumerate the SAME set from ONE place
 * instead of each hardcoding its own idea of what a "system field" is.
 *
 * Background: system fields (`id`, `created_at`, `updated_at`, `created_by`)
 * already exist as real rows in the `fields` table (created with every database),
 * and the query-compiler already knows how to turn their `type` into a real
 * column. What was missing was (a) a canonical, introspectable description of
 * WHICH ops/sorts each one allows, (b) two fields with no stored row at all —
 * `number` (the sequential public id, historically only addressable under the
 * `id` api_name) and `updated_by` (the `records.updated_by` column had no field
 * row and no compiler branch), and (c) a way for every surface to enumerate them.
 *
 * This registry is applied ADDITIVELY: a real (user or stored-system) field with
 * the same api_name always wins, so a user database that legitimately has its own
 * field called `number` is never shadowed. See systemFieldDefsFor().
 */

/** The compiler `type` discriminator each system field resolves through. These
 * mirror the field_type values the query-compiler's `fieldExpr`/`sortExpr` switch
 * on; `id` maps to `records.number` (the historical record-number wart). */
export type SystemFieldType = 'id' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by';

export interface SystemFieldSpec {
  /** Public api_name used in filters/sorts and describe output. */
  api_name: string;
  /** Human display name (matches the stored system-field row where one exists). */
  display_name: string;
  /** The compiler field-type this resolves through (→ a real column, never JSONB). */
  type: SystemFieldType;
  /** Operators the filter resolver accepts for this field — the authority the
   * compiler validates against, so an unsupported op is a clear, uniform error. */
  filter_ops: FilterOp[];
  /** Whether this field can be used as a sort key (stable via the id tiebreak). */
  sortable: boolean;
  /** System fields are never client-writable. */
  read_only: true;
}

const NUMBER_OPS: FilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'];
const DATE_OPS: FilterOp[] = ['eq', 'neq', 'before', 'after', 'within', 'is_empty', 'not_empty'];
const USER_OPS: FilterOp[] = ['eq', 'neq', 'has', 'has_none', 'is_empty', 'not_empty'];

/**
 * The canonical set. Order is the order surfaces should present them in.
 *
 * `number` and `id` both resolve to `records.number` (the sequential public id):
 * `number` is the canonical, self-describing name (fixes the live "unknown field
 * number" failure), `id` is kept because it is the long-standing, tested handle
 * for the same value (public-record-id contract). The record's UUID is always
 * returned as the top-level `id` on every record, but is not itself a filterable
 * system field (its api_name is taken by the record-number handle).
 */
export const SYSTEM_FIELDS: readonly SystemFieldSpec[] = [
  {
    api_name: 'number',
    display_name: 'Number',
    type: 'id',
    filter_ops: NUMBER_OPS,
    sortable: true,
    read_only: true,
  },
  {
    api_name: 'id',
    display_name: 'ID',
    type: 'id',
    filter_ops: NUMBER_OPS,
    sortable: true,
    read_only: true,
  },
  {
    api_name: 'created_at',
    display_name: 'Created at',
    type: 'created_at',
    filter_ops: DATE_OPS,
    sortable: true,
    read_only: true,
  },
  {
    api_name: 'updated_at',
    display_name: 'Updated at',
    type: 'updated_at',
    filter_ops: DATE_OPS,
    sortable: true,
    read_only: true,
  },
  {
    api_name: 'created_by',
    display_name: 'Created by',
    type: 'created_by',
    filter_ops: USER_OPS,
    sortable: true,
    read_only: true,
  },
  {
    api_name: 'updated_by',
    display_name: 'Updated by',
    type: 'updated_by',
    filter_ops: USER_OPS,
    sortable: true,
    read_only: true,
  },
] as const;

export const SYSTEM_FIELD_BY_API_NAME: ReadonlyMap<string, SystemFieldSpec> = new Map(
  SYSTEM_FIELDS.map((f) => [f.api_name, f]),
);

/** The set of compiler types that denote a system (column-backed) field. */
export const SYSTEM_FIELD_TYPES: ReadonlySet<string> = new Set(SYSTEM_FIELDS.map((f) => f.type));

export function isSystemFieldApiName(apiName: string): boolean {
  return SYSTEM_FIELD_BY_API_NAME.has(apiName);
}

/** A stable synthetic field-id for a system field. System fields resolve to real
 * columns, so this id is never used to key into the JSONB `values` bag — it just
 * has to be present and stable on the FieldDef the resolver consumes. */
export function systemFieldId(apiName: string): string {
  return `__sys_${apiName}`;
}

/** The FieldDef shape the record-value validator / query-compiler consumes. */
export function systemFieldDef(spec: SystemFieldSpec): FieldDef {
  return {
    id: systemFieldId(spec.api_name),
    api_name: spec.api_name,
    type: spec.type,
    config: {},
  };
}

/**
 * Additive overlay for the filter/sort resolver: every system field that is not
 * already provided by a real (user or stored-system) field row, as FieldDefs.
 * Real fields always win — a user field literally named `number` is preserved.
 */
export function systemFieldDefsFor(existingApiNames: Iterable<string>): FieldDef[] {
  const present = new Set(existingApiNames);
  return SYSTEM_FIELDS.filter((f) => !present.has(f.api_name)).map(systemFieldDef);
}

/** Whether `op` is allowed on the given system field. */
export function systemFieldAllowsOp(apiName: string, op: FilterOp): boolean {
  const spec = SYSTEM_FIELD_BY_API_NAME.get(apiName);
  return spec ? spec.filter_ops.includes(op) : false;
}
