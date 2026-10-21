import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

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
export function hasFieldValueSql(valuesColumn: AnyPgColumn, fieldId: string): SQL {
  const v = sql`(${valuesColumn} -> ${fieldId}::text)`;
  return sql`(${v} IS NOT NULL
    AND jsonb_typeof(${v}) <> 'null'
    AND NOT (jsonb_typeof(${v}) = 'string' AND (${v} #>> '{}') ~ ${BLANK_TEXT_PATTERN})
    AND NOT (jsonb_typeof(${v}) = 'array' AND jsonb_array_length(${v}) = 0))`;
}
