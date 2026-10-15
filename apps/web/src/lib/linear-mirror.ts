/**
 * The Linear mirror page's view-model (ticket #919), as pure functions so what the page tells an admin
 * can be tested. Field names are the API's, read from the services (`LinearService.dryRun`,
 * `present`), not guessed.
 *
 * Two rules the page is built on:
 *  - A count that does not add up is an ERROR with both numbers, never a number. The preview is the
 *    moment an admin can spot unrelated work before it lands in a shared workspace.
 *  - The server decides what is stale or failing (`sync.stale`, `consecutive_failures`). The page
 *    reports it; it does not re-derive health from timestamps.
 */

export interface PreviewTeam {
  key: string;
  name: string;
  issues: number;
  /** Linear's own total for the team; absent on an older API, in which case the check cannot be made. */
  linear_issue_total?: number;
  comments?: number;
  sprints: number;
  projects: number;
  issues_by_project?: Array<{ project_id: string | null; name: string; issues: number }>;
  issues_by_status?: Array<{ status: string; type: string; issues: number }>;
}

export interface PreviewProblem {
  kind: 'total_mismatch' | 'project_sum_mismatch' | 'total_unknown';
  message: string;
}

/**
 * What is wrong with one team's preview. Empty means every number we can check agrees.
 * `total_unknown` is a problem on its own: a preview that cannot be checked against Linear's total
 * must not read as one that was.
 */
export function previewProblems(team: PreviewTeam): PreviewProblem[] {
  const problems: PreviewProblem[] = [];
  if (typeof team.linear_issue_total !== 'number') {
    problems.push({ kind: 'total_unknown', message: `Linear's own issue total was not reported for ${team.key}, so this count could not be checked.` });
  } else if (team.linear_issue_total !== team.issues) {
    problems.push({
      kind: 'total_mismatch',
      message: `${team.key}: ${team.issues} issues would be copied, but Linear reports ${team.linear_issue_total}. Do not sync until these agree.`,
    });
  }
  if (team.issues_by_project) {
    const sum = team.issues_by_project.reduce((n, p) => n + p.issues, 0);
    if (sum !== team.issues) {
      problems.push({
        kind: 'project_sum_mismatch',
        message: `${team.key}: the per-project counts add up to ${sum}, but the team count is ${team.issues}.`,
      });
    }
  }
  return problems;
}

export function previewTotals(teams: PreviewTeam[]): { issues: number; linearTotal: number | null } {
  const known = teams.every((t) => typeof t.linear_issue_total === 'number');
  return {
    issues: teams.reduce((n, t) => n + t.issues, 0),
    linearTotal: known ? teams.reduce((n, t) => n + (t.linear_issue_total as number), 0) : null,
  };
}

export const INTERVAL_OPTIONS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 180, label: 'Every 3 hours' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Every 24 hours' },
];

/** The API accepts any whole number of minutes from 15 to 1440 (#906). */
export const MIN_INTERVAL_MINUTES = 15;
export const MAX_INTERVAL_MINUTES = 1440;

/** The options to offer: the presets, plus the saved value when it is not one of them, so it is never silently replaced. */
export function intervalOptionsFor(current: number): Array<{ minutes: number; label: string }> {
  if (INTERVAL_OPTIONS.some((o) => o.minutes === current)) return [...INTERVAL_OPTIONS];
  return [...INTERVAL_OPTIONS, { minutes: current, label: `Every ${current} minutes (saved)` }].sort((a, b) => a.minutes - b.minutes);
}

export interface SyncStatus {
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  stale: boolean;
  next_due_at: string | null;
  last_run: { issues: number; comments: number; drift_flagged: number; left_scope: number; duration_ms: number } | null;
  running: boolean;
}

export type MirrorHealth = 'off' | 'stale' | 'failing' | 'ok';

/**
 * `stale` wins over `failing`: it is the stronger statement (nothing has succeeded for two
 * intervals) and the one the banner is for. With the schedule off nothing is expected to refresh,
 * so there is nothing to call stale.
 */
export function mirrorHealth(scheduleEnabled: boolean, sync: SyncStatus): MirrorHealth {
  if (!scheduleEnabled) return 'off';
  if (sync.stale) return 'stale';
  if (sync.consecutive_failures > 0) return 'failing';
  return 'ok';
}

export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'never';
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'never';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** When the next run is due, in words. A moment in the past means it is overdue, not scheduled. */
export function dueIn(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'due now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  return `in ${Math.round(min / 60)} h`;
}

export function intervalWords(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '24 hours' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return minutes === 60 ? 'hour' : `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export interface WriteBackStatus {
  enabled: boolean;
  pending: number;
  failed: number;
  last_error: string | null;
}

/** What the write-back row must say about undelivered comments. Empty when everything has been delivered. */
export function writeBackProblems(wb: WriteBackStatus): string[] {
  const out: string[] = [];
  if (wb.failed > 0) {
    out.push(`${wb.failed} comment${wb.failed === 1 ? '' : 's'} could not be delivered to Linear and ${wb.failed === 1 ? 'was' : 'were'} given up on.`);
  }
  if (wb.pending > 0) out.push(`${wb.pending} comment${wb.pending === 1 ? ' is' : 's are'} waiting to be delivered.`);
  return out;
}

/** The one sentence that must be on screen next to the write-back switch. */
export const WRITE_BACK_DISCLOSURE =
  'Turning this on posts comments written in StoryOS on a mirrored ticket into Linear. They are posted under the identity of the API key connected above, with the author named in the first line: "<author> · via StoryOS". Comments only: no ticket field in Linear is ever changed. Only comments written after you switch it on are sent; nothing earlier is replayed.';
