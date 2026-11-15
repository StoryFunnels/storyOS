import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { fieldType } from '../db/schema';

/**
 * Tickets #983 / #984 — the ONE definition of "this record has no value for this field", used by every count that says how many records
 * carry data or do not (the text → choice dry run's `empty_records`, delete-field's `records_with_value`).
 *
 * EMPTY means: the key is absent, or the value is null, or a string with nothing but whitespace, or an empty list. Anything else is a
 * value, including `0` and `false` (a number or a checkbox that was set is data, not a blank).
 *
 * Why this file exists: `empty_records` was counting only some blanks and `records_with_value` counted key PRESENCE, so the same field
 * showed two different "how many records are blank" answers on two screens. Each count was a private reading of "has a value"; they
 * drifted. There is one JS predicate and one SQL predicate here, both built from the same whitespace pattern, and a test that runs the
 * same table of values through both so they cannot diverge unnoticed.
 */

/** What JavaScript's `String.prototype.trim` strips (WhiteSpace + LineTerminator), as one regex class both JS and Postgres understand. */
export const BLANK_TEXT_PATTERN = '^[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]*$';
const BLANK_TEXT = new RegExp(BLANK_TEXT_PATTERN);

/** True when a stored field value (or its absence) counts as "no value". */
export function isEmptyFieldValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return BLANK_TEXT.test(value);
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/** The same predicate in SQL: true when the record's jsonb `values` holds a NON-empty value under `fieldId`. */
export function hasFieldValueSql(valuesColumn: AnyPgColumn | SQL, fieldId: string): SQL {
  const v = sql`(${valuesColumn} -> ${fieldId}::text)`;
  return sql`(${v} IS NOT NULL
    AND jsonb_typeof(${v}) <> 'null'
    AND NOT (jsonb_typeof(${v}) = 'string' AND (${v} #>> '{}') ~ ${BLANK_TEXT_PATTERN})
    AND NOT (jsonb_typeof(${v}) = 'array' AND jsonb_array_length(${v}) = 0))`;
}

/**
 * Ticket #1308 — WHERE a field's value lives, per field type, as ONE table.
 *
 * `usageCount` only ever read `records.values`, so `get_field_usage` answered 0 for every field whose data is stored somewhere else:
 * a relation (rows in `record_links`), the title (a column), the system fields (columns), and the computed types (`computed_values`,
 * or nothing at all for a lookup). 0 read as "safe to delete" for a field that held data. The map is a `Record` over the database's own
 * field-type enum, so a new field type does not compile until someone says where its value is stored.
 *
 * - `record_values`       a key in `records.values` (the default; attachment ids and user ids live here too).
 * - `title`               the `records.title` column.
 * - `system_column`       `number`, `created_at`, `updated_at`, `created_by`: columns of `records`, never in `values`.
 * - `record_links`        rows in `record_links` (a relation field).
 * - `computed_values`     a key in `records.computed_values`, written by the server (formula, rollup, ai).
 * - `derived_from_links`  stored nowhere: read through a relation from the far record's own value (lookup).
 * - `none`                no value at all (button), so a count of 0 is exact.
 */
export type FieldValueStorage =
  | 'record_values'
  | 'title'
  | 'system_column'
  | 'record_links'
  | 'computed_values'
  | 'derived_from_links'
  | 'none';

export type FieldTypeName = (typeof fieldType.enumValues)[number];

export const FIELD_VALUE_STORAGE: Record<FieldTypeName, FieldValueStorage> = {
  id: 'system_column',
  title: 'title',
  text: 'record_values',
  rich_text: 'record_values',
  number: 'record_values',
  checkbox: 'record_values',
  date: 'record_values',
  select: 'record_values',
  multi_select: 'record_values',
  workflow: 'record_values',
  url: 'record_values',
  email: 'record_values',
  color: 'record_values',
  user: 'record_values',
  attachment: 'record_values',
  relation: 'record_links',
  lookup: 'derived_from_links',
  rollup: 'computed_values',
  button: 'none',
  formula: 'computed_values',
  ai: 'computed_values',
  created_at: 'system_column',
  updated_at: 'system_column',
  created_by: 'system_column',
};

/** The columns of a `records` row a presence test may read. Passed in so the same test runs against `records` and against an aliased far-side row. */
export interface RecordColumns {
  values: AnyPgColumn | SQL;
  computedValues: AnyPgColumn | SQL;
  title: AnyPgColumn | SQL;
  number: AnyPgColumn | SQL;
  createdBy: AnyPgColumn | SQL;
}

/**
 * True when the record holds a non-empty value for a field whose storage is ON THE RECORD ROW (everything except `record_links`,
 * `derived_from_links` and `none`, which the usage counter answers from other tables). Emptiness is the one definition above, and the
 * title uses the same blank-text pattern. `null` for a storage that is not on the row, so a caller cannot mistake it for "no value".
 */
export function recordRowHasValueSql(
  storage: FieldValueStorage,
  type: string,
  fieldId: string,
  cols: RecordColumns,
): SQL | null {
  switch (storage) {
    case 'record_values':
      return hasFieldValueSql(cols.values, fieldId);
    case 'computed_values':
      return hasFieldValueSql(cols.computedValues, fieldId);
    case 'title':
      return sql`(${cols.title} IS NOT NULL AND NOT (${cols.title} ~ ${BLANK_TEXT_PATTERN}))`;
    case 'system_column':
      if (type === 'id') return sql`(${cols.number} IS NOT NULL)`;
      if (type === 'created_by') return sql`(${cols.createdBy} IS NOT NULL)`;
      return sql`TRUE`; // created_at / updated_at are NOT NULL on every record
    default:
      return null;
  }
}
