import { pluralNoun } from '@/lib/records';
import { CATCH_UP_MAX_PER_CLICK, runsLineKind, startsNow } from './catch-up';
import type { RunsLineInput, ScopeWords } from './catch-up';

/**
 * Ticket #1152 — Dara's catch-up copy (ticket comments of 2026-10-29, prototype v45 to v47), in ONE module so a test pins each
 * string and a screen cannot reword it. Where the API cannot say what her sentence needs, the words degrade to what is true
 * instead of inventing it:
 *  - no record is ever NAMED (no endpoint lists which records wait), so "Acme Co (sample) was in Onboarding" reads "It was in Onboarding";
 *  - the dialog's record list is one row: the count and the rule that selected them ("Status is Onboarding");
 *  - the job text is the agent's own job line, quoted, because free text cannot be spliced into a sentence without breaking it.
 * More than one click's worth (25) is said out loud: the button never promises more than it will do.
 */

const plural = (noun: string, n: number) => pluralNoun(noun, n);

export function boxTitle(n: number, words: ScopeWords): string {
  return `${n} ${plural(words.noun, n)} already waiting`;
}

export function boxBody(n: number, agent: string, words: ScopeWords): string {
  const where = words.state ? `in ${words.state.label}` : 'already in its trigger state';
  const first = `${n === 1 ? 'It was' : 'They were'} ${where} before ${agent} could run, so ${n === 1 ? 'it' : 'they'} won’t wake it. New ${plural(words.noun, 2)} will.`;
  return n > CATCH_UP_MAX_PER_CLICK ? `${first} It starts ${CATCH_UP_MAX_PER_CLICK} at a time.` : first;
}

/** The box's primary button. Past the per-click cap it says how many it will start, not how many exist. */
export function boxButton(n: number, words: ScopeWords): string {
  return n > CATCH_UP_MAX_PER_CLICK
    ? `Start on the first ${CATCH_UP_MAX_PER_CLICK} waiting ${plural(words.noun, 2)}`
    : `Start on ${n} waiting ${plural(words.noun, n)}`;
}

export function dialogTitle(n: number, agent: string, words: ScopeWords): string {
  return n > CATCH_UP_MAX_PER_CLICK
    ? `Start ${agent} on the first ${CATCH_UP_MAX_PER_CLICK} of ${n} waiting ${plural(words.noun, n)}?`
    : `Start ${agent} on ${n} waiting ${plural(words.noun, n)}?`;
}

export function dialogButton(n: number, words: ScopeWords): string {
  const k = startsNow(n);
  return `Start on ${k} ${plural(words.noun, k)}`;
}

/** The one row that stands in for Dara's record list: how many, and the rule that selected them. Null when the rule is not known. */
export function scopeRow(n: number, words: ScopeWords): { left: string; right: string } | null {
  return words.state ? { left: `${n} ${plural(words.noun, n)}`, right: `${words.state.field} is ${words.state.label}` } : null;
}

export function dialogJob(n: number, agent: string, words: ScopeWords, job: string): string {
  const base = `It does for ${n === 1 ? `this ${words.noun}` : 'each one'} what it does for every new ${words.noun}.`;
  return job.trim() ? `${base} ${agent}’s job: “${job.trim()}”` : base;
}

/** "It asks you before sending email, calling another service or deleting anything." Null when no hold is set: it must not claim one. */
export function dialogAsks(phrases: readonly string[]): string | null {
  if (phrases.length === 0) return null;
  const list = phrases.length === 1 ? phrases[0]! : `${phrases.slice(0, -1).join(', ')} or ${phrases[phrases.length - 1]}`;
  return `It asks you before ${list}.`;
}

/** The muted line under the dialog body: where the runs happen, and when they start if the Runner cannot take them now. */
export function dialogRunsLine(o: RunsLineInput): string {
  const { n, machine, tool, brand, runner, clock } = o;
  const kind = runsLineKind(runner);
  const runs = `${n} run${n === 1 ? '' : 's'}`;
  const where = machine ? ` on ${machine}${tool ? ` with ${tool}` : ''}` : '';
  const start = n === 1 ? 'it starts' : 'they start';
  const lead = `${runs}${where}${n === 1 ? '.' : ', one at a time.'}`;
  switch (kind) {
    case 'offline':
      return `${lead} Your Runner is offline: ${start} when it’s back.`;
    case 'limit': {
      const until = runner?.paused_until ? ` at ${clock(runner.paused_until)}` : '';
      return `${lead} Your ${brand ?? 'AI'} limit is reached: ${start} when it resets${until}.`;
    }
    case 'attention':
      return `${lead} Your Runner needs attention: ${start} when it’s ready.`;
    default:
      // Only a brand we know can run out; without one the sentence would name a limit we cannot name.
      return n > 1 && brand ? `${lead} If your ${brand} limit runs out, the rest wait for it to reset.` : lead;
  }
}

export const DIALOG_CANCEL = 'Not now';
export const DIALOG_STARTING = 'Starting…';

/** After a click: what happened, in words, with what is still to do said plainly. */
export function startedToast(agent: string, r: { queued: number; already_waiting: number; remaining: number }, words: ScopeWords): string {
  const more = r.remaining > 0 ? ` ${r.remaining} more remain.` : '';
  if (r.queued > 0) return `${agent} is starting on ${r.queued} ${plural(words.noun, r.queued)}.${more}`;
  if (r.already_waiting > 0) return `Nothing new to start: ${r.already_waiting} ${plural(words.noun, r.already_waiting)} already waiting for ${agent}.${more}`;
  return `Nothing to start: no ${plural(words.noun, 2)} were left waiting.${more}`;
}

export const CATCH_UP_FAILED = 'Could not start the waiting records. Try again.';

/**
 * Dara's Done toast (v45): "<machine> is ready. New clients in Onboarding now wake Onboarding Assistant." It names the state only
 * when the trigger said it; otherwise the existing wording in `readyToast` stands. One agent only: with several the sentence
 * would have to pick one state.
 */
export function readyToastWithScope(machine: string, agent: string, words: ScopeWords): string | null {
  if (!words.state) return null;
  return `${machine} is ready. New ${plural(words.noun, 2)} in ${words.state.label} now wake ${agent}.`;
}
