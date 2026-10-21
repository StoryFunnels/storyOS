import { z } from 'zod';

/**
 * Ticket #1014 — what KIND of state a workflow option is, so "finished" is data and not a guess from the label.
 *
 * The five are Linear's state types (its states carry one, and the Linear import sets it from there): `backlog` (parked, not planned),
 * `unstarted` (planned, not begun), `started` (in progress), `completed` (done) and `canceled` (abandoned). `completed` and `canceled`
 * are the FINISHED ones: a record in either is no longer open work (`isFinishedStateCategory`).
 */
export const STATE_CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
export type StateCategory = (typeof STATE_CATEGORIES)[number];
export const stateCategorySchema = z.enum(STATE_CATEGORIES);

/** A record in a `completed` or `canceled` state is finished. */
export function isFinishedStateCategory(category: string | null | undefined): boolean {
  return category === 'completed' || category === 'canceled';
}

/** Linear's workflow-state `type` → our category (Linear's `triage` is the inbox before the backlog). Null for a type we do not know. */
export function linearStateCategory(type: string | null | undefined): StateCategory | null {
  switch (type) {
    case 'backlog':
    case 'triage':
      return 'backlog';
    case 'unstarted':
      return 'unstarted';
    case 'started':
      return 'started';
    case 'completed':
      return 'completed';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return null;
  }
}

/** The labels that have always meant "finished" in this product (My Work's `isCompletedState`, the done-style automation recipes). */
const COMPLETED_LABEL = /^(done|complete|completed|closed|shipped|resolved|archived)$/i;
const CANCELED_LABEL = /^cancell?ed$/i;
const BACKLOG_LABEL = /^(backlog|triage|icebox|someday)$/i;
const STARTED_LABEL = /^(in progress|in review|review|doing|started|active|wip)$/i;

/**
 * The category a workflow option gets when nobody has chosen one: the rule the web used to apply at read time (`isCompletedState`), written
 * down once, so the migration's backfill (the same rule in SQL, proven equal by a test), a new option and a converted field all agree.
 *
 *   1. a finished label (done, closed, shipped, resolved, ...) → `completed`; cancelled / canceled → `canceled`
 *   2. the LAST option of an ordered workflow (`isLast`) → `completed`: the terminal state of a flow, as `isCompletedState` treated it
 *   3. backlog, triage, icebox, someday → `backlog`; in progress, in review, review, doing, started, active, wip → `started`
 *   4. anything else → `unstarted`
 *
 * `isLast` is only passed where an ORDERED list is being made or converted (a new workflow, a backfill); an option ADDED later is not the
 * terminal state just because it was appended, so it is inferred from its label alone.
 */
export function inferStateCategory(label: string, opts: { isLast?: boolean } = {}): StateCategory {
  const l = label.trim();
  if (CANCELED_LABEL.test(l)) return 'canceled';
  if (COMPLETED_LABEL.test(l)) return 'completed';
  if (opts.isLast) return 'completed';
  if (BACKLOG_LABEL.test(l)) return 'backlog';
  if (STARTED_LABEL.test(l)) return 'started';
  return 'unstarted';
}
