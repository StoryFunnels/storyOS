import { databaseNoun } from '@/lib/records';
import type { RunnerDto, WakeSummaryAgent } from './types';

/**
 * Ticket #1152 (web half) — the one-click catch-up for records that were already in an agent's trigger state before it could be
 * woken for them. Pure rules, so each has a test that fails when it is broken. The words live in `catch-up-copy.ts`.
 *
 * WHAT THE API TELLS US, and what it does not. `agent-wakes/summary` gives each agent a `catch_up` COUNT and `POST .../catch-up`
 * starts them; no endpoint says WHICH records are waiting. So nothing here names a record, and nothing counts rows fetched from a
 * page (ticket #404): the only quantity on screen is the server's own.
 */

/** The most wakes one click makes (`CATCH_UP_MAX_PER_CLICK`, apps/api/src/runners/agent-catch-up.service.ts). */
export const CATCH_UP_MAX_PER_CLICK = 25;

/**
 * The number behind the box, or null when the box must not show. `0` shows nothing (not "0 waiting"), `null` is the API saying
 * "not for this viewer" (anyone but the agent's owner or an admin, or an agent that cannot take wakes), and an absent field is a
 * server that does not know the answer. Anything that is not a positive whole number is treated as not told.
 */
export function catchUpCount(row: Pick<WakeSummaryAgent, 'catch_up'> | undefined): number | null {
  const n = row?.catch_up;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Whether the page draws the box. The API's own `null` already hides it from the wrong people; this adds the things the page
 * knows: the agent is one a Runner serves AND has one assigned (the box sits under "Runs on <machine>"), and the viewer may be
 * told the machine (a guest never is, so a guest never gets a box that names it).
 */
export function offersCatchUp(o: { usesRunner: boolean; hasRunner: boolean; mayLearnMachine: boolean; count: number | null }): boolean {
  return o.usesRunner && o.hasRunner && o.mayLearnMachine && o.count !== null;
}

/** How many a click will start now: the whole count up to the per-click cap. */
export function startsNow(count: number): number {
  return Math.min(count, CATCH_UP_MAX_PER_CLICK);
}

/** One row of the Agent Triggers database, as much of it as this file reads. */
export interface TriggerBindingLike {
  values: Record<string, unknown>;
}

export interface TriggerScope {
  databaseId: string;
  /** Set only when exactly one armed state binding explains the count. */
  state: { fieldId: string; optionId: string } | null;
}

/**
 * Which database (and, when one state binding says so, which state) the agent's armed bindings watch. An armed binding is one that
 * is enabled and not `human_gate`, exactly the rule the count uses (`AgentCatchUpService.plans`). With more than one database, or
 * no armed binding, the answer is `null`: the copy then says "record" and "its trigger state" rather than guess (a wrong noun is
 * worse than a plain one).
 */
export function triggerScope(bindings: readonly TriggerBindingLike[], agentId: string): TriggerScope | null {
  const armed = bindings.filter((b) => {
    if (b.values['enabled'] !== true || b.values['human_gate'] === true) return false;
    const ref = b.values['agent'];
    return Array.isArray(ref) && (ref[0] as { id?: string } | undefined)?.id === agentId && typeof b.values['database'] === 'string';
  });
  if (armed.length === 0) return null;
  const dbs = new Set(armed.map((b) => b.values['database'] as string));
  if (dbs.size !== 1) return null;
  const only = armed.length === 1 ? armed[0]!.values : null;
  const fieldId = only?.['state_field'];
  const optionId = only?.['state_option'];
  return {
    databaseId: [...dbs][0]!,
    state: typeof fieldId === 'string' && typeof optionId === 'string' ? { fieldId, optionId } : null,
  };
}

export interface ScopeWords {
  /** Singular, lower case: "client". "record" when the database has no usable name. */
  noun: string;
  /** "Onboarding" and the field it is a value of ("Status"); null when not known. */
  state: { field: string; label: string } | null;
}

export const GENERIC_SCOPE: ScopeWords = { noun: 'record', state: null };

interface DatabaseWordsLike {
  name?: string | null;
  fields?: ReadonlyArray<{ id: string; displayName?: string; options?: ReadonlyArray<{ id: string; label: string }> }>;
}

/** The words for a scope, from the trigger database's own detail. A deleted field or option is dropped, never shown as an id. */
export function scopeWords(scope: TriggerScope | null, db: DatabaseWordsLike | null | undefined): ScopeWords {
  if (!scope || !db) return GENERIC_SCOPE;
  const name = db.name?.trim();
  const noun = name ? databaseNoun(name) : 'record';
  let state: ScopeWords['state'] = null;
  if (scope.state) {
    const field = db.fields?.find((f) => f.id === scope.state!.fieldId);
    const option = field?.options?.find((o) => o.id === scope.state!.optionId);
    if (field && option && field.displayName) state = { field: field.displayName, label: option.label };
  }
  return { noun, state };
}

export interface RunsLineInput {
  /** What a click starts now (`startsNow`). */
  n: number;
  machine: string | null;
  tool: string | null;
  /** The subscription whose limit can run out ("Claude"); null when the tool is not known. */
  brand: string | null;
  /** The assigned Runner when the viewer can read it (its owner can; an admin on a colleague's agent cannot). */
  runner: Pick<RunnerDto, 'connection' | 'pause_reason' | 'paused_until'> | null;
  /** Formats `paused_until`; injected so a test can fix the zone. */
  clock: (iso: string) => string;
}

export type RunsLineKind = 'online' | 'offline' | 'limit' | 'attention';

/** What the Runner is doing about new work, from its own connection state; unknown (not readable) reads as online. */
export function runsLineKind(runner: RunsLineInput['runner']): RunsLineKind {
  if (!runner) return 'online';
  switch (runner.connection) {
    case 'offline':
      return 'offline';
    case 'paused':
      return runner.pause_reason === 'limit_reached' || !runner.pause_reason ? 'limit' : 'attention';
    case 'tool_missing':
    case 'outdated':
    case 'revoked':
      return 'attention';
    default:
      return 'online';
  }
}
