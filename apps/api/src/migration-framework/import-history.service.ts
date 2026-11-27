import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { recordFieldChanges, records } from '../db/schema';
import { EntitlementsService } from '../billing/entitlements.service';

/** One state change to replay: when it really happened, who did it, and the option it left and entered. */
export interface ImportedFieldChange {
  at: Date;
  actorUserId: string | null;
  oldValue: string | null;
  newValue: string;
}

/**
 * Ticket #1367 — the two things a normal write path deliberately cannot do and an import must: keep the SOURCE's dates on a record,
 * and replay the source's own history on a field. Service-level only: nothing here is reachable from an HTTP route, for the same
 * reason an imported record number is not (a client choosing its own timestamps and its own history is a forgery surface).
 */
@Injectable()
export class ImportHistoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
  ) {}

  /**
   * Stamp a record with the source's created and updated times (an import's own writes would otherwise say "created today").
   * Runs AFTER the upsert, because an update bumps updated_at itself. A null leaves that column as it is. Idempotent, and a no-op
   * when the row already says so.
   */
  async stampTimes(databaseId: string, recordId: string, times: { createdAt: Date | null; updatedAt: Date | null }): Promise<void> {
    const set: { createdAt?: Date; updatedAt?: Date } = {};
    if (times.createdAt) set.createdAt = times.createdAt;
    if (times.updatedAt) set.updatedAt = times.updatedAt;
    if (Object.keys(set).length === 0) return;
    const differs = [
      times.createdAt ? sql`${records.createdAt} <> ${times.createdAt}` : undefined,
      times.updatedAt ? sql`${records.updatedAt} <> ${times.updatedAt}` : undefined,
    ].filter(Boolean);
    await this.db
      .update(records)
      .set(set)
      .where(and(eq(records.id, recordId), eq(records.databaseId, databaseId), sql`(${sql.join(differs as never[], sql` or `)})`));
  }

  /**
   * Whether this workspace keeps field history at all. A plan whose window is 0 (Free) captures nothing on a normal write, because
   * the rows could never be read; an import follows the same rule instead of writing rows nobody can see.
   */
  async keepsFieldHistory(workspaceId: string): Promise<boolean> {
    const { historyRetentionDays } = await this.entitlements.getLimits(workspaceId);
    return historyRetentionDays > 0;
  }

  /**
   * Make the IMPORTED history of one field on these records exactly the source's. Rows from `import` on this field are replaced;
   * every row a person, an agent or an automation wrote is untouched. That is also what keeps a re-run idempotent: the source gives no
   * stable id to dedupe on here, so the imported set is replaced as a set rather than appended to.
   */
  async replaceImportedFieldHistory(
    workspaceId: string,
    databaseId: string,
    fieldId: string,
    items: Array<{ recordId: string; changes: ImportedFieldChange[] }>,
  ): Promise<number> {
    let written = 0;
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      const rows = chunk.flatMap(({ recordId, changes }) =>
        changes.map((c) => ({
          workspaceId,
          databaseId,
          recordId,
          fieldId,
          actorUserId: c.actorUserId,
          source: 'import' as const,
          // Encoded exactly as the normal capture does, so a bare string cannot be re-parsed as JSON source text on its way in.
          oldValue: sql`${JSON.stringify(c.oldValue)}::jsonb`,
          newValue: sql`${JSON.stringify(c.newValue)}::jsonb`,
          createdAt: c.at,
        })),
      );
      await this.db.transaction(async (tx) => {
        await tx
          .delete(recordFieldChanges)
          .where(
            and(
              inArray(recordFieldChanges.recordId, chunk.map((x) => x.recordId)),
              eq(recordFieldChanges.fieldId, fieldId),
              eq(recordFieldChanges.source, 'import'),
            ),
          );
        for (let j = 0; j < rows.length; j += 500) await tx.insert(recordFieldChanges).values(rows.slice(j, j + 500));
      });
      written += rows.length;
    }
    return written;
  }
}
