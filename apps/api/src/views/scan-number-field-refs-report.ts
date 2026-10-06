/**
 * #764 Phase A — a READ-ONLY, per-workspace census of stored view configs that
 * still reference the deprecated `number` field. It reports; it cannot write.
 *
 * Why this exists: the migration (migrate-number-field-refs.ts) has no
 * read-only mode, so the only way to learn "how many views reference `number`,
 * and in how many workspaces" was to perform the write — which makes the count
 * worthless as a safety check. This is the count, without the write. If it comes
 * back zero there is nothing to migrate and the question is closed.
 *
 * INCAPABLE OF WRITING, by three independent layers (not by care):
 *   1. Every query runs inside a Postgres READ ONLY transaction. A write is
 *      rejected by the database itself (SQLSTATE 25006), whatever this code does.
 *   2. Before scanning, it asks Postgres whether the transaction really is read
 *      only and REFUSES to continue if not — so a future change that drops (1)
 *      fails loudly instead of quietly gaining write access.
 *   3. This module and its CLI import no write path (no migrate, no rewrite),
 *      and a test fails if `.update(`, `.insert(` or `.delete(` ever appear here.
 *
 * COUNTS ONLY. No view names or ids are returned: a personal view is private
 * even from admins (#291), and a report posted on a ticket must not become the
 * place that leaks one. Workspaces are identified by id.
 */
import { eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { databases, spaces, views } from '../db/schema';
import { scanConfigForNumberRefs } from './number-field-ref-rewrite';
import { databasesWithUserNumberField } from './scan-number-field-refs';

export interface NumberRefsWorkspaceRow {
  workspaceId: string;
  /** Live (non-trashed) views scanned in this workspace. */
  viewsScanned: number;
  /** Views that reference the DEPRECATED system field — what a migration would rewrite. */
  referencing: number;
  /** Views that name `number`, but in a database where `number` is the user's OWN
   * field. Not references to the deprecated field; the migration leaves them alone. */
  userFieldDatabase: number;
  /** Space-level views naming `number`: no single database, so ambiguous. A migration
   * would skip them, and they would block any removal. */
  spaceViewUnresolved: number;
}

export interface NumberRefsReport {
  scannedAt: string;
  workspaces: NumberRefsWorkspaceRow[];
  totals: Omit<NumberRefsWorkspaceRow, 'workspaceId'> & { workspaces: number; workspacesReferencing: number };
}

/** Runs `fn` in a READ ONLY transaction and proves that is what it got. */
export async function withReadOnly<T>(db: Db, fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>): Promise<T> {
  return db.transaction(
    async (tx) => {
      const check = await tx.execute(sql`SHOW transaction_read_only`);
      const state = (check.rows[0] as { transaction_read_only?: string } | undefined)?.transaction_read_only;
      if (state !== 'on') {
        throw new Error(`Refusing to scan: the transaction is not read only (transaction_read_only=${state ?? 'unknown'}).`);
      }
      return fn(tx);
    },
    { accessMode: 'read only' },
  );
}

export async function reportNumberRefsByWorkspace(db: Db): Promise<NumberRefsReport> {
  return withReadOnly(db, async (tx) => {
    const userNumber = await databasesWithUserNumberField(tx);
    const rows = await tx
      .select({
        config: views.config,
        databaseId: views.databaseId,
        databaseWorkspace: databases.workspaceId,
        spaceWorkspace: spaces.workspaceId,
      })
      .from(views)
      .leftJoin(databases, eq(views.databaseId, databases.id))
      .leftJoin(spaces, eq(views.spaceId, spaces.id))
      .where(isNull(views.deletedAt));

    const byWorkspace = new Map<string, NumberRefsWorkspaceRow>();
    for (const row of rows) {
      const workspaceId = row.databaseWorkspace ?? row.spaceWorkspace ?? 'unknown';
      let entry = byWorkspace.get(workspaceId);
      if (!entry) {
        entry = { workspaceId, viewsScanned: 0, referencing: 0, userFieldDatabase: 0, spaceViewUnresolved: 0 };
        byWorkspace.set(workspaceId, entry);
      }
      entry.viewsScanned++;
      if (!scanConfigForNumberRefs(row.config).hit) continue;
      if (row.databaseId === null) entry.spaceViewUnresolved++;
      else if (userNumber.has(row.databaseId)) entry.userFieldDatabase++;
      else entry.referencing++;
    }

    const workspaces = [...byWorkspace.values()].sort(
      (a, b) => b.referencing - a.referencing || b.spaceViewUnresolved - a.spaceViewUnresolved || a.workspaceId.localeCompare(b.workspaceId),
    );
    const sum = (key: 'viewsScanned' | 'referencing' | 'userFieldDatabase' | 'spaceViewUnresolved') =>
      workspaces.reduce((n, w) => n + w[key], 0);
    return {
      scannedAt: new Date().toISOString(),
      workspaces,
      totals: {
        workspaces: workspaces.length,
        workspacesReferencing: workspaces.filter((w) => w.referencing > 0).length,
        viewsScanned: sum('viewsScanned'),
        referencing: sum('referencing'),
        userFieldDatabase: sum('userFieldDatabase'),
        spaceViewUnresolved: sum('spaceViewUnresolved'),
      },
    };
  });
}
