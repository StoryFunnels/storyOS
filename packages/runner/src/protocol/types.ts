// SPDX-License-Identifier: Apache-2.0
/**
 * The Runner protocol, as the Runner speaks it (ADR-0021 sections 2, 3, 5, 8).
 *
 * These types are defined HERE, not imported from the server's packages: the Runner is Apache-2.0 and the server is AGPL, and code
 * may flow from Apache into AGPL but never the other way (ADR-0021 section 9). `test/contract.test.ts` keeps these request shapes
 * honest by reading the server's `docs/api/openapi.json` as DATA.
 *
 * Inside one protocol number changes are additive only and unknown fields are ignored on both sides (ADR-0021 section 8), so every
 * response type below lists only what the Runner reads.
 */

/** The protocol number this Runner speaks. Bumped only with a breaking change (ADR-0021 section 8). */
export const PROTOCOL_VERSION = 1;

/** Paths under `<server>/api/v1/runner/v1`. */
export const API_PREFIX = '/api/v1/runner/v1';

export interface ToolReport {
  id: string;
  name?: string;
  installed: boolean;
  version?: string;
  logged_in?: boolean;
  capabilities?: Record<string, unknown>;
}

/** What a Runner reports about itself, on pairing and on every heartbeat. Compatibility facts, NOT provenance. */
export interface RunnerReport {
  machine_name: string;
  tools: ToolReport[];
  runner_version: string;
  protocol_version: number;
}

export interface PairRequest extends RunnerReport {
  /** What the person typed. The server forgives case and a dash. */
  code: string;
}

export interface PairResponse {
  /** `mn_run_...`, shown ONCE. */
  token: string;
  runner: { id: string; status: 'pending' | 'active' | 'revoked'; name: string };
  workspace_id: string;
  pending_expires_at: string;
  protocol: { minimum: number; maximum: number };
}

export type RunnerStatus = 'pending' | 'active' | 'revoked';

export interface HeartbeatResponse {
  runner: { id: string; status: RunnerStatus; chosen_tool: string | null; name: string };
  protocol: { minimum: number; maximum: number; current: number };
  server_time?: string;
  heartbeat_interval_seconds: number;
  offline_after_seconds?: number;
  assigned_agents: Array<{ id: string; name: string }>;
}

export interface ClaimRequest {
  max?: number;
  wait_seconds?: number;
  wake_id?: string;
}

/** One claimed wake: ids, a reason and counts, NEVER record text (ADR-0021 section 7), plus the run credential, shown once. */
export interface ClaimedWake {
  id: string;
  nonce: string;
  lease_expires_at: string;
  lease_seconds: number;
  heartbeat_seconds: number;
  reason: string;
  reasons: Array<{ reason: string; count?: number; last_at?: string }>;
  depth: number;
  run_id: string | null;
  agent: {
    id: string;
    name: string;
    goal: string | null;
    instructions: string | null;
    skills: string | null;
    target_databases: string | null;
  };
  record: { id: string; database_id: string; number: number | null } | null;
  context: unknown;
  /** The per-run credential. Never logged, never kept past the run. */
  credential: { token: string; scope: string; expires_at: string };
}

export interface ClaimResponse {
  wakes: ClaimedWake[];
  protocol?: { minimum: number; maximum: number };
}

export interface LeaseRequest {
  nonce: string;
}

export interface LeaseResponse {
  wake_id: string;
  lease_expires_at: string;
  lease_seconds: number;
}

export const EXIT_KINDS = ['ok', 'error', 'limit_reached', 'aborted', 'timeout'] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

/** Every property a tool report may carry (checked against the server's schema by the contract test). */
export const TOOL_REPORT_FIELDS = ['id', 'name', 'installed', 'version', 'logged_in', 'capabilities'] as const;

export interface CompleteRequest {
  nonce: string;
  exit: ExitKind;
  /** `null` means the tool did not report usage. NEVER zero-filled. */
  usage?: { tokens_in: number; tokens_out: number } | null;
  session_id?: string;
  summary?: string;
  error?: string;
  limit_reached_until?: string;
  tool_version?: string;
}

export interface CompleteResponse {
  wake_id: string;
  status: string;
  requeued: boolean;
  repeated: boolean;
}

/**
 * The request bodies this Runner sends, by the name of the server's DTO in `docs/api/openapi.json`. `required` and `optional` are
 * every property the Runner may put in that body. The contract test fails when the server's schema and this table disagree.
 */
export const REQUEST_CONTRACT = {
  RunnerPairDto: {
    path: '/api/v1/runner/v1/pair',
    required: ['code', 'machine_name', 'tools', 'runner_version', 'protocol_version'],
    optional: [],
  },
  RunnerHeartbeatDto: {
    path: '/api/v1/runner/v1/heartbeat',
    required: ['machine_name', 'tools', 'runner_version', 'protocol_version'],
    optional: [],
  },
  WakeClaimDto: {
    path: '/api/v1/runner/v1/claim',
    required: [],
    optional: ['max', 'wait_seconds', 'wake_id'],
  },
  WakeLeaseDto: {
    path: '/api/v1/runner/v1/wakes/{id}/heartbeat',
    required: ['nonce'],
    optional: [],
  },
  WakeCompleteDto: {
    path: '/api/v1/runner/v1/wakes/{id}/complete',
    required: ['nonce', 'exit'],
    optional: ['usage', 'session_id', 'summary', 'error', 'limit_reached_until', 'tool_version'],
  },
} as const;
