import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { viewerState } from '../db/schema';
import { DatabasesService } from '../databases/databases.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { VIEWER_STATE_KINDS, type ResolvedTarget, type ViewerStateData, type ViewerStateKindName } from './viewer-state.kinds';

/**
 * ADR-0019 / #973 — per-viewer overrides of shared objects, one row each (`viewer_state`), behind a registry of kinds.
 *
 * Every operation goes through ONE access check, whatever the kind: the viewer must hold `viewer` on the DATABASE the shared object
 * lives in (`reach`), exactly what the personal-filter and personal-collection endpoints have always required. A write is ONE atomic
 * statement (`INSERT ... ON CONFLICT DO UPDATE`) on that override's own row, so two writes can never lose each other.
 */
@Injectable()
export class ViewerStateService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
  ) {}

  /**
   * The shared object's database, after the one access check: 404 if the object is gone or is not in the database named in the URL
   * (`expectedDatabaseId`, when the caller has one), then `viewer` on that database.
   */
  async reach(membership: Membership, kind: ViewerStateKindName, targetId: string, expectedDatabaseId?: string): Promise<ResolvedTarget> {
    const entry = VIEWER_STATE_KINDS[kind];
    const target = await entry.resolve(this.db, targetId);
    if (!target || target.workspaceId !== membership.workspaceId || (expectedDatabaseId && target.databaseId !== expectedDatabaseId)) {
      // The database check first for a caller with no access at all, so "no such view" and "no access" read the same to them.
      if (expectedDatabaseId) await this.databases.assertAccess(membership, expectedDatabaseId, 'viewer');
      throw new NotFoundException(entry.missing);
    }
    await this.databases.assertAccess(membership, target.databaseId, 'viewer');
    return target;
  }

  /** My override of `targetId`, cleaned for presentation; undefined when I have none. */
  async get<K extends ViewerStateKindName>(membership: Membership, kind: K, targetId: string, expectedDatabaseId?: string): Promise<ViewerStateData<K> | undefined> {
    const target = await this.reach(membership, kind, targetId, expectedDatabaseId);
    return this.read(membership.userId, kind, targetId, target);
  }

  /** The same read for a caller that has ALREADY checked access (the export, which authorises the whole request first). */
  async read<K extends ViewerStateKindName>(userId: string, kind: K, targetId: string, resolved?: ResolvedTarget): Promise<ViewerStateData<K> | undefined> {
    const row = await this.db.query.viewerState.findFirst({ where: and(eq(viewerState.userId, userId), eq(viewerState.kind, kind), eq(viewerState.targetId, targetId)) });
    if (!row) return undefined;
    const entry = VIEWER_STATE_KINDS[kind];
    const target = resolved ?? (await entry.resolve(this.db, targetId));
    if (!target) return undefined;
    const data = row.data as ViewerStateData<K>;
    return (entry.present ? await (entry.present as (db: Db, t: ResolvedTarget, d: unknown) => Promise<unknown>)(this.db, target, data) : data) as ViewerStateData<K> | undefined;
  }

  /** Set (or replace) my override: validated by the kind, then ONE atomic upsert on this override's own row. */
  async set<K extends ViewerStateKindName>(membership: Membership, kind: K, targetId: string, data: unknown, expectedDatabaseId?: string): Promise<ViewerStateData<K>> {
    const target = await this.reach(membership, kind, targetId, expectedDatabaseId);
    const entry = VIEWER_STATE_KINDS[kind];
    const parsed = entry.schema.parse(data) as ViewerStateData<K>;
    if (entry.validate) await (entry.validate as (db: Db, t: ResolvedTarget, d: unknown) => Promise<void>)(this.db, target, parsed);
    await this.db
      .insert(viewerState)
      .values({ userId: membership.userId, workspaceId: target.workspaceId, kind, targetId, data: parsed, updatedAt: new Date() })
      .onConflictDoUpdate({ target: [viewerState.userId, viewerState.kind, viewerState.targetId], set: { data: parsed, updatedAt: new Date() } });
    return parsed;
  }

  /** Clear my override. Idempotent: clearing one that was never set is a no-op, not a 404. */
  async clear(membership: Membership, kind: ViewerStateKindName, targetId: string, expectedDatabaseId?: string): Promise<void> {
    await this.reach(membership, kind, targetId, expectedDatabaseId);
    await this.db.delete(viewerState).where(and(eq(viewerState.userId, membership.userId), eq(viewerState.kind, kind), eq(viewerState.targetId, targetId)));
  }
}
