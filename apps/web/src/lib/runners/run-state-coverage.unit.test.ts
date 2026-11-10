import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeRun } from './status';
import { RUN_STATE_NAMES } from './types';
import type { RunStateName, WakeDto } from './types';

/**
 * Ticket #1248. `waiting_for_budget` shipped in the API, the SDK and the MCP tools and fell through describeRun, because the
 * web kept its own hand-typed list of run states. This pins the web list to the two places the API states its own, and walks
 * every one through describeRun.
 */
const root = resolve(__dirname, '../../../../..');

/** The names the API's `RunStateName` union lists, read from the source of truth rather than retyped here. */
function apiStates(): string[] {
  // Comments inside the union carry `;` and apostrophes, so they go first.
  const src = readFileSync(resolve(root, 'apps/api/src/runners/run-state.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const union = /export type RunStateName =([^;]*);/.exec(src)?.[1] ?? '';
  return [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The names the generated SDK schema lists in the agent-wakes description. */
function sdkStates(): string[] {
  const src = readFileSync(resolve(root, 'packages/sdk/src/generated/schema.ts'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('ONE derived run_state per row')) ?? '';
  const list = /run_state per row \(([^)]*(?:\([^)]*\)[^)]*)*)\)\. Filter by/.exec(line)?.[1] ?? '';
  return [...list.replace(/\([^)]*\)/g, '').matchAll(/\b([a-z]+(?:_[a-z]+)+|running|done|failed|canceled)\b/g)].map((m) => m[1]!);
}

const wake = (state: RunStateName): WakeDto => ({
  id: 'w1',
  agent: { id: 'a1', name: 'Agent' },
  record: null,
  reason: 'manual',
  coalesced_count: 1,
  status: 'queued',
  run_id: null,
  run_state: { state },
  created_at: '2026-11-10T09:00:00Z',
  finished_at: null,
});

describe('every run state the API can emit has a describeRun case (ticket #1248)', () => {
  it('the web list equals the API union and the SDK description, as sets', () => {
    const web = [...RUN_STATE_NAMES].sort();
    expect(apiStates().length).toBeGreaterThanOrEqual(12);
    expect(sdkStates().length).toBeGreaterThanOrEqual(12);
    expect(web).toEqual([...apiStates()].sort());
    expect(web).toEqual([...sdkStates()].sort());
  });

  it.each([...RUN_STATE_NAMES])('%s renders real copy, not a fall-through', (state) => {
    const line = describeRun(wake(state), { timeZone: 'UTC' });
    expect(line?.label).toEqual(expect.any(String));
    expect(line.label.length).toBeGreaterThan(0);
    expect(line.tone).toBeTruthy();
  });

  it('a budget-paused wake names the budget and the reset, and invents no figure', () => {
    const w = wake('waiting_for_budget');
    w.run_state = { state: 'waiting_for_budget', until: '2026-12-01T00:00:00Z', budget_metric: 'tokens' };
    const line = describeRun(w, { timeZone: 'UTC', now: new Date('2026-11-10T09:00:00Z') });
    expect(line.tone).toBe('off');
    expect(line.label).toMatch(/^Monthly token budget reached, resumes /);
    expect(`${line.label} ${line.sub}`).not.toMatch(/\d+\s*(tokens|runs)/);
    // No reset time and no metric known: says so by saying less, never a guess.
    const bare = describeRun(wake('waiting_for_budget'), { timeZone: 'UTC' });
    expect(bare.label).toBe('Monthly budget reached');
  });
});
