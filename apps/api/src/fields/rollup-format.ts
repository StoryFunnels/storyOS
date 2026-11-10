import { and, inArray, isNull } from 'drizzle-orm';
import { NUMBER_FORMAT_KEYS, rollupInheritsFormat } from '@storyos/schemas';
import type { Db } from '../db/client';
import { fields, relations } from '../db/schema';

/**
 * ticket #1256 — a sum/avg/min/max rollup shows the number format of the field it aggregates.
 *
 * Resolved at READ time, from the target field as it is right now, and never stored: a rollup that copied the format at
 * create time would keep showing euros after someone changed the Quote Line total to dollars. What is stored is only
 * what the user chose explicitly on the rollup; an explicit `format` wins and is left exactly as stored.
 *
 * The inherited keys are returned in the field's own config (`format`, `currency_code`, `precision`) so every client
 * that already reads a number field's config (web, MCP, exports) needs no new concept, plus `format_inherited: true` so a
 * client that round-trips the config through PATCH is recognised and not allowed to turn the inheritance into a stored
 * copy (FieldsService.assertRollupConfig drops the marker AND the keys it rides with).
 *
 * `count` never inherits: it counts records and is a plain integer whatever it counts.
 */
type FieldRow = { id: string; apiName: string; type: string; config: unknown; databaseId: string };

export async function inheritRollupFormats<T extends FieldRow>(db: Db, rows: T[]): Promise<void> {
  const wanting = rows.filter((f) => {
    if (f.type !== 'rollup') return false;
    const c = (f.config ?? {}) as Record<string, unknown>;
    return rollupInheritsFormat(c['op']) && !!c['target_field_api_name'] && c['format'] === undefined;
  });
  if (wanting.length === 0) return;

  // rollup -> its relation field (on this database) -> the relation -> the database on the far side
  const byId = new Map(rows.map((f) => [f.id, f]));
  const relationIds = new Set<string>();
  for (const f of wanting) {
    const via = byId.get(String((f.config as Record<string, unknown>)['relation_field_id'] ?? ''));
    const rid = (via?.config as { relation_id?: string } | undefined)?.relation_id;
    if (rid) relationIds.add(rid);
  }
  if (relationIds.size === 0) return;
  const relationRows = await db.query.relations.findMany({ where: inArray(relations.id, [...relationIds]) });
  const relationById = new Map(relationRows.map((r) => [r.id, r]));

  const targetDbOf = (f: T): string | null => {
    const via = byId.get(String((f.config as Record<string, unknown>)['relation_field_id'] ?? ''));
    const rc = via?.config as { relation_id?: string; side?: 'a' | 'b' } | undefined;
    const relation = rc?.relation_id ? relationById.get(rc.relation_id) : undefined;
    if (!relation) return null;
    return rc?.side === 'a' ? relation.databaseBId : relation.databaseAId;
  };

  const targetDbIds = new Set<string>();
  const apiNames = new Set<string>();
  for (const f of wanting) {
    const t = targetDbOf(f);
    if (t) {
      targetDbIds.add(t);
      apiNames.add(String((f.config as Record<string, unknown>)['target_field_api_name']));
    }
  }
  if (targetDbIds.size === 0) return;
  const targets = await db.query.fields.findMany({
    where: and(inArray(fields.databaseId, [...targetDbIds]), inArray(fields.apiName, [...apiNames]), isNull(fields.deletedAt)),
    columns: { databaseId: true, apiName: true, type: true, config: true },
  });
  const targetByKey = new Map(targets.map((t) => [`${t.databaseId}\u0000${t.apiName}`, t]));

  for (const f of wanting) {
    const dbId = targetDbOf(f);
    const config = f.config as Record<string, unknown>;
    const target = dbId ? targetByKey.get(`${dbId}\u0000${String(config['target_field_api_name'])}`) : undefined;
    // Only a number or a number-returning formula carries a number format; anything else adds nothing.
    if (!target || (target.type !== 'number' && target.type !== 'formula')) continue;
    const tc = (target.config ?? {}) as Record<string, unknown>;
    const inherited: Record<string, unknown> = {};
    for (const key of NUMBER_FORMAT_KEYS) if (tc[key] !== undefined) inherited[key] = tc[key];
    // A number field's `format` defaults to 'plain' only in the parsed schema, so a stored one may carry just a precision.
    if (Object.keys(inherited).length === 0) continue;
    (f as { config: unknown }).config = { ...config, ...inherited, format_inherited: true };
  }
}
