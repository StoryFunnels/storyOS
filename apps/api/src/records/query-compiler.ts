import { UnprocessableEntityException } from '@nestjs/common';
import { SQL, sql } from 'drizzle-orm';
import type { FieldDef, FilterNode, FilterOp, RelativeDateRange } from '@storyos/schemas';
import { recordLinks, records } from '../db/schema';

/**
 * The filter-AST → SQL compiler (ADR-0002). Everything is parameterized;
 * field references are resolved against live FieldDefs BEFORE compilation,
 * so no user input ever reaches SQL as an identifier.
 *
 * This module and RecordsService are the storage seam — query logic lives
 * here and nowhere else.
 */

export interface CompilerContext {
  defs: Map<string, FieldDef>; // by api_name
  currentUserId: string;
}

const err = (message: string) => new UnprocessableEntityException(message);

export function compileFilter(node: FilterNode, ctx: CompilerContext): SQL {
  if ('and' in node) {
    return joinNodes(node.and.map((n) => compileFilter(n, ctx)), sql` AND `);
  }
  if ('or' in node) {
    return joinNodes(node.or.map((n) => compileFilter(n, ctx)), sql` OR `);
  }
  return compileCondition(node.field, node.op, node.value, ctx);
}

function joinNodes(parts: SQL[], separator: SQL): SQL {
  const joined = sql.join(parts, separator);
  return sql`(${joined})`;
}

/** Typed value expression for a field, extracted from the JSONB values column. */
function fieldExpr(def: FieldDef): SQL {
  if (def.type === 'id') return sql`${records.number}`;
  if (def.type === 'title') return sql`${records.title}`;
  if (def.type === 'created_at') return sql`${records.createdAt}`;
  if (def.type === 'updated_at') return sql`${records.updatedAt}`;
  if (def.type === 'created_by') return sql`${records.createdBy}`;
  if (def.type === 'number') return sql`((${records.values}->>${def.id})::numeric)`;
  if (def.type === 'checkbox') return sql`((${records.values}->>${def.id})::boolean)`;
  return sql`(${records.values}->>${def.id})`;
}

function presentExpr(def: FieldDef): SQL {
  if (def.type === 'id') return sql`(${records.number} IS NOT NULL)`;
  if (def.type === 'title') return sql`(${records.title} <> '')`;
  if (def.type === 'created_at' || def.type === 'updated_at') return sql`TRUE`;
  if (def.type === 'created_by') return sql`(${records.createdBy} IS NOT NULL)`;
  if (def.type === 'multi_select' || (def.type === 'user' && def.config['multi'] === true)) {
    return sql`(${records.values} ? ${def.id} AND jsonb_array_length(${records.values}->${def.id}) > 0)`;
  }
  return sql`(${records.values} ? ${def.id})`;
}

function compileCondition(fieldName: string, op: FilterOp, value: unknown, ctx: CompilerContext): SQL {
  const def = ctx.defs.get(fieldName);
  if (!def) throw err(`unknown field "${fieldName}" in filter`);
  if (def.type === 'relation') return compileRelation(def, op, value);

  if (op === 'is_empty') return sql`NOT ${presentExpr(def)}`;
  if (op === 'not_empty') return presentExpr(def);

  switch (def.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
      return compileTextish(def, op, value);
    case 'id':
    case 'number':
      return compileNumber(def, op, value);
    case 'checkbox': {
      if (op !== 'eq' && op !== 'neq') throw err(`op "${op}" not valid for checkbox`);
      if (typeof value !== 'boolean') throw err('checkbox filters expect a boolean value');
      const expr = fieldExpr(def);
      // Missing key counts as false.
      const isTrue = sql`(COALESCE(${expr}, FALSE) = ${value})`;
      return op === 'eq' ? isTrue : sql`NOT ${isTrue}`;
    }
    case 'date':
    case 'created_at':
    case 'updated_at':
      return compileDate(def, op, value);
    case 'select':
      return compileIdSet(def, op, value, ctx, 'scalar');
    case 'multi_select':
      return compileIdSet(def, op, value, ctx, 'array');
    case 'created_by':
      return compileIdSet(def, op, value, ctx, 'scalar');
    case 'user':
      return compileIdSet(def, op, value, ctx, def.config['multi'] === true ? 'array' : 'scalar');
    default:
      throw err(`filters on "${def.type}" fields are not supported`);
  }
}

function compileTextish(def: FieldDef, op: FilterOp, value: unknown): SQL {
  if (typeof value !== 'string') throw err(`op "${op}" on "${def.api_name}" expects a string value`);
  const expr = fieldExpr(def);
  switch (op) {
    case 'eq':
      return sql`(${expr} = ${value})`;
    case 'neq':
      return sql`(${expr} IS DISTINCT FROM ${value})`;
    case 'contains':
      return sql`(${expr} ILIKE ${'%' + escapeLike(value) + '%'})`;
    default:
      throw err(`op "${op}" not valid for ${def.type}`);
  }
}

function compileNumber(def: FieldDef, op: FilterOp, value: unknown): SQL {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`op "${op}" on "${def.api_name}" expects a number value`);
  }
  const expr = fieldExpr(def);
  switch (op) {
    case 'eq':
      return sql`(${expr} = ${value})`;
    case 'neq':
      return sql`(${expr} IS DISTINCT FROM ${value})`;
    case 'gt':
      return sql`(${expr} > ${value})`;
    case 'gte':
      return sql`(${expr} >= ${value})`;
    case 'lt':
      return sql`(${expr} < ${value})`;
    case 'lte':
      return sql`(${expr} <= ${value})`;
    default:
      throw err(`op "${op}" not valid for number`);
  }
}

const RELATIVE_RANGES: Record<RelativeDateRange, () => { from: Date; to: Date }> = {
  today: () => dayRange(0, 1),
  yesterday: () => dayRange(-1, 0),
  tomorrow: () => dayRange(1, 2),
  last_7_days: () => dayRange(-7, 1),
  next_7_days: () => dayRange(0, 8),
  this_month: () => {
    const now = new Date();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return { from, to };
  },
  next_30_days: () => dayRange(0, 31),
};

function dayRange(fromOffsetDays: number, toOffsetDays: number): { from: Date; to: Date } {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    from: new Date(midnight + fromOffsetDays * 86_400_000),
    to: new Date(midnight + toOffsetDays * 86_400_000),
  };
}

function compileDate(def: FieldDef, op: FilterOp, value: unknown): SQL {
  const expr = fieldExpr(def);
  const isTimestampCol = def.type === 'created_at' || def.type === 'updated_at';

  if (op === 'within') {
    const range = RELATIVE_RANGES[value as RelativeDateRange];
    if (!range) throw err(`"within" expects one of: ${Object.keys(RELATIVE_RANGES).join(', ')}`);
    const { from, to } = range();
    if (isTimestampCol) return sql`(${expr} >= ${from} AND ${expr} < ${to})`;
    const fromStr = from.toISOString();
    const toStr = to.toISOString();
    // Stored ISO strings (date-only or full) compare lexicographically.
    return sql`(${expr} >= ${fromStr.slice(0, 10)} AND ${expr} < ${toStr})`;
  }

  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw err(`op "${op}" on "${def.api_name}" expects an ISO date value`);
  }
  const cmp = isTimestampCol ? new Date(value) : value;
  switch (op) {
    case 'eq':
      return sql`(${expr} = ${cmp})`;
    case 'neq':
      return sql`(${expr} IS DISTINCT FROM ${cmp})`;
    case 'before':
      return sql`(${expr} < ${cmp})`;
    case 'after':
      return sql`(${expr} > ${cmp})`;
    default:
      throw err(`op "${op}" not valid for date`);
  }
}

/** select / user / created_by (scalar id) and multi_select / multi user (id array). */
function compileIdSet(
  def: FieldDef,
  op: FilterOp,
  value: unknown,
  ctx: CompilerContext,
  shape: 'scalar' | 'array',
): SQL {
  if (op === 'eq' || op === 'neq') {
    if (shape !== 'scalar') throw err(`use has/has_none for ${def.type} fields`);
    const resolved = resolveMe(def, value, ctx);
    if (typeof resolved !== 'string') throw err(`op "${op}" on "${def.api_name}" expects an id`);
    assertValidOptionId(def, resolved);
    const expr = fieldExpr(def);
    return op === 'eq' ? sql`(${expr} = ${resolved})` : sql`(${expr} IS DISTINCT FROM ${resolved})`;
  }

  if (op !== 'has' && op !== 'has_none') throw err(`op "${op}" not valid for ${def.type}`);
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw err(`op "${op}" on "${def.api_name}" expects a non-empty array of ids`);
  }
  const ids = (value as string[]).map((v) => resolveMe(def, v, ctx) as string);
  ids.forEach((id) => assertValidOptionId(def, id));

  const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
  let match: SQL;
  if (shape === 'scalar') {
    match = sql`(${fieldExpr(def)} IN (${list}))`;
  } else {
    match = sql`(${records.values}->${def.id} ?| ARRAY[${list}]::text[])`;
  }
  return op === 'has' ? match : sql`(NOT COALESCE(${match}, FALSE))`;
}

/** Relation filters compile to EXISTS over record_links (ADR-0002). */
function compileRelation(def: FieldDef, op: FilterOp, value: unknown): SQL {
  const relationId = def.config['relation_id'] as string;
  const side = def.config['side'] as 'a' | 'b';
  const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
  const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

  const anyLink = sql`EXISTS (SELECT 1 FROM ${recordLinks} WHERE ${recordLinks.relationId} = ${relationId} AND ${myCol} = ${records.id})`;

  if (op === 'is_empty') return sql`(NOT ${anyLink})`;
  if (op === 'not_empty') return sql`(${anyLink})`;

  if (op !== 'has' && op !== 'has_none') throw err(`op "${op}" not valid for relation fields`);
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string')) {
    throw err(`op "${op}" on "${def.api_name}" expects a non-empty array of record ids`);
  }
  const list = sql.join(
    (value as string[]).map((id) => sql`${id}`),
    sql`, `,
  );
  const match = sql`EXISTS (SELECT 1 FROM ${recordLinks} WHERE ${recordLinks.relationId} = ${relationId} AND ${myCol} = ${records.id} AND ${otherCol} IN (${list}))`;
  return op === 'has' ? sql`(${match})` : sql`(NOT ${match})`;
}

function resolveMe(def: FieldDef, value: unknown, ctx: CompilerContext): unknown {
  if ((def.type === 'user' || def.type === 'created_by') && value === 'me') return ctx.currentUserId;
  return value;
}

function assertValidOptionId(def: FieldDef, id: string) {
  if ((def.type === 'select' || def.type === 'multi_select') && !def.option_ids?.includes(id)) {
    throw err(`unknown option id "${id}" for field "${def.api_name}"`);
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

// --- Sorting & keyset cursors ---

export interface SortSpec {
  def: FieldDef;
  direction: 'asc' | 'desc';
}

export function sortExpr(def: FieldDef): SQL {
  return fieldExpr(def);
}

/**
 * Keyset "after cursor" comparison for multi-key sorts:
 * (k1 after v1) OR (k1 == v1 AND k2 after v2) OR (... AND id > vid)
 * where equality is IS NOT DISTINCT FROM (null-safe) and "after" for each
 * level depends on `nullsFirst` (MN-252 — the whole-query empty-values
 * placement toggle; default false preserves the pre-MN-252 NULLS LAST shape):
 *   - NULLS LAST (default): a non-null cursor value's "after" set is
 *     `expr > v` (asc) plus `OR expr IS NULL` (nulls always trail); a NULL
 *     cursor value has nothing after it at this level — everything else in
 *     the null bucket is a tie, resolved by the next level/id.
 *   - NULLS FIRST: mirrored — a NULL cursor value's "after" set is any
 *     non-null row (`expr IS NOT NULL`); a non-null cursor value's "after"
 *     set is the plain comparison with no `OR IS NULL` escape hatch, since
 *     nulls already sorted before it.
 */
export function cursorCondition(
  sorts: SortSpec[],
  sortValues: unknown[],
  afterId: string,
  nullsFirst = false,
): SQL {
  const levels: SQL[] = [];
  const equalities: SQL[] = [];

  sorts.forEach((spec, i) => {
    const expr = sortExpr(spec.def);
    const value = sortValues[i] ?? null;
    let after: SQL;
    if (value === null) {
      after = nullsFirst ? sql`(${expr} IS NOT NULL)` : sql`FALSE`;
    } else if (nullsFirst) {
      after = spec.direction === 'asc' ? sql`(${expr} > ${value})` : sql`(${expr} < ${value})`;
    } else {
      after =
        spec.direction === 'asc'
          ? sql`(${expr} > ${value} OR ${expr} IS NULL)`
          : sql`(${expr} < ${value} OR ${expr} IS NULL)`;
    }
    levels.push(
      equalities.length > 0
        ? sql`(${sql.join(equalities, sql` AND `)} AND ${after})`
        : sql`(${after})`,
    );
    equalities.push(sql`(${expr} IS NOT DISTINCT FROM ${value})`);
  });

  const idAfter = sql`(${records.id} > ${afterId})`;
  levels.push(
    equalities.length > 0 ? sql`(${sql.join(equalities, sql` AND `)} AND ${idAfter})` : idAfter,
  );

  return sql`(${sql.join(levels, sql` OR `)})`;
}
