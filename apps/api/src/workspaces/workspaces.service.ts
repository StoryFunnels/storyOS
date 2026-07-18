import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, spaces, workspaces } from '../db/schema';
import { redactSecrets } from '../common/redact-secrets';

/** Strip integration secrets from `settings` before a workspace leaves the API (MN-144). */
function serialize<T extends { settings?: unknown }>(w: T): T {
  return { ...w, settings: redactSecrets(w.settings ?? {}) };
}

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private async uniqueSlug(base: string): Promise<string> {
    const root =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'workspace';
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? root : `${root}-${i + 1}`;
      const existing = await this.db.query.workspaces.findFirst({
        where: eq(workspaces.slug, candidate),
      });
      if (!existing) return candidate;
    }
  }

  /** Creates workspace + default "General" space + admin membership, atomically. */
  async create(userId: string, input: { name: string; slug?: string }) {
    const slug = input.slug ?? (await this.uniqueSlug(input.name));
    return this.db.transaction(async (tx) => {
      const [ws] = await tx
        .insert(workspaces)
        .values({ name: input.name, slug })
        .returning();
      await tx.insert(spaces).values({ workspaceId: ws!.id, name: 'General', slug: 'general', position: 0 });
      await tx
        .insert(memberships)
        .values({ workspaceId: ws!.id, userId, role: 'admin', status: 'active' });
      return serialize(ws!);
    });
  }

  async listForUser(userId: string) {
    const mine = await this.db.query.memberships.findMany({
      where: and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
    });
    if (mine.length === 0) return [];
    const wss = await this.db.query.workspaces.findMany({
      where: inArray(
        workspaces.id,
        mine.map((m) => m.workspaceId),
      ),
    });
    const roleByWs = new Map(mine.map((m) => [m.workspaceId, m.role]));
    return wss.map((w) => ({ ...serialize(w), role: roleByWs.get(w.id) }));
  }

  async update(id: string, patch: { name?: string; private_attachments?: boolean }) {
    const { private_attachments, ...rest } = patch;
    const set: { name?: string; settings?: Record<string, unknown> } = { ...rest };
    // Same read-modify-write as the integration settings blobs (slack/github/linear
    // services): `settings` is a shared jsonb bag, so a flag write must merge over
    // the current value rather than clobber it.
    if (private_attachments !== undefined) {
      const current = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, id) });
      set.settings = { ...((current?.settings as Record<string, unknown>) ?? {}), private_attachments };
    }
    const [ws] = await this.db
      .update(workspaces)
      .set(set)
      .where(eq(workspaces.id, id))
      .returning();
    return serialize(ws!);
  }

  /** #201: is private-attachments mode on for this workspace? Defaults to off
   * (current capability-URL behavior) when unset. */
  async privateAttachmentsEnabled(workspaceId: string): Promise<boolean> {
    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
    return Boolean((ws?.settings as Record<string, unknown> | undefined)?.private_attachments);
  }
}
