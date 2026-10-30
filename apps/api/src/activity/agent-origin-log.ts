import { currentActor, currentEventOrigin } from '../common/credential-context';
import type { EventOrigin } from '../common/credential-context';
import type { Db } from '../db/client';
import { activityEvents } from '../db/schema';

/**
 * #1174 / ADR-0021 §7 — the destinations an ADMIN fixed in advance and the agent cannot change (the workspace Slack mirror of an
 * @mention, a mention or watcher email to members) are NOT held for approval when an agent's run credential caused them; they run
 * as configured. They are LOGGED, with the agent and the run, so "what did that agent's write send, and where" is one query.
 *
 * The row goes in the same `activity_events` table the audit log already reads (source `agent`, agent id and name, and the run/runner
 * columns), typed `outward.<channel>`. It has no `record_id`, like a structural event, so it never appears in a record's own feed
 * or fires a record-scoped webhook; the record is named in the payload (`object`), which is what the audit log's entity filter
 * reads. Outside an agent run credential it writes nothing: a person's mention is not an "agent outward" event.
 */
export type AgentOutwardChannel = 'slack_mention_mirror' | 'mention_email' | 'watcher_email';

export async function logAgentOriginOutward(
  db: Db,
  input: { workspaceId: string; recordId: string; recordTitle?: string | null; channel: AgentOutwardChannel; summary: string; origin?: EventOrigin | null },
): Promise<void> {
  const origin = input.origin ?? currentEventOrigin();
  if (!origin) return;
  const actor = currentActor();
  await db.insert(activityEvents).values({
    workspaceId: input.workspaceId,
    recordId: null,
    actorId: actor?.userId ?? null,
    type: `outward.${input.channel}`,
    payload: { object: { kind: 'record', id: input.recordId, name: input.recordTitle ?? '' }, channel: input.channel, summary: input.summary },
    source: 'agent',
    agentId: origin.agentId,
    agentName: origin.agentName,
    runId: origin.runId,
    runnerId: origin.runnerId,
    runnerName: origin.runnerName,
  });
}
