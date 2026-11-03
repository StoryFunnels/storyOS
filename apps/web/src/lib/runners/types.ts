/**
 * Ticket #1139 — the Runner API's response shapes, hand-typed.
 *
 * The generated SDK knows these PATHS (docs/api/openapi.json carries them) but the controllers declare no response schema, so
 * the generated types for the 200 bodies are `unknown`; the web has always typed such responses by hand (see `queries.ts`
 * `DuplicateDatabaseResult`). Each interface below matches `apps/api/src/runners/runner-present.ts`,
 * `runners.service.ts` (`codeStatus`, `issueCode`), `run-state.ts` and `agent-wakes.service.ts` (`presentRows`, `summary`)
 * verbatim. If the API grows an OpenAPI response schema, delete this file and use the generated types.
 */

/** The tool ids ADR-0021 §5 names. A Runner may report one this build has not heard of; it is shown by its own name. */
export type KnownToolId = 'claude-code' | 'cursor' | 'codex' | 'local-openai';

export interface RunnerTool {
  id: string;
  name?: string;
  installed: boolean;
  version?: string;
  logged_in?: boolean;
}

export type RunnerRecordStatus = 'pending' | 'active' | 'revoked';
export type RunnerConnection = 'online' | 'offline' | 'paused' | 'outdated' | 'tool_missing' | 'revoked';

export interface RunnerDto {
  id: string;
  name: string;
  status: RunnerRecordStatus;
  connection: RunnerConnection;
  tools: RunnerTool[];
  chosen_tool: string | null;
  runner_version: string | null;
  protocol_version: number | null;
  paired_at: string;
  last_seen_at: string | null;
  offline_since: string | null;
  paused_until: string | null;
  pause_reason: string | null;
  /** While pending: when the pairing window closes. */
  pending_expires_at: string | null;
  agents: Array<{ id: string; name: string }>;
}

export interface PairingCodeIssued {
  id: string;
  code: string;
  expires_at: string;
}

export type PairingPollStatus = 'waiting' | 'connected' | 'expired' | 'cancelled';

export interface PairingPoll {
  status: PairingPollStatus;
  expires_at: string;
  runner?: { id: string; name: string; tools: RunnerTool[] };
}

export type RunStateName =
  | 'needs_approval'
  | 'running'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'waiting_for_runner'
  | 'runner_offline'
  | 'waiting_for_limit'
  | 'waiting_for_turn';

/** `since` / `until` are ISO instants; the client formats them in the viewer's timezone. */
export interface RunState {
  state: RunStateName;
  since?: string;
  until?: string;
  runner_name?: string;
  tool?: string;
}

export type WakeReason = 'state_change' | 'assigned' | 'mention' | 'automation' | 'manual' | 'approval_decided' | 'must_comment' | 'retry';

export interface WakeDto {
  id: string;
  agent: { id: string; name: string | null };
  record: { id: string; database_id: string | null; title: string | null; number: number | null } | null;
  reason: WakeReason | string;
  coalesced_count: number;
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'canceled';
  run_id: string | null;
  run_state: RunState;
  created_at: string;
  finished_at: string | null;
}

export interface WakeSummaryAgent {
  agent_id: string;
  name: string;
  runner: { id: string; name: string } | null;
  can_run: boolean;
  waiting: number;
}

export interface WakeSummary {
  agents: WakeSummaryAgent[];
  waiting_total: number;
  agents_that_cannot_run: number;
}

export interface AssignmentDto {
  runner: { id: string; name: string } | null;
}
