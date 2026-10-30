import type { RunState, RunnerDto, WakeDto } from './types';
import { checkedAgo, clockTime, limitBrand, shortDate, toolName } from './words';
import type { TimeOpts } from './words';

/**
 * Ticket #1139 — what a Runner, and a run, SAY about themselves. Pure functions of the API's own derived state: the server owns
 * "what is this agent doing about this" (`run_state`, ADR-0021 §11) and the web only renders it, so nothing here recomputes a
 * state from a status.
 *
 * COLOUR IS A RULE, not a style (#831, Dara's #1129 walkthrough). Gold means the agent is ACTING or ASKING, so exactly two tones
 * are gold: `go` (a run in progress) and `ask` (a run waiting for your approval). Waiting and offline are calm grey (`off`),
 * the limit wait is amber (`limit`), failure uses the error colour (`fail`) and a cancel is neutral (`cancel`). The test pins
 * which tones are gold, so a new state cannot quietly borrow the colour.
 */
export type StatusTone = 'on' | 'off' | 'limit' | 'go' | 'ask' | 'done' | 'fail' | 'cancel';

export const GOLD_TONES: readonly StatusTone[] = ['go', 'ask'];

export interface StatusLine {
  tone: StatusTone;
  label: string;
}

/** The Runner's own line on Settings › Runners: "Online · checked a minute ago". */
export function describeRunner(r: RunnerDto, now: Date, o: TimeOpts = {}): StatusLine {
  const tool = toolName(r.chosen_tool, r.tools);
  switch (r.connection) {
    case 'online':
      return { tone: 'on', label: r.last_seen_at ? `Online · checked ${checkedAgo(r.last_seen_at, now)}` : 'Online' };
    case 'offline':
      return { tone: 'off', label: `${r.offline_since ? `Offline since ${clockTime(r.offline_since, o)}` : 'Offline'} · agents wait until it’s back` };
    case 'paused':
      // Quiet hours (#1137) are not built, so today the only pause is a limit. A pause with another reason says so plainly.
      return r.pause_reason === 'limit_reached' || !r.pause_reason
        ? { tone: 'limit', label: `Waiting for your ${limitBrand(r.chosen_tool, r.tools)} limit to reset${r.paused_until ? ` at ${clockTime(r.paused_until, o)}` : ''}` }
        : { tone: 'off', label: `Paused${r.paused_until ? ` until ${clockTime(r.paused_until, o)}` : ''}` };
    case 'tool_missing':
      return { tone: 'off', label: `${tool} was not found on this computer · agents wait` };
    case 'outdated':
      return { tone: 'off', label: 'Needs an update · run npx @storyos/runner@latest' };
    case 'revoked':
      return { tone: 'off', label: 'Removed' };
  }
}

/** The shorter form used inside a "Runs on" menu row: the live status next to the tool, with no "checked" clock. */
export function describeRunnerShort(r: RunnerDto, now: Date, o: TimeOpts = {}): string {
  return `${toolName(r.chosen_tool, r.tools)} on your subscription · ${describeRunner(r, now, o).label}`;
}

export interface RunLine extends StatusLine {
  /** The second line under the record title, or null when the API gave nothing to say beyond the state. */
  sub: string | null;
  /** The one action this state offers. `try_again` is never produced: no endpoint re-queues a failed wake (see the ticket's gaps). */
  action: 'review' | null;
}

const REASON_WORDS: Record<string, string> = {
  state_change: 'Matched its trigger',
  assigned: 'Set on it as its agent',
  mention: 'Mentioned it',
  automation: 'Started by an automation',
  manual: 'Started by hand',
  approval_decided: 'An approval was decided',
  must_comment: 'Asked to leave a comment',
  retry: 'Tried again',
};

/** Why the agent was woken, as one phrase. A reason this build has not heard of is shown as "Woken", never as the raw slug. */
export function reasonLine(w: Pick<WakeDto, 'reason' | 'coalesced_count'>): string {
  const base = REASON_WORDS[w.reason] ?? 'Woken';
  return w.coalesced_count > 1 ? `${base} · ${w.coalesced_count} changes while it waited` : base;
}

/**
 * One run's state exactly as Dara drew it (waiting for a Runner · Runner offline · waiting for the limit · running · needs your
 * approval · done · failed · canceled), with the words degraded where the API cannot yet say more.
 *
 * What the API does NOT say, and this refuses to invent: whether a failed run changed anything, and who canceled a canceled
 * one. Dara's example "Stopped part-way: Claude Code stopped responding. Nothing was changed." needs the Run record's steps
 * (Marek's #1133); until the row carries them the sub-line says only what is true, and never claims "nothing was changed".
 */
export function describeRun(w: WakeDto, o: TimeOpts = {}): RunLine {
  const s: RunState = w.run_state;
  const when = (iso: string | null | undefined) => (iso ? shortDate(iso, o) : null);
  const base = reasonLine(w);
  switch (s.state) {
    case 'needs_approval':
      return { tone: 'ask', label: 'Needs your approval', sub: base, action: 'review' };
    case 'running':
      return { tone: 'go', label: s.runner_name ? `Running on ${s.runner_name}` : 'Running', sub: base, action: null };
    case 'done': {
      const d = when(w.finished_at);
      return { tone: 'done', label: d ? `Done · ${d}` : 'Done', sub: base, action: null };
    }
    case 'failed': {
      const d = when(w.finished_at);
      return {
        tone: 'fail',
        label: d ? `Failed · ${d}` : 'Failed',
        sub: 'Stopped before it finished. Open the run to see what it did before it stopped.',
        action: null,
      };
    }
    case 'canceled': {
      const d = when(w.finished_at);
      return { tone: 'cancel', label: d ? `Canceled · ${d}` : 'Canceled', sub: 'Canceled before it finished.', action: null };
    }
    case 'runner_offline':
      return {
        tone: 'off',
        label: `Runner offline${s.since ? ` since ${clockTime(s.since, o)}` : ''} · starts when it’s back`,
        sub: base,
        action: null,
      };
    case 'waiting_for_limit':
      return {
        tone: 'limit',
        label: `Waiting for your ${limitBrand(s.tool)} limit to reset${s.until ? ` at ${clockTime(s.until, o)}` : ''}`,
        sub: base,
        action: null,
      };
    case 'waiting_for_turn':
      return { tone: 'off', label: 'Waiting for the Runner', sub: 'Waiting its turn: the Runner does one job at a time', action: null };
    case 'waiting_for_runner':
      // With no Runner assigned this is Dara's "Waiting for a Runner". With one assigned and online (the server names it) the work
      // is simply queued to start, and saying "waiting for a Runner" would send someone off to add one they already have.
      return { tone: 'off', label: s.runner_name ? `Waiting to start on ${s.runner_name}` : 'Waiting for a Runner', sub: base, action: null };
  }
}

/** Whether a wake is finished history rather than something live. */
export function isFinishedRun(w: Pick<WakeDto, 'run_state'>): boolean {
  return w.run_state.state === 'done' || w.run_state.state === 'failed' || w.run_state.state === 'canceled';
}
