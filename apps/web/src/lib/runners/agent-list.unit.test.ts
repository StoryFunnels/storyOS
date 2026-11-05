import { describe, expect, it } from 'vitest';
import { agentCountLine, lastRunLabel, lastRunOf, managerLabel, runsOnCell, shortPersonName } from './agent-list';
import { everyOptions, runsNote, scheduleTrigger, zoneLabel } from './wake-rules';
import type { SchedRule } from './wake-rules';

/** Ticket #1196 — the list columns and the runs-a-day sentence. */
const UTC = { timeZone: 'UTC' };
const NOW = new Date('2026-11-05T14:00:00Z');
const w = (status: string, finished_at: string | null) => ({ status, finished_at }) as never;

describe('Last run', () => {
  it('is the newest FINISHED wake, whatever order the page came in', () => {
    const last = lastRunOf([w('queued', null), w('done', '2026-11-03T10:00:00Z'), w('failed', '2026-11-04T09:00:00Z'), w('done', '2026-11-01T10:00:00Z')], false);
    expect(last).toEqual({ kind: 'at', iso: '2026-11-04T09:00:00Z' });
  });
  it('a queued or cancelled wake did not run: with only those, and nothing older, it is Never', () => {
    expect(lastRunOf([w('queued', null), w('canceled', '2026-11-04T09:00:00Z')], false)).toEqual({ kind: 'never' });
    expect(lastRunOf([], false)).toEqual({ kind: 'never' });
  });
  it('"Never" about a page we did not fully read is a guess, so it is unknown ("—")', () => {
    expect(lastRunOf([w('queued', null)], true)).toEqual({ kind: 'unknown' });
    expect(lastRunOf(undefined, false)).toEqual({ kind: 'unknown' });
    expect(lastRunLabel({ kind: 'unknown' }, NOW, UTC)).toBe('—');
  });
  it('labels: Never; the clock time today; the date before', () => {
    expect(lastRunLabel({ kind: 'never' }, NOW, UTC)).toBe('Never');
    expect(lastRunLabel({ kind: 'at', iso: '2026-11-05T09:05:00Z' }, NOW, UTC)).toBe('09:05');
    expect(lastRunLabel({ kind: 'at', iso: '2026-10-29T09:05:00Z' }, NOW, UTC)).toBe('29 Oct');
  });
});

describe('Manager', () => {
  const members = [{ user: { id: 'u1', name: 'Ievgen Krasovytskyi' } }, { user: { id: 'u2', name: 'Madonna' } }];
  it('is the owner, shortened the way the design draws it', () => {
    expect(managerLabel({ ownerId: 'u1' }, members)).toBe('Ievgen K.');
    expect(managerLabel({ ownerId: 'u2' }, members)).toBe('Madonna');
    expect(shortPersonName('Anna Maria de la Cruz')).toBe('Anna C.');
  });
  it('an owner we cannot resolve, or members not loaded, is a dash, never a guess', () => {
    expect(managerLabel({ ownerId: 'nobody' }, members)).toBe('—');
    expect(managerLabel({ ownerId: 'u1' }, undefined)).toBe('—');
    expect(managerLabel({ ownerId: null }, members)).toBe('—');
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
