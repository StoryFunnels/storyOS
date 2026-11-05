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
  /** Ticket #1137: true only where the tool reports how much of the person's plan is used. Absent on an API that predates it. */
  reserve_measurable?: boolean;
}

export type WorkingDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** Ticket #1137, `workingHoursSchema` in apps/api/src/runners/runner-sharing.ts: wall-clock times in an IANA zone. */
export interface WorkingHours {
  days: WorkingDay[];
  /** "HH:MM", 24-hour. When `end` is not after `start` the window runs past midnight and belongs to the day it starts. */
  start: string;
  end: string;
  timezone: string;
}

export type HoldReason = 'limit_reached' | 'working_hours' | 'reserve';

/** Why a Runner is not claiming right now (`holdFor` in runner-sharing.ts). `resumes_at` null = nothing can say when. */
export interface RunnerHold {
  reason: HoldReason;
  resumes_at: string | null;
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
  /**
   * Ticket #1137, `runner-present.ts`. Every field is optional here so an API that predates them, or a fixture, reads as "no rule":
   * the screen never invents a rule from an absent field.
   */
  working_hours?: WorkingHours | null;
  reserve_percent?: number | null;
  reserve_measurable?: boolean;
  reserve_unmeasurable_message?: string | null;
  within_working_hours?: boolean | null;
  working_hours_closes_at?: string | null;
  working_hours_resumes_at?: string | null;
  hold?: RunnerHold | null;
}

/** The body of `PATCH /workspaces/{ws}/runners/{id}` for the sharing settings: any subset, `null` clears (RunnerUpdateDto). */
export interface RunnerSharingPatch {
  working_hours?: WorkingHours | null;
  reserve_percent?: number | null;
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
  | 'waiting_for_turn'
  /** Ticket #1137: outside the Runner's working hours; `until` is when the window opens. */
  | 'waiting_for_hours'
  /** Ticket #1137: the person's reserve is being kept; `until` is the tool's reported reset, absent when unknown. */
  | 'waiting_for_reserve';

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
