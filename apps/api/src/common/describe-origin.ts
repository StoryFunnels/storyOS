import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { records } from '../db/schema';
import type { EventOrigin } from './credential-context';

/**
 * #1174 / #1178 — 'Caused by agent "X" (run 12, on My laptop): ' — the sentence an approver reads first on a card an agent's run
 * credential caused. The run's public number is looked up live. One function, because two producers (an outward automation action,
 * a held direct delete) must word it the same way or the Inbox reads two dialects.
 */
export async function describeEventOrigin(db: Db, origin: EventOrigin): Promise<string> {
  let runNumber: number | null = null;
  if (origin.runId) {
    const row = await db.query.records.findFirst({ where: eq(records.id, origin.runId), columns: { number: true } });
    runNumber = row?.number ?? null;
  }
  const agent = origin.agentName ? `agent "${origin.agentName}"` : 'an agent';
  const run = origin.runId ? ` (run ${runNumber ?? origin.runId}${origin.runnerName ? `, on ${origin.runnerName}` : ''})` : origin.runnerName ? ` (on ${origin.runnerName})` : '';
  return `Caused by ${agent}${run}: `;
}
