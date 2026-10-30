/**
 * #1133 / ADR-0021 §2, §5, §6 — what a Runner run leaves on its Run record, as pure functions (no database, no clock of their own),
 * so every rule a number or a time obeys here is testable without a Runner.
 */
import { WAKE_LIMIT_FALLBACK_MS, WAKE_LIMIT_MAX_MS, WAKE_SUMMARY_MAX_CHARS } from './wake.constants';
import type { WakeCompleteInput } from './runner.dto';

/** The Runs-database fields a Runner run writes (api names). Every one is runtime-owned: see records/runtime-owned-fields.ts. */
export const RUNNER_RUN_FIELD_NAMES = [
  'wake_reason',
  'runner',
  'tool',
  'tool_version',
  'exit',
  'tokens_in',
  'tokens_out',
  'summary',
  'session_id',
  'limit_resumes_at',
] as const;

export type RunnerExit = WakeCompleteInput['exit'];

/** The select labels of the Run's `Exit` field, one per adapter exit (ADR-0021 §5). */
export const EXIT_LABEL: Record<RunnerExit, string> = {
  ok: 'OK',
  error: 'Error',
  limit_reached: 'Limit reached',
  aborted: 'Aborted',
  timeout: 'Timeout',
};

/** What a completion (or a claim) tells the Run record. Everything optional: a field absent here is left as it is. */
export interface RunResult {
  /** The Runner's machine name and the tool, as at the time (a rename must not rewrite history). */
  runner?: string;
  tool?: string;
  toolVersion?: string | null;
  /** The first claim: the Run STARTED now (until then its `Started at` is the time it was queued). */
  startedAt?: Date;
  exit?: RunnerExit;
  /** null = the tool did not report usage. NEVER zero-filled (CLAUDE.md: never guess numbers). */
  usage?: { tokensIn: number; tokensOut: number } | null;
  sessionId?: string;
  summary?: string;
  limitResumesAt?: Date | null;
  /** Set by the completion: the attempt that just ended, appended to the Steps log. */
  attemptNote?: string;
  /** A completion (not a claim) has ended an attempt, so `usage === null` means "not reported", not "not yet known". */
  attemptEnded?: boolean;
}

/**
 * Tokens as the tool reported them, added up over the attempts of one Run (a limit stop and its resume, a must-comment re-wake).
 * `null` only if NO attempt reported. When one attempt did and another did not, the total covers the reporters and the Steps log
 * names each attempt, so a reader can see which one is missing. Never `0` for "unknown".
 */
export function addUsage(prev: number | null, reported: number | null): number | null {
  if (reported == null) return prev;
  return (prev ?? 0) + reported;
}

/** Caps the summary and SAYS so (CLAUDE.md: silent truncation manufactures confident wrong answers). */
export function capSummary(summary: string | undefined | null): string | null {
  const s = (summary ?? '').trim();
  if (!s) return null;
  if (s.length <= WAKE_SUMMARY_MAX_CHARS) return s;
  return `${s.slice(0, WAKE_SUMMARY_MAX_CHARS)} … [summary cut: ${s.length} characters reported, the first ${WAKE_SUMMARY_MAX_CHARS} kept]`;
}

export type LimitSource = 'tool' | 'fallback_missing' | 'fallback_past' | 'clamped_future';

/**
 * When a subscription limit lets the run resume. The tool's own time is used. It is not trusted blindly, because it moves a whole
 * Runner's queue: a time in the past would put a limited run straight back in a tight loop, and a time years away would silence the
 * Runner for years. So: missing or unparseable or not in the future -> a named fallback, and a time past the queue's own 7-day life
 * -> that cap. `source` says which, and the Run's Steps log repeats it, so the time on screen is never presented as the tool's when it is not.
 */
export function resolveLimitUntil(stated: string | undefined, now: Date): { until: Date; source: LimitSource } {
  const fallback = new Date(now.getTime() + WAKE_LIMIT_FALLBACK_MS);
  if (!stated) return { until: fallback, source: 'fallback_missing' };
  const at = new Date(stated);
  if (Number.isNaN(at.getTime())) return { until: fallback, source: 'fallback_missing' };
  if (at.getTime() <= now.getTime()) return { until: fallback, source: 'fallback_past' };
  const cap = new Date(now.getTime() + WAKE_LIMIT_MAX_MS);
  if (at.getTime() > cap.getTime()) return { until: cap, source: 'clamped_future' };
  return { until: at, source: 'tool' };
}

export function describeLimitSource(source: LimitSource): string {
  switch (source) {
    case 'tool':
      return '';
    case 'fallback_missing':
      return ' The tool did not say when, so StoryOS will retry in 1 hour.';
    case 'fallback_past':
      return ' The time the tool gave had already passed, so StoryOS will retry in 1 hour.';
    case 'clamped_future':
      return ' The time the tool gave is more than 7 days away, so StoryOS will retry at the 7-day mark.';
  }
}

/** One line of the Steps log per attempt: what ended it, on what, and the tokens, or that none were reported. */
export function attemptLine(i: {
  exit: RunnerExit;
  runner: string;
  tool: string | null;
  toolVersion: string | null;
  usage: { tokensIn: number; tokensOut: number } | null;
  summary: string | null;
  error?: string;
  extra?: string;
}): string {
  const tool = i.tool ? `${i.tool}${i.toolVersion ? ` ${i.toolVersion}` : ''}` : 'the tool';
  const tokens = i.usage ? `tokens in ${i.usage.tokensIn}, out ${i.usage.tokensOut}` : 'tokens not reported by the tool';
  const tail = [i.error ? `Error: ${i.error.slice(0, 500)}` : '', i.summary ? `Summary: ${i.summary.slice(0, 500)}` : '', i.extra ?? ''].filter(Boolean).join(' ');
  return `${EXIT_LABEL[i.exit]} on ${i.runner} with ${tool}; ${tokens}.${tail ? ` ${tail}` : ''}`;
}
