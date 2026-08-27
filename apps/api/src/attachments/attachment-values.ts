import { UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { attachments } from '../db/schema';

/**
 * The read and guard halves of an attachment FIELD's value (#391).
 *
 * These live here rather than on `AttachmentsService` because
 * `AttachmentsModule` imports `RecordsModule` — injecting the service back into
 * `RecordsService` would close the cycle. Plain functions over `db` are the same
 * escape the members projection took with its event bus, and the same one
 * `render-values.ts` took for #335: one copy, reachable from both sides, no
 * module graph surgery.
 *
 * The value shape is an ORDERED array of attachment ids in
 * `records.values[fieldId]`, with `attachments.field_id` carrying membership.
 * That split is not novel — relations already store membership in `record_links`
 * and the projected chips in `values[apiName]`.
 */
export interface AttachmentChip {
  id: string;
  filename: string;
  size: number;
  mime: string;
  has_thumbnail: boolean;
}

export function toChip(a: {
  id: string;
  filename: string;
  size: number;
  mime: string;
  thumbKey: string | null;
}): AttachmentChip {
  return {
    id: a.id,
    filename: a.filename,
    size: a.size,
    mime: a.mime,
    // The gallery card needs to know whether there IS an image before it asks
    // for one; a broken <img> is worse than an honest placeholder.
    has_thumbnail: Boolean(a.thumbKey),
  };
}

/**
 * Every attachment belonging to a set of records' attachment fields, keyed by id.
 *
 * ONE query for a whole page, never one per record — the property that earns
 * lookups and rollups their place in the projection pipeline. A page of 200
 * covers costs the same round trip as a page of 1.
 */
export async function loadAttachmentChips(
  db: Db,
  recordIds: string[],
  fieldIds: string[],
): Promise<Map<string, AttachmentChip>> {
  if (recordIds.length === 0 || fieldIds.length === 0) return new Map();
  const rows = await db.query.attachments.findMany({
    where: and(inArray(attachments.recordId, recordIds), inArray(attachments.fieldId, fieldIds)),
    orderBy: [asc(attachments.createdAt)],
  });
  return new Map(rows.map((a) => [a.id, toChip(a)]));
}

/**
 * A record write may REORDER or REMOVE ids already on this record and field. It
 * may never introduce one.
 *
 * Without this, `values` would be a bag of uuids and any editor could point a
 * field at a file on a record they cannot read — "permissions follow the record"
 * would be a comment rather than a rule. Files arrive through the upload
 * endpoint, which checks access on the way in; this value can only rearrange
 * what that endpoint already allowed.
 *
 * The error names the endpoint, because the alternative — "invalid value" — sends
 * the reader looking for a formatting mistake in a perfectly well-formed uuid.
 */
export async function assertOwnedAttachments(
  db: Db,
  recordId: string,
  fieldId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db.query.attachments.findMany({
    where: and(
      eq(attachments.recordId, recordId),
      eq(attachments.fieldId, fieldId),
      inArray(attachments.id, ids),
    ),
  });
  const owned = new Set(rows.map((r) => r.id));
  const stranger = ids.find((id) => !owned.has(id));
  if (stranger) {
    throw new UnprocessableEntityException(
      `Attachment "${stranger}" is not on this record's field. Upload through POST .../attachments?field=<id>; this value can only reorder or remove.`,
    );
  }
}
