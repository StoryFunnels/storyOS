import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { workspaces } from '../db/schema';

/**
 * #749 — the ONE registry of "records the system seeded, which the user did
 * not create": `workspace.settings.sample_record_ids`. `TemplatesService`
 * and `PacksService` both seed sample records and both need to register
 * them here — this used to be a private method on `TemplatesService` only,
 * which is exactly how `PacksService` ended up with zero references to the
 * registry at all. One shared function, not two copies of a read-modify-
 * write on `workspace.settings` that would drift the moment either side
 * changed independently.
 *
 * Deliberately keyed by RECORD ID, never by title or any other display
 * string — ADR-0017's `is_system`-flag precedent applies directly here:
 * matching by name is what cost #317/#318 (a user's own "Members" database
 * mistaken for the system projection). A record this function is never
 * told about is never a sample, no matter what it's called.
 */
export async function trackSampleRecords(db: Db, workspaceId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  const settings = (ws?.settings ?? {}) as Record<string, unknown>;
  const existing = (settings.sample_record_ids as string[]) ?? [];
  const merged = new Set([...existing, ...ids]);
  await db
    .update(workspaces)
    .set({ settings: { ...settings, sample_record_ids: [...merged] } })
    .where(eq(workspaces.id, workspaceId));
}
