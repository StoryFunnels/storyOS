import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { automationRuns, memberships } from '../db/schema';
import type { NotificationsService } from '../notifications/notifications.service';

/**
 * Ticket #1353 — what makes a run's failure a run-time ACCESS refusal rather than an ordinary failure. The run row's error (and a
 * queued job's last error) starts with the refusal's code, so a refusal is recognised by that prefix and nothing else.
 */
const REFUSAL_RE = /^(automation_owner_|automation_system_database)/;
export const isAccessRefusal = (text: string | null | undefined): boolean => Boolean(text && REFUSAL_RE.test(text));
/** The part of "<code>: <sentence>" a person reads. */
export const refusalSentence = (text: string): string => text.replace(/^[a-z_]+:\s*/, '');

export type NeedsNewOwnerReason = 'missing' | 'left' | 'lacks_access';

/**
 * "This rule needs a new owner", derived on every read and never stored: `missing` (no owner recorded), `left` (the owner is not an
 * active member), `lacks_access` (the owner is a member, but the rule's LATEST run was refused for lack of access, which clears the
 * moment a later run succeeds). The flag is therefore true from the FIRST refused run, not after a failure streak.
 */
export async function ownerFlags<R extends { id: string; createdBy: string | null }>(db: Db, workspaceId: string, rules: R[]) {
  const ids = [...new Set(rules.map((r) => r.createdBy).filter((id): id is string => Boolean(id)))];
  const active = new Set<string>();
  if (ids.length > 0) {
    const rows = await db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')));
    for (const r of rows) if (ids.includes(r.userId)) active.add(r.userId);
  }
  const needLastRun = rules.filter((r) => r.createdBy && active.has(r.createdBy)).map((r) => r.id);
  const lastError = new Map<string, string | null>();
  if (needLastRun.length > 0) {
    const res = (await db.execute(sql`
      SELECT DISTINCT ON (automation_id) automation_id AS id, error
      FROM automation_runs
      WHERE automation_id IN (${sql.join(needLastRun.map((id) => sql`${id}::uuid`), sql`, `)})
      ORDER BY automation_id, created_at DESC
    `)) as unknown as { rows: Array<{ id: string; error: string | null }> };
    for (const r of res.rows) lastError.set(r.id, r.error);
  }
  return new Map(
    rules.map((r) => {
      let reason: NeedsNewOwnerReason | null = null;
      if (!r.createdBy) reason = 'missing';
      else if (!active.has(r.createdBy)) reason = 'left';
      else if ((lastError.get(r.id) ?? '').startsWith('automation_owner_no_access')) reason = 'lacks_access';
      return [r.id, reason] as const;
    }),
  );
}

/** Is this the rule's first access refusal in a row? (The run being recorded is excluded; the one before it decides.) */
export async function isFirstRefusal(db: Db, ruleId: string, thisRunId: string): Promise<boolean> {
  const [prev] = await db
    .select({ error: automationRuns.error })
    .from(automationRuns)
    .where(and(eq(automationRuns.automationId, ruleId), ne(automationRuns.id, thisRunId)))
    .orderBy(desc(automationRuns.createdAt))
    .limit(1);
  return !prev || !isAccessRefusal(prev.error);
}

/**
 * In-app notice to the workspace's admins (ticket #1353, Otto's ruling 2): the rule needs a new owner, or it switched itself off.
 * The text is the rule's own name plus the refusal's sentence, which names the person and the KIND of record and never a record
 * title. Personal space: automations belong to databases and a database can never live in a personal space (ticket #1173), so
 * there is no personal content for this text to mention, and the recipients are admins only; the notification service still
 * applies its own readable-by check against the rule's database when it emits.
 */
export async function notifyAdmins(
  db: Db,
  notifications: NotificationsService,
  rule: { id: string; name: string; databaseId: string; createdBy: string | null },
  workspaceId: string,
  kind: 'refused' | 'disabled',
  detail: string,
): Promise<void> {
  const admins = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.role, 'admin'), eq(memberships.status, 'active')));
  if (admins.length === 0) return;
  const snippet =
    kind === 'refused'
      ? `"${rule.name}" needs attention: ${refusalSentence(detail)}`
      : `"${rule.name}" was switched off after repeated failed runs. Last error: ${refusalSentence(detail)}`;
  await notifications
    .notify({
      workspaceId,
      databaseId: rule.databaseId,
      actorId: rule.createdBy ?? admins[0]!.userId,
      type: kind === 'refused' ? 'automation_owner_refused' : 'automation_disabled',
      recipients: admins.map((a) => a.userId),
      snippet: snippet.slice(0, 500),
      allowSelf: true,
    })
    .catch(() => undefined);
}
