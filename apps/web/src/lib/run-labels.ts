/**
 * #148 / #157 — plain-English labels for the automation Runs page, so a
 * non-technical owner reads "Skipped — over quota" and "Email — sent" instead
 * of raw enum slugs (`skipped_quota`) and `kind:status` pairs.
 *
 * Pure and dependency-free on purpose (unit-tested in run-labels.unit.test.ts):
 * every enum value the API can emit is mapped here, and anything unmapped falls
 * back to a humanized Title-Case string rather than leaking the raw slug.
 *
 * Enum sources (kept in sync with the API):
 *  - run status:     apps/api/src/runs/runs.service.ts KNOWN_STATUSES + db schema
 *                    (`ok | error | running | skipped | skipped_quota | skipped_cap`)
 *  - action status:  automation_jobs.status (`queued | running | succeeded |
 *                    failed | canceled`) + the synthetic `pending_approval`
 *  - approval status: approvals.status (`pending | approved | rejected | expired`)
 *  - trigger kind:   packages/schemas automationTriggerSchema
 *  - action kind:    packages/schemas actionSchema (+ future post_social.* / youtube_upload)
 */

/** snake_case / dotted / camelCase → "Title Case" fallback for anything unmapped. */
export function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * #997 — ONE vocabulary for a run's state, on every surface that shows it (the list pill, the filter, the detail, the
 * explainer card, Home): Succeeded · Failed · Running · Skipped · Skipped (quota) · Awaiting approval. It replaces
 * "OK" (filter), "Completed" (rows) and "Waiting for approval" (the card), which were three names for one state.
 */
const RUN_STATUS_LABELS: Record<string, string> = {
  ok: 'Succeeded',
  error: 'Failed',
  running: 'Running',
  skipped: 'Skipped',
  skipped_quota: 'Skipped (quota)',
  skipped_cap: 'Skipped (limit)',
  pending_approval: 'Awaiting approval',
  // What the API itself returns once ticket #1009 lands (a derived status, never stored); same words as the join's.
  awaiting_approval: 'Awaiting approval',
};

/** Friendly phrase for a whole run's status (e.g. `skipped_quota`). */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? humanizeSlug(status);
}

const ACTION_STATUS_LABELS: Record<string, string> = {
  queued: 'Waiting to run',
  running: 'Running',
  succeeded: 'Sent',
  failed: 'Failed',
  canceled: 'Canceled',
  pending_approval: 'Waiting for approval',
};

/** Friendly phrase for one step's (automation_job) status. */
export function actionStatusLabel(status: string): string {
  return ACTION_STATUS_LABELS[status] ?? humanizeSlug(status);
}

const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting for a decision',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired (no decision in time)',
};

/** Friendly phrase for an approval's status. */
export function approvalStatusLabel(status: string): string {
  return APPROVAL_STATUS_LABELS[status] ?? humanizeSlug(status);
}

const TRIGGER_KIND_LABELS: Record<string, string> = {
  record_created: 'When a record is created',
  record_updated: 'When a record changes',
  record_linked: 'When a record is linked',
  schedule: 'On a schedule',
  webhook_received: 'When a webhook arrives',
};

/** Friendly phrase for a rule's trigger (e.g. `record_created`). */
export function triggerKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'Manual or unknown trigger';
  return TRIGGER_KIND_LABELS[kind] ?? humanizeSlug(kind);
}

const ACTION_KIND_LABELS: Record<string, string> = {
  send_email: 'Email',
  http_request: 'HTTP request',
  send_webhook: 'Webhook',
  run_agent: 'AI agent',
  send_slack_message: 'Slack message',
  notify_user: 'Notification',
  create_record: 'Create record',
  set_values: 'Update fields',
  add_comment: 'Comment',
  update_linked: 'Update linked records',
  youtube_upload: 'YouTube upload',
  'post_social.linkedin': 'LinkedIn post',
  'post_social.x': 'X post',
  'post_social.twitter': 'X post',
  'post_social.facebook': 'Facebook post',
  'post_social.instagram': 'Instagram post',
};

/**
 * Friendly name for one step's action kind (e.g. `send_email` → "Email").
 * Unmapped `post_social.<network>` becomes "<Network> post"; anything else
 * falls back to a humanized slug so nothing shows a raw key.
 */
export function actionKindLabel(kind: string | null | undefined): string {
  if (!kind) return 'Action';
  if (ACTION_KIND_LABELS[kind]) return ACTION_KIND_LABELS[kind];
  if (kind.startsWith('post_social.')) {
    const network = kind.slice('post_social.'.length);
    return `${humanizeSlug(network)} post`;
  }
  return humanizeSlug(kind);
}

/**
 * One plain-English line for a run step, e.g. "Email — sent" or
 * "Webhook — failed after 3 tries". `kind` may be null (a still-pending
 * approval has no job kind yet) — callers can pass a fallback label.
 */
export function runStepSummary(step: {
  kind: string | null | undefined;
  status: string;
  attempts?: number;
  fallbackLabel?: string | null;
}): string {
  const label = step.kind ? actionKindLabel(step.kind) : step.fallbackLabel || 'Action';
  let phrase = actionStatusLabel(step.status).toLowerCase();
  if (step.status === 'failed' && (step.attempts ?? 0) > 1) {
    phrase = `failed after ${step.attempts} tries`;
  }
  return `${label} — ${phrase}`;
}

/**
 * A compact, comma-joined plain-English summary of a run's steps for the list
 * row — replaces the old `kind:status` pairs.
 */
export function runActionSummaryText(steps: { kind: string; status: string }[]): string {
  return steps.map((s) => runStepSummary({ kind: s.kind, status: s.status })).join(', ');
}

/**
 * Human-readable duration — a run's `duration_ms` as "under a second", "1.2s",
 * or "2m 5s" instead of a raw millisecond count. Exact ms stays available in
 * the Technical details expander.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return 'under a second';
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * #997 — the state a person should SEE for a run.
 *
 * The API closes a run row as `ok` once its actions are queued, so a run whose action is waiting for a person to
 * approve it reads `ok` in the list. The approvals list says which runs are waiting (`run_id` of every pending
 * approval), and this is the join: an `ok` run with a pending approval is `pending_approval`; any other status is
 * what the API said. Pure, so the pill, the filter and the count all agree.
 */
export function effectiveRunStatus(status: string, runId: string, pendingRunIds: ReadonlySet<string>): string {
  return status === 'ok' && pendingRunIds.has(runId) ? 'pending_approval' : status;
}

/** The filter's options, in the prototype's order. `value` is the EFFECTIVE status ('' = all). */
export const RUN_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All statuses' },
  { value: 'pending_approval', label: runStatusLabel('pending_approval') },
  { value: 'ok', label: runStatusLabel('ok') },
  { value: 'error', label: runStatusLabel('error') },
  { value: 'running', label: runStatusLabel('running') },
  { value: 'skipped', label: runStatusLabel('skipped') },
  { value: 'skipped_quota', label: runStatusLabel('skipped_quota') },
];

/** The colour family of a status pill / dot: success, failure, waiting on a person, in flight, or skipped. */
export type RunTone = 'ok' | 'fail' | 'wait' | 'run' | 'skip';
export function runStatusTone(status: string): RunTone {
  if (status === 'ok') return 'ok';
  if (status === 'error') return 'fail';
  if (status === 'pending_approval' || status === 'awaiting_approval') return 'wait';
  if (status === 'running') return 'run';
  return 'skip';
}

/** One word for a step in the numbered list: "done", "waiting for you", "failed"… */
export function stepStateWord(status: string): string {
  switch (status) {
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'pending_approval':
      return 'waiting for you';
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'canceled':
      return 'canceled';
    default:
      return humanizeSlug(status).toLowerCase();
  }
}

/**
 * #997 — when a run started, the way the list reads it ("4 min ago", "yesterday"), falling back to the person's own
 * date format once it is older than a week. Pure: `now` and the date formatter are passed in.
 */
export function startedLabel(iso: string, now: Date, formatDate: (iso: string) => string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return formatDate(iso);
}

/**
 * #997 — the list's narrow Duration column: "0.4 s", "3.1 s", "2m 5s", "—". The detail keeps the long wording
 * ("under a second") where there is room; this one has 64px.
 */
export function formatDurationShort(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 100) return '<0.1 s';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}
