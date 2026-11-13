import { Logger } from '@nestjs/common';
import { codedException } from '../common/coded-exception';
import type { AgentProposedActionSnapshot, ApprovalActionSnapshot } from './approvals.service';

/**
 * Ticket #1298 - THE reading of an approval row's stored `action_snapshot`.
 *
 * The column is `jsonb NOT NULL` and nothing else constrains it, so a row can hold whatever an older producer, a hand-seeded test
 * workspace or a half-finished migration left there: `{"kind":"send_email"}` with no `ctx` was the real one, and it made
 * `GET /approvals` answer 500 to EVERYONE, because one line read `snapshot.ctx.databaseId` on every row. The list, My work, the
 * approve/reject paths and the agent-run lookups each reached into the snapshot on their own and each assumed the shape; this is the
 * one place that decides whether a row's snapshot may be trusted, and what every surface does when it may not.
 *
 * What is required is exactly what the readers dereference, not the full `ApprovalActionSnapshot` the producers write:
 *   - the snapshot is an object;
 *   - `action` is an object with a string `type` (every dispatch is on it);
 *   - `ctx` is an object whose `databaseId` is a string or null (null = an approval that belongs to no database: a skill).
 * A snapshot that has these is "readable". Anything else is "unreadable" and is shown as an unknown request, never trusted, never
 * dropped, never a 500. Whether a readable snapshot also carries everything its EXECUTOR needs is that executor's own concern.
 */
export type UnreadableReason = 'not_an_object' | 'no_action' | 'bad_action_type' | 'no_ctx' | 'bad_database_id';

export type ParsedApprovalSnapshot = { readable: true; snapshot: ApprovalActionSnapshot } | { readable: false; reason: UnreadableReason };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseApprovalSnapshot(raw: unknown): ParsedApprovalSnapshot {
  if (!isObject(raw)) return { readable: false, reason: 'not_an_object' };
  const action = raw.action;
  if (!isObject(action)) return { readable: false, reason: 'no_action' };
  if (typeof action.type !== 'string') return { readable: false, reason: 'bad_action_type' };
  const ctx = raw.ctx;
  if (!isObject(ctx)) return { readable: false, reason: 'no_ctx' };
  if (ctx.databaseId !== null && typeof ctx.databaseId !== 'string') return { readable: false, reason: 'bad_database_id' };
  return { readable: true, snapshot: raw as unknown as ApprovalActionSnapshot };
}

/**
 * The database a row belongs to, for ACCESS decisions only: a string, null (belongs to no database), or undefined (cannot tell).
 * Deliberately separate from `parseApprovalSnapshot`: whether a guest may know a row exists depends on `ctx.databaseId` alone - exactly what
 * the SQL count (`#>> '{ctx,databaseId}'`) reads - so the list and the count cannot disagree about a row whose `action` is the broken part.
 */
export function snapshotDatabaseId(raw: unknown): string | null | undefined {
  if (!isObject(raw) || !isObject(raw.ctx)) return undefined;
  const id = raw.ctx.databaseId;
  return id === null || typeof id === 'string' ? id : undefined;
}

/** What every surface calls a row it could not read. One string, so the list, My work and the Inbox card cannot say it three ways. */
export const UNKNOWN_REQUEST_TEXT = 'Unknown request';

/** The refusal for approve/reject on an unreadable row: nothing is decided, because there is nothing known to approve or to reject. */
export function unreadableApprovalError() {
  return codedException(
    422,
    'approval_unreadable',
    "This approval's stored details could not be read, so it cannot be approved or rejected: there is nothing known to run. " +
      'Ask whoever set it up to re-create the request; it expires on its own.',
  );
}

const logger = new Logger('ApprovalSnapshot');
const SEEN_CAP = 5_000;
const seen = new Set<string>();

/**
 * Leave a trace that a row was unreadable - ONCE per row per process, because the list is read on every Inbox open and a log line per
 * request would bury the one fact it carries. Only the row id and a fixed reason code are logged: the snapshot, the preview text and
 * the URLs in them are the workspace's data and stay out of logs. (Bounded: past the cap the oldest forgotten ids may log again.)
 */
export function noteUnreadableApproval(rowId: string, reason: UnreadableReason): void {
  if (seen.has(rowId)) return;
  if (seen.size >= SEEN_CAP) seen.delete(seen.values().next().value as string);
  seen.add(rowId);
  logger.warn(`approval ${rowId} has an unreadable snapshot (${reason}); it is shown as an unknown request`);
}

/** Parse a row's snapshot and leave the one-time trace if it cannot be read. The entry point every surface uses. */
export function readApprovalSnapshot(row: { id: string; actionSnapshot: unknown }): ParsedApprovalSnapshot {
  const parsed = parseApprovalSnapshot(row.actionSnapshot);
  if (!parsed.readable) noteUnreadableApproval(row.id, parsed.reason);
  return parsed;
}

/**
 * The agent-run proposal a row holds, or null if it holds anything else - including a snapshot that cannot be read (#1298: the run
 * approve/reject routes look a row up by run id and used to dereference `.action.type` on whatever they found).
 */
export function agentProposedActionOf(row: { id: string; actionSnapshot: unknown } | null | undefined): AgentProposedActionSnapshot | null {
  if (!row) return null;
  const parsed = readApprovalSnapshot(row);
  return parsed.readable && parsed.snapshot.action.type === 'agent_proposed_action' ? (parsed.snapshot.action as AgentProposedActionSnapshot) : null;
}

/** Test seam: forget which rows were logged. */
export function resetUnreadableApprovalLog(): void {
  seen.clear();
}
