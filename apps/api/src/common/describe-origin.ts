import { eq, inArray } from 'drizzle-orm';
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

/**
 * #1179 — an origin as the API shows it (snake_case), with the run's PUBLIC number and a ready-to-print `label`: the Inbox row and the
 * approval card's header name the agent and the run ('Sales assistant (run 42)') from this, instead of the rule author the
 * notification's `actor` points at. One lookup for a whole page of rows.
 */
export interface PresentedOrigin {
  agent_id: string | null;
  agent_name: string | null;
  run_id: string | null;
  run_number: number | null;
  runner_id: string;
  runner_name: string | null;
  label: string;
}

export async function presentEventOrigins(db: Db, origins: EventOrigin[]): Promise<PresentedOrigin[]> {
  const runIds = [...new Set(origins.map((o) => o.runId).filter((v): v is string => Boolean(v)))];
  const numbers = new Map<string, number>();
  if (runIds.length) {
    for (const r of await db.select({ id: records.id, number: records.number }).from(records).where(inArray(records.id, runIds))) if (r.number !== null) numbers.set(r.id, r.number);
  }
  return origins.map((o) => {
    const runNumber = o.runId ? (numbers.get(o.runId) ?? null) : null;
    return {
      agent_id: o.agentId,
      agent_name: o.agentName,
      run_id: o.runId,
      run_number: runNumber,
      runner_id: o.runnerId,
      runner_name: o.runnerName,
      label: `${o.agentName ?? 'An agent'}${o.runId ? ` (run ${runNumber ?? o.runId})` : ''}`,
    };
  });
}
