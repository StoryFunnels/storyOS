import { describe, expect, it } from 'vitest';
import { asksBeforePhrases } from './agents';
import { CATCH_UP_MAX_PER_CLICK, catchUpCount, GENERIC_SCOPE, offersCatchUp, runsLineKind, scopeWords, startsNow, triggerScope } from './catch-up';
import {
  boxBody,
  boxButton,
  boxTitle,
  CATCH_UP_FAILED,
  dialogAsks,
  dialogButton,
  dialogJob,
  dialogRunsLine,
  dialogTitle,
  readyToastWithScope,
  scopeRow,
  startedToast,
} from './catch-up-copy';
import { canSeeRunnerDetails } from './access';
import { reasonLine } from './status';
import type { ScopeWords } from './catch-up';

/** Ticket #1152 (web half). Each assertion is a rule that must keep failing when it is broken. */

const CLIENTS: ScopeWords = { noun: 'client', state: { field: 'Status', label: 'Onboarding' } };
const A = 'Onboarding Assistant';
const clock = (iso: string) => iso.slice(11, 16);
const online = { connection: 'online' as const, pause_reason: null, paused_until: null };

describe('who sees the box, and for what number', () => {
  it('only a positive count draws it: 0, null and an absent field draw nothing', () => {
    expect(catchUpCount({ catch_up: 4 })).toBe(4);
    expect(catchUpCount({ catch_up: 1 })).toBe(1);
    expect(catchUpCount({ catch_up: 0 })).toBeNull();
    expect(catchUpCount({ catch_up: null })).toBeNull();
    expect(catchUpCount({})).toBeNull();
    expect(catchUpCount(undefined)).toBeNull();
    // Not a quantity: never rendered as one.
    expect(catchUpCount({ catch_up: -2 })).toBeNull();
    expect(catchUpCount({ catch_up: 2.5 })).toBeNull();
    expect(catchUpCount({ catch_up: Number.NaN })).toBeNull();
  });
  it('needs a Runner assigned, an agent a Runner serves, and a viewer who may be told the machine', () => {
    const ok = { usesRunner: true, hasRunner: true, mayLearnMachine: true, count: 3 };
    expect(offersCatchUp(ok)).toBe(true);
    expect(offersCatchUp({ ...ok, count: null })).toBe(false);
    expect(offersCatchUp({ ...ok, hasRunner: false })).toBe(false);
    expect(offersCatchUp({ ...ok, usesRunner: false })).toBe(false);
    expect(offersCatchUp({ ...ok, mayLearnMachine: false })).toBe(false);
  });
  it('a guest is never told the machine, so the shared predicate hides the box from them', () => {
    expect(canSeeRunnerDetails('guest')).toBe(false);
    expect(canSeeRunnerDetails(undefined)).toBe(false);
    expect(canSeeRunnerDetails('member')).toBe(true);
  });
  it('a click starts at most 25 and the cap is the API’s', () => {
    expect(CATCH_UP_MAX_PER_CLICK).toBe(25);
    expect(startsNow(4)).toBe(4);
    expect(startsNow(25)).toBe(25);
    expect(startsNow(60)).toBe(25);
  });
});

describe('Dara’s box copy, singular and plural', () => {
  it('N = 1', () => {
    expect(boxTitle(1, CLIENTS)).toBe('1 client already waiting');
    expect(boxBody(1, A, CLIENTS)).toBe('It was in Onboarding before Onboarding Assistant could run, so it won’t wake it. New clients will.');
    expect(boxButton(1, CLIENTS)).toBe('Start on 1 waiting client');
  });
  it('N > 1', () => {
    expect(boxTitle(3, CLIENTS)).toBe('3 clients already waiting');
    expect(boxBody(3, A, CLIENTS)).toBe('They were in Onboarding before Onboarding Assistant could run, so they won’t wake it. New clients will.');
    expect(boxButton(3, CLIENTS)).toBe('Start on 3 waiting clients');
  });
  it('past one click’s worth, the box says how many it will start, never a number it will not', () => {
    expect(boxBody(60, A, CLIENTS)).toContain('It starts 25 at a time.');
    expect(boxBody(25, A, CLIENTS)).not.toContain('at a time');
    expect(boxButton(60, CLIENTS)).toBe('Start on the first 25 waiting clients');
    expect(boxButton(26, CLIENTS)).toBe('Start on the first 25 waiting clients');
    expect(boxButton(25, CLIENTS)).toBe('Start on 25 waiting clients');
  });
  it('a trigger that does not name its state, or a database with no name, says "record" and never an id', () => {
    expect(boxTitle(2, GENERIC_SCOPE)).toBe('2 records already waiting');
    expect(boxBody(2, A, GENERIC_SCOPE)).toBe('They were already in its trigger state before Onboarding Assistant could run, so they won’t wake it. New records will.');
    expect(boxButton(1, GENERIC_SCOPE)).toBe('Start on 1 waiting record');
  });
  it('the box never names a record: no endpoint says which', () => {
    for (const n of [1, 3, 60]) expect(boxBody(n, A, CLIENTS)).not.toMatch(/Acme|sample/);
  });
});

describe('the confirmation dialog', () => {
  it('title and buttons, N = 1 and N > 1', () => {
    expect(dialogTitle(1, A, CLIENTS)).toBe('Start Onboarding Assistant on 1 waiting client?');
    expect(dialogTitle(3, A, CLIENTS)).toBe('Start Onboarding Assistant on 3 waiting clients?');
    expect(dialogButton(1, CLIENTS)).toBe('Start on 1 client');
    expect(dialogButton(3, CLIENTS)).toBe('Start on 3 clients');
  });
  it('over 25 the title and the button name the first 25 of N', () => {
    expect(dialogTitle(60, A, CLIENTS)).toBe('Start Onboarding Assistant on the first 25 of 60 waiting clients?');
    expect(dialogButton(60, CLIENTS)).toBe('Start on 25 clients');
  });
  it('the one row that stands for the record list: how many, and the rule', () => {
    expect(scopeRow(3, CLIENTS)).toEqual({ left: '3 clients', right: 'Status is Onboarding' });
    expect(scopeRow(1, CLIENTS)).toEqual({ left: '1 client', right: 'Status is Onboarding' });
    expect(scopeRow(3, GENERIC_SCOPE)).toBeNull();
  });
  it('the job sentence uses the agent’s own job line, and without one makes no claim about the job', () => {
    expect(dialogJob(1, A, CLIENTS, 'Send a welcome packet.')).toBe('It does for this client what it does for every new client. Onboarding Assistant’s job: “Send a welcome packet.”');
    expect(dialogJob(3, A, CLIENTS, '  ')).toBe('It does for each one what it does for every new client.');
  });
  it('"asks before" comes from the gates, and an agent with none claims none', () => {
    expect(asksBeforePhrases(['email', 'outward'])).toEqual(['sending email', 'anything that leaves the workspace']);
    expect(dialogAsks(asksBeforePhrases(['email']))).toBe('It asks you before sending email.');
    expect(dialogAsks(asksBeforePhrases(['email', 'webhook', 'delete']))).toBe('It asks you before sending email, calling another service or deleting anything.');
    expect(dialogAsks([])).toBeNull();
  });
});

describe('the muted runs line', () => {
  const base = { machine: 'Ievgen’s MacBook Pro', tool: 'Claude Code', brand: 'Claude', clock };
  it('online, N = 1 and N > 1 (Dara’s sentences)', () => {
    expect(dialogRunsLine({ ...base, n: 1, runner: online })).toBe('1 run on Ievgen’s MacBook Pro with Claude Code.');
    expect(dialogRunsLine({ ...base, n: 3, runner: online })).toBe(
      '3 runs on Ievgen’s MacBook Pro with Claude Code, one at a time. If your Claude limit runs out, the rest wait for it to reset.',
    );
  });
  it('offline says when they will start', () => {
    const r = { connection: 'offline' as const, pause_reason: null, paused_until: null };
    expect(dialogRunsLine({ ...base, n: 1, runner: r })).toBe('1 run on Ievgen’s MacBook Pro with Claude Code. Your Runner is offline: it starts when it’s back.');
    expect(dialogRunsLine({ ...base, n: 3, runner: r })).toBe(
      '3 runs on Ievgen’s MacBook Pro with Claude Code, one at a time. Your Runner is offline: they start when it’s back.',
    );
  });
  it('at its limit says when the limit resets, in the right brand', () => {
    const r = { connection: 'paused' as const, pause_reason: 'limit_reached', paused_until: '2026-11-05T14:00:00Z' };
    expect(dialogRunsLine({ ...base, n: 3, runner: r })).toBe(
      '3 runs on Ievgen’s MacBook Pro with Claude Code, one at a time. Your Claude limit is reached: they start when it resets at 14:00.',
    );
    expect(dialogRunsLine({ ...base, brand: 'Cursor', tool: 'Cursor', n: 1, runner: r })).toContain('Your Cursor limit is reached: it starts when it resets at 14:00.');
    // No reset time known: the sentence does not invent one.
    expect(dialogRunsLine({ ...base, n: 1, runner: { ...r, paused_until: null } })).toMatch(/when it resets\.$/);
  });
  it('a count above the cap says 25 runs, not 60', () => {
    expect(dialogRunsLine({ ...base, n: startsNow(60), runner: online })).toMatch(/^25 runs on/);
  });
  it('a Runner the viewer cannot read (an admin on a colleague’s agent) names the machine and no tool or limit', () => {
    expect(dialogRunsLine({ machine: 'Ievgen’s MacBook Pro', tool: null, brand: null, runner: null, clock, n: 3 })).toBe('3 runs on Ievgen’s MacBook Pro, one at a time.');
  });
  it('a Runner that needs attention says so rather than "online"', () => {
    expect(runsLineKind({ connection: 'tool_missing', pause_reason: null, paused_until: null })).toBe('attention');
    expect(runsLineKind({ connection: 'paused', pause_reason: 'quiet_hours', paused_until: null })).toBe('attention');
    expect(runsLineKind(null)).toBe('online');
  });
});

describe('what happens after the click', () => {
  it('the toast says how many started and, past the cap, how many remain', () => {
    expect(startedToast(A, { queued: 4, already_waiting: 0, remaining: 0 }, CLIENTS)).toBe('Onboarding Assistant is starting on 4 clients.');
    expect(startedToast(A, { queued: 1, already_waiting: 0, remaining: 0 }, CLIENTS)).toBe('Onboarding Assistant is starting on 1 client.');
    expect(startedToast(A, { queued: 25, already_waiting: 0, remaining: 35 }, CLIENTS)).toBe('Onboarding Assistant is starting on 25 clients. 35 more remain.');
  });
  it('a second click that queues nothing says the records are already waiting, not that it started', () => {
    const t = startedToast(A, { queued: 0, already_waiting: 4, remaining: 0 }, CLIENTS);
    expect(t).toBe('Nothing new to start: 4 clients already waiting for Onboarding Assistant.');
    expect(t).not.toMatch(/is starting/);
    expect(startedToast(A, { queued: 0, already_waiting: 0, remaining: 0 }, CLIENTS)).toMatch(/^Nothing to start/);
  });
  it('a refusal is shown as the API’s own sentence, with a fallback in words', () => {
    expect(CATCH_UP_FAILED).toBe('Could not start the waiting records. Try again.');
  });
  it('the wake it makes is described, not shown as a raw slug', () => {
    expect(reasonLine({ reason: 'catch_up', coalesced_count: 1 })).toBe('Started on a record that was already waiting');
  });
});

describe('the Done toast (Dara, v45)', () => {
  it('names the state when the trigger does', () => {
    expect(readyToastWithScope('Ievgen’s MacBook Pro', A, CLIENTS)).toBe('Ievgen’s MacBook Pro is ready. New clients in Onboarding now wake Onboarding Assistant.');
  });
  it('is null when the state is not known, so the general sentence stands', () => {
    expect(readyToastWithScope('M', A, GENERIC_SCOPE)).toBeNull();
  });
});

describe('the words come from the agent’s own armed triggers', () => {
  const binding = (over: Record<string, unknown>) => ({
    values: { enabled: true, human_gate: false, agent: [{ id: 'ag1' }], database: 'db1', state_field: 'f1', state_option: 'o1', ...over },
  });
  const db = {
    name: 'Clients',
    fields: [{ id: 'f1', displayName: 'Status', options: [{ id: 'o1', label: 'Onboarding' }] }],
  };
  it('one state binding gives the noun and the state', () => {
    const scope = triggerScope([binding({})], 'ag1');
    expect(scope).toEqual({ databaseId: 'db1', state: { fieldId: 'f1', optionId: 'o1' } });
    expect(scopeWords(scope, db)).toEqual(CLIENTS);
  });
  it('another agent’s binding, a disabled one and a human-gate one are not this agent’s armed triggers', () => {
    expect(triggerScope([binding({ agent: [{ id: 'other' }] })], 'ag1')).toBeNull();
    expect(triggerScope([binding({ enabled: false })], 'ag1')).toBeNull();
    expect(triggerScope([binding({ human_gate: true })], 'ag1')).toBeNull();
  });
  it('two databases cannot be worded as one: plain words', () => {
    expect(triggerScope([binding({}), binding({ database: 'db2' })], 'ag1')).toBeNull();
  });
  it('two bindings on one database give the noun but not a single state', () => {
    const scope = triggerScope([binding({}), binding({ state_option: 'o2' })], 'ag1');
    expect(scope).toEqual({ databaseId: 'db1', state: null });
    expect(scopeWords(scope, db)).toEqual({ noun: 'client', state: null });
  });
  it('a relation binding names the database but no state', () => {
    const scope = triggerScope([binding({ state_field: undefined, state_option: undefined, relation_field: 'rel1' })], 'ag1');
    expect(scope).toEqual({ databaseId: 'db1', state: null });
  });
  it('a deleted option or field is dropped, never shown as an id; no database name is "record"', () => {
    const scope = triggerScope([binding({})], 'ag1');
    expect(scopeWords(scope, { ...db, fields: [{ id: 'f1', displayName: 'Status', options: [] }] }).state).toBeNull();
    expect(scopeWords(scope, { ...db, fields: [] }).state).toBeNull();
    expect(scopeWords(scope, { name: '  ', fields: db.fields }).noun).toBe('record');
    expect(scopeWords(null, db)).toEqual(GENERIC_SCOPE);
    expect(scopeWords(scope, undefined)).toEqual(GENERIC_SCOPE);
  });
});
