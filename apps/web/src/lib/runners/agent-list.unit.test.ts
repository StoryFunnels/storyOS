import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentCountLine, lastRunLabel, lastRunState, lastRunTitle, lastRunsByAgent, managerLabel, needsDirectory, runsOnCell, shortPersonName } from './agent-list';
import { everyOptions, runsNote, scheduleTrigger, zoneLabel } from './wake-rules';
import type { SchedRule } from './wake-rules';

/** Ticket #1196 — the list columns and the runs-a-day sentence. */
const UTC = { timeZone: 'UTC' };
const NOW = new Date('2026-11-05T14:00:00Z');

describe('Last run', () => {
  const wake = (agent: string, state: string, finished_at: string | null, created_at = '2026-11-01T00:00:00Z', since?: string) =>
    ({ agent: { id: agent }, run_state: { state, ...(since ? { since } : {}) }, finished_at, created_at }) as never;
  it('is the newest run per agent, from ONE page, whatever the order', () => {
    const r = lastRunsByAgent(['a', 'b'], [wake('a', 'done', '2026-11-03T10:00:00Z'), wake('b', 'failed', '2026-11-04T09:00:00Z'), wake('a', 'done', '2026-11-04T08:00:00Z'), wake('a', 'done', '2026-11-01T10:00:00Z')], false);
    expect(r['a']).toEqual({ kind: 'at', iso: '2026-11-04T08:00:00Z', state: 'done' });
    expect(r['b']).toMatchObject({ kind: 'at', state: 'failed' });
  });
  it('a run waiting for approval or for the limit SHOWS, with its state (it is not only finished runs)', () => {
    const r = lastRunsByAgent(['a', 'b', 'c'], [wake('a', 'needs_approval', null, '2026-11-04T10:00:00Z', '2026-11-04T10:05:00Z'), wake('b', 'waiting_for_limit', null, '2026-11-04T11:00:00Z'), wake('c', 'running', null, '2026-11-04T12:00:00Z')], false);
    expect(r['a']).toEqual({ kind: 'at', iso: '2026-11-04T10:05:00Z', state: 'needs_approval' });
    expect(lastRunState(r['a']!)).toBe('Needs approval');
    expect(lastRunState(r['b']!)).toBe('Waiting for limit');
    expect(lastRunState(r['c']!)).toBe('Running');
    expect(lastRunState({ kind: 'at', iso: 'x', state: 'done' })).toBe('');
  });
  it('a wake that has not run (waiting for a Runner, cancelled) is not a run: with nothing else and nothing older, Never', () => {
    const r = lastRunsByAgent(['a'], [wake('a', 'waiting_for_runner', null), wake('a', 'canceled', '2026-11-04T09:00:00Z'), wake('a', 'runner_offline', null)], false);
    expect(r['a']).toEqual({ kind: 'never' });
  });
  it('"Never" about a page we did not fully read is a guess, so it is unknown ("—")', () => {
    expect(lastRunsByAgent(['a'], [wake('a', 'waiting_for_runner', null)], true)['a']).toEqual({ kind: 'unknown' });
    expect(lastRunsByAgent(['a'], undefined, false)['a']).toEqual({ kind: 'unknown' });
    expect(lastRunLabel({ kind: 'unknown' }, NOW, UTC)).toBe('—');
  });
  it('60 agents are answered from the same ONE page (the count of requests does not depend on the count of agents)', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `a${i}`);
    const page = ids.filter((_, i) => i % 2 === 0).map((id) => wake(id, 'done', '2026-11-04T09:00:00Z'));
    const r = lastRunsByAgent(ids, page, false);
    expect(Object.keys(r)).toHaveLength(60);
    expect(ids.filter((id) => r[id]!.kind === 'at')).toHaveLength(30);
    expect(ids.filter((id) => r[id]!.kind === 'never')).toHaveLength(30);
  });
  it('labels: Never; the clock time today; the date this year; the date AND YEAR in another year', () => {
    expect(lastRunLabel({ kind: 'never' }, NOW, UTC)).toBe('Never');
    expect(lastRunLabel({ kind: 'at', iso: '2026-11-05T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('09:05');
    expect(lastRunLabel({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('29 Oct');
    expect(lastRunLabel({ kind: 'at', iso: '2025-10-29T09:05:00Z', state: 'done' }, NOW, UTC)).toBe('29 Oct 2025');
  });
  it('the tooltip is the full date and time in the given zone, with the state when it is not done', () => {
    expect(lastRunTitle({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'done' }, UTC)).toBe('29 Oct 2026, 09:05');
    expect(lastRunTitle({ kind: 'at', iso: '2026-10-29T09:05:00Z', state: 'needs_approval' }, { timeZone: 'Europe/Madrid' })).toBe('Needs approval · 29 Oct 2026, 10:05');
    expect(lastRunTitle({ kind: 'never' }, UTC)).toBeUndefined();
  });
  it('the page issues ONE Last-run request and one list of agents: no per-agent query hook', () => {
    const q = readFileSync(fileURLToPath(new URL('./queries.ts', import.meta.url)), 'utf8');
    const body = q.slice(q.indexOf('export function useLastRuns'), q.indexOf('export function useMembersDirectory'));
    expect(body).not.toMatch(/useQueries|\.map\(/);
    expect(body.match(/api\.GET\(/g)).toHaveLength(1);
    expect(body).toMatch(/refetchInterval: 30_000/);
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
