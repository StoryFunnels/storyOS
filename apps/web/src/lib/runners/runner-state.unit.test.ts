import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RunnerUnknownLine } from '@/components/runners/runner-unknown-line';
import { runsOnCell } from './agent-list';
import { queuedRunsLine, recordsWaitingCount, recordsWaitingLine, RUNNER_LOAD_FAILED, runnerLineState } from './runner-state';
import type { WakeSummary } from './types';

/** Ticket #1223 — the agent page states only the facts it has. */
const RUNNER = { id: 'r1', name: 'Ievgen’s MacBook Pro' };
/** A fixture agent that HAS a Runner, and one that has none, both as the summary names them. */
const summary = (over: Partial<WakeSummary['agents'][number]> = {}): WakeSummary => ({
  agents: [
    { agent_id: 'has-runner', name: 'Has one', runner: RUNNER, can_run: true, waiting: 2, catch_up: 0 },
    { agent_id: 'no-runner', name: 'Has none', runner: null, can_run: false, waiting: 1, catch_up: 4, ...over },
  ],
  waiting_total: 3,
  agents_that_cannot_run: 1,
});

describe('the Runner line state', () => {
  it('LOADING for an agent that has a Runner is never "none"', () => {
    expect(runnerLineState({ data: undefined, isError: false }, 'has-runner')).toEqual({ kind: 'loading' });
  });
  it('FAILED for an agent that has a Runner is never "none"', () => {
    expect(runnerLineState({ data: undefined, isError: true }, 'has-runner')).toEqual({ kind: 'failed' });
  });
  it('loaded: a Runner is the line, no Runner is "none"', () => {
    expect(runnerLineState({ data: summary(), isError: false }, 'has-runner')).toEqual({ kind: 'assigned', runner: RUNNER });
    expect(runnerLineState({ data: summary(), isError: false }, 'no-runner')).toEqual({ kind: 'none' });
  });
  it('a summary already held survives a failed background refresh (stale-but-true beats an error)', () => {
    expect(runnerLineState({ data: summary(), isError: true }, 'has-runner').kind).toBe('assigned');
  });
});

describe('what the unknown states render', () => {
  const html = (failed: boolean) => renderToStaticMarkup(createElement(RunnerUnknownLine, { failed, onRetry: () => {} }));
  it('loading says nothing (a skeleton), never "No Runner yet"', () => {
    const out = html(false);
    expect(out).toContain('data-testid="runs-on-loading"');
    expect(out).not.toMatch(/No Runner yet|Runs on/);
  });
  it('failed says it could not load, offers Retry, never "No Runner yet"', () => {
    const out = html(true);
    expect(out).toContain("Couldn&#x27;t load this agent&#x27;s Runner. Try again.");
    expect(RUNNER_LOAD_FAILED).toBe("Couldn't load this agent's Runner. Try again.");
    expect(out).toContain('Retry');
    expect(out).not.toMatch(/No Runner yet/);
  });
});

describe('the agents list does not say "No Runner yet" before it knows', () => {
  const agent = { usesRunner: true, enabled: true, aiMode: 'Your own AI' } as never;
  it('unknown → a dash, known and none → "No Runner yet", known with one → its name', () => {
    expect(runsOnCell(agent, undefined, true, false)).toBe('—');
    expect(runsOnCell(agent, null, true, true)).toBe('No Runner yet');
    expect(runsOnCell(agent, { name: 'Mac' }, true, false)).toBe('Mac');
  });
});

describe('records waiting on the no-Runner page', () => {
  it('is the summary\'s catch_up (4 when 4), not the queued wakes (1)', () => {
    const row = summary().agents[1];
    expect(row?.waiting).toBe(1);
    expect(recordsWaitingCount(row)).toBe(4);
    expect(recordsWaitingLine(4)).toBe('4 records are waiting for it');
    expect(recordsWaitingLine(1)).toBe('1 record is waiting for it');
  });
  it('null (not told), absent (older server), 0 and no row all print nothing', () => {
    expect(recordsWaitingCount({ catch_up: null })).toBeNull();
    expect(recordsWaitingCount({})).toBeNull();
    expect(recordsWaitingCount({ catch_up: 0 })).toBeNull();
    expect(recordsWaitingCount(undefined)).toBeNull();
  });
  it('queued wakes are worded as runs, never as records', () => {
    expect(queuedRunsLine(1)).toBe('1 run is queued for it');
    expect(queuedRunsLine(3)).toBe('3 runs are queued for it');
    expect(queuedRunsLine(3)).not.toMatch(/record/);
  });
});

describe('the page is wired to the model (source guard)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../components/runners/agent-page.tsx', import.meta.url)), 'utf8');
  it('derives the Runner from the state, shows the unknown line, and feeds the records line from catch_up only', () => {
    expect(src).toContain('runnerLineState(summary, agent.id)');
    expect(src).toContain('<RunnerUnknownLine');
    expect(src).toContain("runnerState.kind === 'none'");
    expect(src).toContain('recordsWaiting={recordsWaitingCount(row)}');
    expect(src).not.toMatch(/row\?\.runner \?\? null/);
  });
});
