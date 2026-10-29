import type { Db } from '../db/client';
import { activityEvents } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import type { runners } from '../db/schema';
import { RUNNER_OFFLINE_AFTER_MS, RUNNER_PROTOCOL_MIN } from './runner.constants';

export type RunnerRow = typeof runners.$inferSelect;
export type RunnerConnection = 'online' | 'offline' | 'paused' | 'outdated' | 'tool_missing' | 'revoked';

/** The last time we heard from an ACTIVE Runner. Pairing counts as hearing from it; the column is only null on a row that never had one. */
const lastHeard = (r: RunnerRow): Date => r.lastSeenAt ?? r.activatedAt ?? r.createdAt;

/**
 * `offline_since` is DERIVED, never stored (ADR-0021 §11): it is `last_seen_at` when the Runner is active and has been silent
 * longer than the offline gap, and null otherwise. One source of truth, no second writer racing the heartbeat, and "offline
 * since 18:40" is literally the last time we heard from it. A pending Runner is never "offline": it expires instead.
 */
export function offlineSince(r: RunnerRow, now: Date): Date | null {
  if (r.status !== 'active') return null;
  const heard = lastHeard(r);
  return now.getTime() - heard.getTime() > RUNNER_OFFLINE_AFTER_MS ? heard : null;
}

/** One answer to "can this Runner work right now, and if not why", first match wins (ADR-0021 §11). */
export function runnerConnection(r: RunnerRow, now: Date): RunnerConnection {
  if (r.status === 'revoked') return 'revoked';
  if (r.protocolVersion !== null && r.protocolVersion < RUNNER_PROTOCOL_MIN) return 'outdated';
  if (offlineSince(r, now)) return 'offline';
  if (r.status === 'active' && r.chosenTool && !r.tools.some((t) => t.id === r.chosenTool && t.installed)) return 'tool_missing';
  if (r.pausedUntil && r.pausedUntil.getTime() > now.getTime()) return 'paused';
  return 'online';
}

export function presentRunner(r: RunnerRow, agents: Array<{ id: string; name: string }>, now: Date) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    connection: runnerConnection(r, now),
    tools: r.tools,
    chosen_tool: r.chosenTool,
    runner_version: r.runnerVersion,
    protocol_version: r.protocolVersion,
    paired_at: r.createdAt,
    last_seen_at: r.lastSeenAt,
    offline_since: offlineSince(r, now),
    paused_until: r.pausedUntil,
    pause_reason: r.pauseReason,
    // While pending: when the pairing window closes. The app shows the countdown; null once activated.
    pending_expires_at: r.status === 'pending' ? r.pendingExpiresAt : null,
    agents,
  };
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Audit trail for the Runner lifecycle (pair, activate, assign, revoke). The SAME `activity_events` table the workspace audit log
 * already reads (#1059): `record_id` null, the object in `payload.object`, typed `runner.<action>`. Attribution is passed in, not
 * read from the request, because most of these happen with no signed-in person (the Runner exchanging a code, the sweeper).
 */
export async function recordRunnerEvent(
  db: Db | Tx,
  event: {
    workspaceId: string;
    action: 'paired' | 'activated' | 'assigned' | 'unassigned' | 'revoked';
    runner: { id: string; name: string };
    actorId: string | null;
    source: ChangeSource | null;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(activityEvents).values({
    workspaceId: event.workspaceId,
    recordId: null,
    actorId: event.actorId,
    type: `runner.${event.action}`,
    payload: { object: { kind: 'runner', id: event.runner.id, name: event.runner.name }, ...(event.extra ?? {}) },
    source: event.source,
  });
}

/**
 * JSON with object keys sorted, for comparing what the Runner reports with what a `jsonb` column hands back: Postgres stores jsonb
 * keys in its own order, so a plain `JSON.stringify` of the two differs for equal values and every heartbeat would look "changed".
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
