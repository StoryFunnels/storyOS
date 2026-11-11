import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentCountLine, isRanState, lastRunLabel, lastRunState, lastRunTitle, lastRunsByAgent, managerLabel, needsDirectory, runsOnCell, shortPersonName } from './agent-list';
import { RUN_STATE_NAMES } from './types';
import { everyOptions, runsNote, scheduleTrigger, zoneLabel } from './wake-rules';
import type { SchedRule } from './wake-rules';

/** Ticket #1196 — the list columns and the runs-a-day sentence. */
const UTC = { timeZone: 'UTC' };
const NOW = new Date('2026-11-05T14:00:00Z');

describe('Last run', () => {
  const wake = (agent: string, state: string, finished_at: string | null, created_at = '2026-11-01T00:00:00Z', since?: string) =>
    ({ agent: { id: agent }, run_state: { state, ...(since ? { since } : {}) }, finished_at, created_at }) as never;
  /** What the Runs database told us: exact counts per agent, and the newest Run records by start time. */
  const runs = (counts: Record<string, number>, latest: Array<[string, string]> = []) => ({ counts, latest: latest.map(([agentId, started]) => ({ agentId, started })) });

  it('the time is the newest Run record of the agent (Run records are not pruned, wakes are after 30 days)', () => {
    const r = lastRunsByAgent(['a', 'b'], [], runs({ a: 3, b: 1 }, [['a', '2026-11-04T08:00:00Z'], ['b', '2026-11-03T10:00:00Z'], ['a', '2025-10-01T10:00:00Z']]));
    expect(r['a']).toEqual({ kind: 'at', iso: '2026-11-04T08:00:00Z', state: 'done' });
    expect(r['b']).toEqual({ kind: 'at', iso: '2026-11-03T10:00:00Z', state: 'done' });
  });
  it('PRUNED wakes: an agent that ran long ago and has no wake any more still shows its real time, not "Never"', () => {
    const r = lastRunsByAgent(['old'], [], runs({ old: 2 }, [['old', '2025-10-02T09:00:00Z']]));
    expect(r['old']).toEqual({ kind: 'at', iso: '2025-10-02T09:00:00Z', state: 'done' });
    expect(lastRunLabel(r['old']!, NOW, UTC)).toBe('2 Oct 2025'); // the year label now rests on real data
  });
  it('an agent that HAS Run records but none in the newest page ran at an unknown time: "—", never "Never"', () => {
    const r = lastRunsByAgent(['a'], [], runs({ a: 4 }, [['someone-else', '2026-11-04T08:00:00Z']]));
    expect(r['a']).toEqual({ kind: 'ranUnknown' });
    expect(lastRunLabel(r['a']!, NOW, UTC)).toBe('—');
  });
  it('"Never" appears ONLY when it is known: the Runs database was read AND has no Run record for the agent AND no wake shows a run', () => {
    expect(lastRunsByAgent(['a'], [], runs({}))['a']).toEqual({ kind: 'never' });
    expect(lastRunsByAgent(['a'], [wake('a', 'waiting_for_runner', null), wake('a', 'canceled', '2026-11-04T09:00:00Z')], runs({}))['a']).toEqual({ kind: 'never' });
    // the same agent, but a wake shows a run the Run read did not: it ran
    expect(lastRunsByAgent(['a'], [wake('a', 'done', '2026-11-04T09:00:00Z')], runs({}))['a']).toMatchObject({ kind: 'at' });
  });
  it('GUEST / not readable / not loaded: the Runs database could not be read, so nothing is known: "—", whatever the wake queue lacks', () => {
    const r = lastRunsByAgent(['a', 'b'], [wake('b', 'done', '2026-11-04T09:00:00Z')], undefined);
    expect(r['a']).toEqual({ kind: 'unknown' });
    expect(r['b']).toMatchObject({ kind: 'at' }); // what IS visible is still shown
    expect(lastRunsByAgent(['a'], undefined, undefined)['a']).toEqual({ kind: 'unknown' });
    expect(lastRunLabel({ kind: 'unknown' }, NOW, UTC)).toBe('—');
  });
  it('a run waiting for approval or for the limit SHOWS, with its state, and its time wins when newer than the last started run', () => {
    const r = lastRunsByAgent(
      ['a', 'b', 'c'],
      [wake('a', 'needs_approval', null, '2026-11-04T10:00:00Z', '2026-11-04T10:05:00Z'), wake('b', 'waiting_for_limit', null, '2026-11-04T11:00:00Z'), wake('c', 'running', null, '2026-11-04T12:00:00Z')],
      runs({ a: 1, b: 1, c: 1 }, [['a', '2026-11-04T09:00:00Z'], ['b', '2026-11-04T09:00:00Z'], ['c', '2026-11-04T09:00:00Z']]),
    );
    expect(r['a']).toEqual({ kind: 'at', iso: '2026-11-04T10:05:00Z', state: 'needs_approval' });
    expect(lastRunState(r['a']!)).toBe('Needs approval');
    expect(lastRunState(r['b']!)).toBe('Waiting for limit');
    expect(lastRunState(r['c']!)).toBe('Running');
    expect(lastRunState({ kind: 'at', iso: 'x', state: 'done' })).toBe('');
    // an OLDER wake never overrides a newer started run
    const old = lastRunsByAgent(['a'], [wake('a', 'failed', '2026-11-01T09:00:00Z')], runs({ a: 2 }, [['a', '2026-11-04T09:00:00Z']]));
    expect(old['a']).toEqual({ kind: 'at', iso: '2026-11-04T09:00:00Z', state: 'done' });
  });
  it('60 agents are answered from the same reads (nothing in the answer depends on how many there are)', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `a${i}`);
    const counts = Object.fromEntries(ids.filter((_, i) => i % 3 !== 0).map((id) => [id, 1]));
    const latest: Array<[string, string]> = ids.filter((_, i) => i % 3 === 1).map((id) => [id, '2026-11-04T09:00:00Z']);
    const r = lastRunsByAgent(ids, [], runs(counts, latest));
    expect(ids.filter((id) => r[id]!.kind === 'never')).toHaveLength(20);
    expect(ids.filter((id) => r[id]!.kind === 'at')).toHaveLength(20);
    expect(ids.filter((id) => r[id]!.kind === 'ranUnknown')).toHaveLength(20);
  });
  it('labels: Never; the clock time today; the date this year; the date AND YEAR in another year; a dash when unknown', () => {
    expect(lastRunLabel({ kind: 'never' }, NOW, UTC)).toBe('Never');
    expect(lastRunLabel({ kind: 'at', iso: '2026-11-05T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('09:05');
    expect(lastRunLabel({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('29 Oct');
    expect(lastRunLabel({ kind: 'at', iso: '2025-10-29T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('29 Oct 2025');
    expect(lastRunLabel({ kind: 'ranUnknown' }, NOW, UTC)).toBe('—');
  });
  it('the tooltip is the full date and time in the given zone, with the state when it is not done, and says why a dash is a dash', () => {
    expect(lastRunTitle({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'done' }, UTC)).toBe('29 Oct 2026, 09:05');
    expect(lastRunTitle({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'needs_approval' }, { timeZone: 'Europe/Madrid' })).toBe('Needs approval · 29 Oct 2026, 10:05');
    expect(lastRunTitle({ kind: 'never' }, UTC)).toBeUndefined();
    expect(lastRunTitle({ kind: 'unknown' }, UTC)).toMatch(/cannot read/);
    expect(lastRunTitle({ kind: 'ranUnknown' }, UTC)).toMatch(/has run/);
  });
  it('the number of requests does not depend on the number of agents: three fixed reads, no per-agent query, and the page passes no ids', () => {
    const q = readFileSync(fileURLToPath(new URL('./queries.ts', import.meta.url)), 'utf8');
    const body = q.slice(q.indexOf('export function useLastRuns'), q.indexOf('export function useMembersDirectory'));
    expect(body).not.toMatch(/useQueries|\.map\(/);
    expect(body.match(/api\.(GET|POST)\(/g)).toHaveLength(3);
    expect(body).not.toMatch(/agentIds|agent:/);
    // newest first, and "never" needs BOTH Runs reads (half an answer is not enough)
    expect(body).toContain("direction: 'desc'");
    expect(body).toContain('counts.data && latest.data');
    expect(body.match(/refetchInterval: 30_000/g)).toHaveLength(3);
    const page = readFileSync(fileURLToPath(new URL('../../app/w/[ws]/agents/page.tsx', import.meta.url)), 'utf8');
    expect(page).toContain('useLastRuns(ws)');
    expect(page).not.toMatch(/useLastRuns\(ws, /);
  });
});

describe('Manager', () => {
  const members = [{ user: { id: 'u1', name: 'Ievgen Krasovytskyi' } }, { user: { id: 'u2', name: 'Madonna' } }];
  it('is the owner, shortened the way the design draws it', () => {
    expect(managerLabel({ ownerId: 'u1' }, members)).toBe('Ievgen K.');
    expect(managerLabel({ ownerId: 'u2' }, members)).toBe('Madonna');
    expect(shortPersonName('Anna Maria de la Cruz')).toBe('Anna C.');
  });
  it('a DEPARTED owner resolves to their tombstoned Members row, with a left marker (ADR-0017: removal tombstones, never deletes)', () => {
    const directory = [{ title: 'Olga Petrova', values: { user_id: 'u9', active: false } }, { title: 'Maria Member', values: { user_id: 'u3', active: true } }];
    expect(managerLabel({ ownerId: 'u9' }, members, directory)).toBe('Olga P. (left)');
    expect(managerLabel({ ownerId: 'u3' }, members, directory)).toBe('Maria M.'); // active, just not in the people list yet
    expect(managerLabel({ ownerId: 'u1' }, members, directory)).toBe('Ievgen K.'); // the people list wins
  });
  it('an owner found nowhere, or nothing loaded, is a dash, never a guess', () => {
    expect(managerLabel({ ownerId: 'nobody' }, members, [])).toBe('—');
    expect(managerLabel({ ownerId: 'u1' }, undefined)).toBe('—');
    expect(managerLabel({ ownerId: null }, members)).toBe('—');
  });
  it('the Members directory is read only when an owner is missing from the people list', () => {
    expect(needsDirectory([{ ownerId: 'u1' }, { ownerId: 'u2' }], members)).toBe(false);
    expect(needsDirectory([{ ownerId: 'u1' }, { ownerId: 'u9' }], members)).toBe(true);
    expect(needsDirectory([{ ownerId: 'u9' }], undefined)).toBe(false); // people not loaded yet: not yet, not "missing"
    expect(needsDirectory([{ ownerId: null }], members)).toBe(false);
  });
});

describe('Runs on', () => {
  const base = { usesRunner: true, enabled: true, aiMode: 'Your own AI' as const };
  it('names the machine, or says No Runner yet', () => {
    expect(runsOnCell(base, { name: 'MacBook' }, true)).toBe('MacBook');
    expect(runsOnCell(base, null, true)).toBe('No Runner yet');
  });
  it('a guest is never told the machine', () => expect(runsOnCell(base, { name: 'MacBook' }, false)).toBe('A Runner'));
  it('an agent that does not use a Runner says what it uses', () => {
    expect(runsOnCell({ usesRunner: false, enabled: false, aiMode: null }, null, true)).toBe('Switched off');
    expect(runsOnCell({ usesRunner: false, enabled: true, aiMode: 'StoryOS AI' }, null, true)).toBe('StoryOS AI');
    expect(runsOnCell({ usesRunner: false, enabled: true, aiMode: 'Non-AI' }, null, true)).toBe('Without an AI');
  });
});

describe('counts and the runs-a-day sentence', () => {
  it('singular and plural', () => {
    expect(agentCountLine(1)).toMatch(/^1 agent\./);
    expect(agentCountLine(3)).toMatch(/^3 agents\./);
  });
  const s = (over: Partial<SchedRule>): SchedRule => ({ kind: 'sched', every: 'hour', at: '09:00', weekday: 1, window: false, ...over });
  it('the figure is the API’s own arithmetic, matching the design (144, 54 in a 9-18 window, 24)', () => {
    expect(runsNote(s({ every: '10min' }), 'Europe/Madrid')).toBe('About 144 runs a day. Each run uses some of your Claude limit.');
    expect(runsNote(s({ every: '10min', window: true }), 'Europe/Madrid')).toBe('About 54 runs a day. Each run uses some of your Claude limit.');
    expect(runsNote(s({ every: 'hour' }), 'Europe/Madrid')).toContain('About 24 runs a day');
    expect(runsNote(s({ every: 'day' }), 'Europe/Madrid')).toContain('1 run a day.');
    expect(runsNote(s({ every: 'weekday' }), 'Europe/Madrid')).toContain('5 runs a week.');
    expect(runsNote(s({ every: 'week' }), 'Europe/Madrid')).toContain('1 run a week.');
  });
  it('every offered schedule has a figure in its note', () => {
    for (const o of everyOptions()) expect(runsNote(s({ every: o.value }), 'UTC'), o.value).toMatch(/runs? a (day|week)\./);
  });
  it('the zone is named as the card prints it', () => {
    expect(zoneLabel('Europe/Madrid', new Date('2026-01-15T12:00:00Z'))).toBe('Europe/Madrid (UTC+1)');
    expect(zoneLabel('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe('America/New York (UTC−4)');
    expect(zoneLabel('UTC', NOW)).toBe('UTC (UTC)');
    expect(scheduleTrigger(s({ every: 'day' }), 'America/New_York')).toMatchObject({ timezone: 'America/New_York' });
  });
});

describe('Last run knows every run state the API can emit', () => {
  const wake = (state: string) => ({ agent: { id: 'a' }, run_state: { state }, finished_at: null, created_at: '2026-11-01T00:00:00Z' }) as never;
  const NOT_A_RUN = ['canceled', 'waiting_for_runner', 'runner_offline', 'waiting_for_turn'];

  it.each([...RUN_STATE_NAMES])('%s has a decided place in the column', (state) => {
    const r = lastRunsByAgent(['a'], [wake(state)], { counts: {}, latest: [] })['a']!;
    if (NOT_A_RUN.includes(state)) {
      expect(isRanState(state)).toBe(false);
      expect(r).toEqual({ kind: 'never' });
    } else {
      expect(isRanState(state)).toBe(true);
      expect(r).toMatchObject({ kind: 'at', state });
      // every state that ran and is not simply done says so in words
      expect(lastRunState(r) === '').toBe(state === 'done');
    }
  });
  it('a budget-paused run shows as a run, with words and no invented figure', () => {
    const r = lastRunsByAgent(['a'], [wake('waiting_for_budget')], { counts: {}, latest: [] })['a']!;
    expect(lastRunState(r)).toBe('Budget reached');
    expect(lastRunState(r)).not.toMatch(/\d/);
  });
  it('a state this build does not know is not claimed as a run', () => {
    expect(isRanState('waiting_for_something_new')).toBe(false);
    expect(lastRunState({ kind: 'at', iso: 'x', state: 'waiting_for_something_new' })).toBe('');
  });
});
