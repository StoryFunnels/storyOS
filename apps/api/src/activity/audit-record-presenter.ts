import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases, records, spaces } from '../db/schema';
import type { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

/**
 * Ticket #1287 - how an audit-log row NAMES the record it is about, and the one rule for who is told.
 *
 * Before this a record row carried only `record_id`, so a person reading the log could not find the record. Each row that has a
 * record now carries `record`, resolved here and nowhere else (a surface that names a record from the log calls
 * `presentAuditRecords`; it does not read `records.title` itself - the same one-gate shape as the rule-name gate of ticket #1280).
 *
 * The three states a client must tell apart, none of which is an error:
 *   - READABLE   `withheld: false`, `deleted: false`: number, title, database id and name are set.
 *   - DELETED    `deleted: true`: the record (or its database or space) was soft-deleted; the row is still named while the viewer
 *                may read that database. A record row that no longer exists at all reads `deleted: true` with every name null.
 *   - WITHHELD   `withheld: true`: the viewer may not read the record (a restricted database, a record the guest holds no grant
 *                on, or another member's personal space - which no one but its owner may read, admins included, #291). Only the id
 *                survives; number, title, database id and name are all null, so nothing here distinguishes "restricted" from
 *                "private", and a client says "a record" rather than guessing.
 *
 * The gate is `AccessService.effectiveForRecords` (database grant, space grant and record grant, sticky restriction) plus
 * `canSeePersonal` for the personal-space door: the same two rules every other surface uses, never a copy of them.
 */
export interface PresentedAuditRecord {
  id: string;
  /** The record's public number within its database (the "#1060"). null when withheld, gone, or never numbered. */
  number: number | null;
  /** The record's title as THIS viewer may read it. null when withheld or gone. */
  title: string | null;
  database_id: string | null;
  database_name: string | null;
  /** True when the record, its database or its space is soft-deleted, or the record row no longer exists. False for a withheld record (unknown to this viewer). */
  deleted: boolean;
  /** True when this viewer may not read the record. Everything but `id` is then null. */
  withheld: boolean;
}

const withheldRecord = (id: string): PresentedAuditRecord => ({ id, number: null, title: null, database_id: null, database_name: null, deleted: false, withheld: true });
const goneRecord = (id: string): PresentedAuditRecord => ({ id, number: null, title: null, database_id: null, database_name: null, deleted: true, withheld: false });

/**
 * Resolve many records for ONE viewer. Queries: one records+databases+spaces read, plus one grants fetch for a guest or a restricted
 * member (an admin, or a member where nothing is closed, fetches none) - never one per row. Never throws for a record the viewer cannot read.
 */
export async function presentAuditRecords(
  db: Db,
  access: AccessService,
  membership: Membership,
  recordIds: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, PresentedAuditRecord>> {
  const ids = [...new Set(recordIds.filter((v): v is string => Boolean(v)))];
  const out = new Map<string, PresentedAuditRecord>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: records.id,
      number: records.number,
      title: records.title,
      titleLocal: records.titleLocal,
      deletedAt: records.deletedAt,
      databaseId: databases.id,
      databaseName: databases.name,
      databaseDeletedAt: databases.deletedAt,
      spaceId: databases.spaceId,
      spaceDeletedAt: spaces.deletedAt,
      spacePersonal: spaces.personal,
      spaceOwnerUserId: spaces.ownerUserId,
    })
    .from(records)
    .innerJoin(databases, eq(databases.id, records.databaseId))
    .innerJoin(spaces, eq(spaces.id, databases.spaceId))
    .where(inArray(records.id, ids));
  const effective = await access.effectiveForRecords(
    membership,
    rows.map((r) => ({ id: r.id, databaseId: r.databaseId, spaceId: r.spaceId })),
  );
  for (const r of rows) {
    const mayEnterSpace = access.canSeePersonal(membership, { personal: r.spacePersonal, ownerUserId: r.spaceOwnerUserId });
    const role = effective.get(r.id) ?? null;
    if (!mayEnterSpace || role === null) {
      out.set(r.id, withheldRecord(r.id));
      continue;
    }
    out.set(r.id, {
      id: r.id,
      number: r.number,
      // #884: an admin reads the full title; anyone else reads the form with cross-record inputs blanked, the same as the record itself.
      title: role === 'admin' ? r.title : (r.titleLocal ?? r.title),
      database_id: r.databaseId,
      database_name: r.databaseName,
      deleted: r.deletedAt !== null || r.databaseDeletedAt !== null || r.spaceDeletedAt !== null,
      withheld: false,
    });
  }
  // A record id with no row at all (purged): the row is still renderable, as a deleted record with no name.
  for (const id of ids) if (!out.has(id)) out.set(id, goneRecord(id));
  return out;
}

/**
 * A withheld row must not leak the record by another door: an event's `payload` carries the record's title (`record.created`), and a
 * field change carries the field's name and the old and new VALUES. So a withheld row keeps who/when/what-kind and loses all of those.
 * Applied to the row the service returns, so no caller can name a record and forget to blank what else names it.
 */
export function redactIfWithheld<T extends { payload?: unknown; field?: unknown; field_type?: unknown; old_value?: unknown; new_value?: unknown; old_display?: unknown; new_display?: unknown }>(row: T, record: PresentedAuditRecord | null): T {
  if (!record?.withheld) return row;
  const out: Record<string, unknown> = { ...row };
  if ('payload' in out) out.payload = {};
  if ('field' in out) out.field = null;
  if ('old_value' in out) out.old_value = null;
  if ('new_value' in out) out.new_value = null;
  if ('field_type' in out) out.field_type = null;
  if ('old_display' in out) out.old_display = null;
  if ('new_display' in out) out.new_display = null;
  return out as T;
}
