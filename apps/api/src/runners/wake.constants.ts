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
  /** #1133, the must-comment backstop: a run that ended without commenting on its record is woken ONCE more with this reason. */
  'must_comment',
  'retry',
  /** ticket #1152: the one-click catch-up for records that were already in a trigger state before any wake could be made for them. */
  'catch_up',
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

/**
 * Ticket #1289 (Otto, 2026-11-13) - how each wake reason shows up in "everything that can start an agent" (`GET .../agents/{a}/wake-sources`).
 *
 * `CONFIGURED_WAKE_REASONS` are the ones somebody SET UP, so the endpoint lists the configured items themselves (an Agent Triggers
 * record is `state_change` or `assigned`; a `run_agent` rule is `automation`). Every OTHER reason is built in: it exists for every
 * agent with nothing to configure, and `BUILT_IN_WAKE_SOURCES` is its fixed entry.
 *
 * The table is typed `Record<Exclude<WakeReason, Configured>, ...>`, so adding a reason to WAKE_REASONS above is a COMPILE error here until
 * it is classified: the wake code and the endpoint read the same list, and the endpoint cannot quietly stop being complete.
 */
export const CONFIGURED_WAKE_REASONS = ['state_change', 'assigned', 'automation'] as const satisfies readonly WakeReason[];
export type ConfiguredWakeReason = (typeof CONFIGURED_WAKE_REASONS)[number];
export type BuiltInWakeReason = Exclude<WakeReason, ConfiguredWakeReason>;

export const BUILT_IN_WAKE_SOURCES: Record<BuiltInWakeReason, { title: string; description: string }> = {
  mention: {
    title: '@mention in a comment',
    description: 'A person writes a comment that @mentions the agent on a record they and the agent can both see. Nothing to set up.',
  },
  manual: {
    title: 'Run now, or delegate a record',
    description: 'A person starts the agent by hand: "Run now" on its page, the run_agent tool, or delegating a record to it. Both arrive as a manual run.',
  },
  approval_decided: {
    title: 'An approval it asked for is decided',
    description: 'The agent proposed an action that needed a person to approve it; approving or rejecting it wakes the agent to carry on with the decision.',
  },
  must_comment: {
    title: 'Comment backstop',
    description: 'A run on a record ended without commenting on it, so the agent is woken once more and asked to say what it did.',
  },
  retry: {
    title: 'Woken again while running',
    description: 'Something woke the agent while it was already running, so it gets exactly one more pass for it afterwards.',
  },
  catch_up: {
    title: 'Catch-up',
    description: 'A person clicks catch-up for records that were already in a trigger state before any wake could be made for them.',
  },
};

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

/** #1133: when a tool hit its subscription limit and said nothing usable about when it resets, retry after this. */
export const WAKE_LIMIT_FALLBACK_MS = 3_600_000;
/** #1133: a stated reset further away than this is cut to it (the queue's own life), so one bad time cannot silence a Runner for years. */
export const WAKE_LIMIT_MAX_MS = WAKE_QUEUE_TTL_MS;
/** #1133: the Run's Summary field holds at most this many characters, and says so when it cut. */
export const WAKE_SUMMARY_MAX_CHARS = 2_000;
