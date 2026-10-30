/**
 * #1130 / ADR-0021 §1-2 — the wake queue's named constants (open question 10: ship them as named constants, tune from #1141's data).
 */

/** Why an agent was woken. Text in the database, validated here, so a new reason never needs a migration. */
export const WAKE_REASONS = [
  /** A state-change binding (the existing Agent Trigger kind). The ADR's table names no reason for it; this one is additive. */
  'state_change',
  /** A relation-to-Agents field was set on a record (the new binding kind; how `Next` wakes an agent). */
  'assigned',
  'mention',
  /** A `run_agent` automation action. The ADR says `schedule`; a rule or button run arrives the same way and cannot be told apart. */
  'automation',
  'manual',
  'approval_decided',
  /** Reserved for #1133 (the must-comment backstop). */
  'must_comment',
  'retry',
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

export const WAKE_STATUSES = ['queued', 'claimed', 'done', 'failed', 'canceled'] as const;
export type WakeStatus = (typeof WAKE_STATUSES)[number];

/** The lease a claim holds. A Runner renews it every WAKE_HEARTBEAT_SECONDS; the reaper returns an unrenewed one to the queue. */
export const WAKE_LEASE_SECONDS = 90;
export const WAKE_HEARTBEAT_SECONDS = 30;
/** A long-poll claim is held at most this long (ADR-0021 §2: about 25 s). */
export const WAKE_LONG_POLL_MAX_SECONDS = 25;
/** How often a held long poll looks again. */
export const WAKE_LONG_POLL_TICK_MS = 1_000;
/** Lost leases before a wake FAILS instead of returning to the queue. */
export const WAKE_MAX_ATTEMPTS = 3;
/** A hard ceiling on one claim: past it the lease is no longer renewed, so a session that heartbeats forever still ends. */
export const WAKE_RUN_CEILING_MS = 30 * 60_000;
/** A queued wake nobody can serve is cancelled after this (the 7-day default approvals use). */
export const WAKE_QUEUE_TTL_MS = 7 * 24 * 3_600_000;
/** Terminal wakes are history; they are dropped after this. */
export const WAKE_HISTORY_TTL_MS = 30 * 24 * 3_600_000;
/** The loop guard of ADR-0010 §5, applied to every wake source: a wake carries its depth. */
export const WAKE_MAX_DEPTH = 2;
/** Most wakes one claim may take, however many the Runner asks for. */
export const WAKE_CLAIM_MAX = 10;
