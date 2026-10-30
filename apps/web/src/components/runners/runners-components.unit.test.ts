import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { canHireAgents, canSeeRunnerDetails } from '@/lib/runners/access';
import type { RunnerDto, RunStateName, WakeDto } from '@/lib/runners/types';
import { FirstRunCard, namesLine } from './first-run-card';
import { RunList } from './run-list';
import { RunnerRow } from './runner-row';
import { RunsOnLine } from './runs-on-line';
import { StatusMark } from './status-mark';

/** Ticket #1139 — each state as markup, so what a person SEES is asserted, not only the logic behind it. */
const NOW = new Date('2026-10-29T14:00:00Z');
const tz = { timeZone: 'UTC' };
const runner: RunnerDto = {
  id: 'r1',
  name: 'Ievgen’s MacBook Pro',
  status: 'active',
  connection: 'online',
  tools: [{ id: 'claude-code', name: 'Claude Code', installed: true }],
  chosen_tool: 'claude-code',
  runner_version: '0.0.1',
  protocol_version: 1,
  paired_at: '2026-10-29T09:00:00Z',
  last_seen_at: '2026-10-29T13:59:00Z',
  offline_since: null,
  paused_until: null,
  pause_reason: null,
  pending_expires_at: null,
  agents: [{ id: 'a1', name: 'Onboarding Assistant' }],
};
const wake = (state: RunStateName, over: Partial<WakeDto> = {}): WakeDto => ({
  id: `w-${state}`,
  agent: { id: 'a1', name: 'Onboarding Assistant' },
  record: { id: 'rec', database_id: 'db', title: `Client ${state}`, number: 1 },
  reason: 'state_change',
  coalesced_count: 1,
  status: 'queued',
  run_id: null,
  run_state: { state },
  created_at: '2026-10-12T09:00:00Z',
  finished_at: '2026-10-12T10:00:00Z',
  ...over,
});
const ALL: RunStateName[] = ['needs_approval', 'running', 'done', 'failed', 'canceled', 'waiting_for_runner', 'runner_offline', 'waiting_for_limit', 'waiting_for_turn'];
const runList = (wakes: WakeDto[], extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(RunList, { ws: 'w1', wakes, more: false, tz, ...extra }));

describe('the status mark: gold only on running and approval', () => {
  const gold = /bg-accent|text-accent|var\(--accent\)/;
  it.each(['go', 'ask'] as const)('%s is gold', (tone) => {
    expect(renderToStaticMarkup(createElement(StatusMark, { tone, children: 'x' }))).toMatch(gold);
  });
  it.each(['on', 'off', 'limit', 'done', 'fail', 'cancel'] as const)('%s is NOT gold', (tone) => {
    expect(renderToStaticMarkup(createElement(StatusMark, { tone, children: 'x' }))).not.toMatch(gold);
  });
  it('the limit wait is amber with the warning text colour; failed uses the error colour; a cancel is a hollow ring', () => {
    expect(renderToStaticMarkup(createElement(StatusMark, { tone: 'limit', children: 'x' }))).toMatch(/text-warning-text/);
    expect(renderToStaticMarkup(createElement(StatusMark, { tone: 'fail', children: 'x' }))).toMatch(/text-error/);
    expect(renderToStaticMarkup(createElement(StatusMark, { tone: 'cancel', children: 'x' }))).toMatch(/bg-transparent/);
  });
  it('always renders the WORDS, never colour alone', () => {
    expect(renderToStaticMarkup(createElement(StatusMark, { tone: 'fail', children: 'Failed · 14 Oct' }))).toContain('Failed · 14 Oct');
  });
});

describe('the run list renders every state as drawn', () => {
  it('all nine states render, each with its own words', () => {
    const out = runList(ALL.map((s) => wake(s, { run_state: { state: s, runner_name: 'MacBook', since: '2026-10-29T18:40:00Z', until: '2026-10-30T14:00:00Z', tool: 'claude-code' } })));
    for (const text of [
      'Needs your approval',
      'Running on MacBook',
      'Done · 12 Oct',
      'Failed · 12 Oct',
      'Canceled · 12 Oct',
      'Waiting to start on MacBook',
      'Runner offline since 18:40 · starts when it’s back',
      'Waiting for your Claude limit to reset at 14:00',
      'Waiting for the Runner',
    ]) expect(out).toContain(text);
  });
  it('with no Runner assigned the queued row says Dara’s "Waiting for a Runner"', () => {
    expect(runList([wake('waiting_for_runner')])).toContain('Waiting for a Runner');
  });
  it('a failed row has no Try again button and no claim that nothing changed', () => {
    const out = runList([wake('failed')]);
    expect(out).not.toMatch(/Try again/);
    expect(out).not.toMatch(/Nothing was changed/);
    expect(out).toContain('Stopped before it finished');
  });
  it('Review appears only on an approval', () => {
    expect(runList([wake('needs_approval')])).toContain('Review');
    expect(runList(ALL.filter((s) => s !== 'needs_approval').map((s) => wake(s)))).not.toContain('Review');
  });
  it('a gold dot appears on running and approval rows and on no other row', () => {
    for (const s of ALL) {
      const out = runList([wake(s)]);
      const isGold = s === 'running' || s === 'needs_approval';
      expect(/data-tone="(go|ask)"/.test(out), s).toBe(isGold);
    }
  });
  it('empty, loading and failed-to-load each say so; a page of rows claims no total', () => {
    expect(runList([])).toContain('Nothing has woken this agent yet');
    expect(runList([], { loading: true })).toContain('Loading');
    expect(runList([], { error: true })).toContain('Could not load');
    expect(runList([wake('done'), wake('running')])).toContain('1 finished so far');
    expect(runList([wake('done')], { more: true })).toContain('Latest 1');
    expect(runList([wake('done')], { more: true })).not.toContain('finished so far');
  });
  it('links a row to its record', () => {
    expect(runList([wake('done')])).toContain('href="/w/w1/d/db/r/rec"');
  });
});

describe('the first-time moment', () => {
  const html = (waiting: number | null) => renderToStaticMarkup(createElement(FirstRunCard, { agentName: 'Onboarding Assistant', waiting, onAdd: () => {} }));
  it('says the agent has not started, why, and offers ONLY Add a Runner (no API-key button, it is not in v1)', () => {
    const out = html(1);
    expect(out).toContain('Onboarding Assistant hasn’t started work yet');
    expect(out).toContain('your own <b class="font-semibold text-ink">Claude Code or Cursor</b>, through a small free Runner on your computer');
    expect(out).toContain('Add a Runner');
    expect(out).not.toMatch(/API key/i);
  });
  it('names some of the waiting records without ever claiming more than the count', () => {
    expect(namesLine(['Acme Co'], 1)).toBe('Acme Co.');
    expect(namesLine(['Acme Co', 'Orbis'], 2)).toBe('Acme Co and Orbis.');
    expect(namesLine(['A', 'B', 'C'], 3)).toBe('A, B and C.');
    expect(namesLine(['A', 'B', 'C', 'D'], 7)).toBe('A, B, C and 4 more.');
    expect(namesLine(['A', 'B', 'C'], 2)).toBe('A and B.'); // a stale page with more names than the server's count is capped by the count
  });
  it('shows the real waiting count, singular and plural, and leaves the line out rather than guess or print a zero', () => {
    expect(html(1)).toContain('1 record is waiting for it');
    expect(html(3)).toContain('3 records are waiting for it');
    expect(html(0)).not.toMatch(/waiting for it/);
    expect(html(null)).not.toMatch(/waiting for it/);
  });
});

describe('Runs on', () => {
  const html = (canChange: boolean, assigned: { id: string; name: string } | null) =>
    renderToStaticMarkup(createElement(RunsOnLine, { assigned, runners: [runner], canChange, onPick: () => {}, onAdd: () => {}, now: NOW }));
  it('reads "Runs on <machine> · <tool>" with a Change button for the owner', () => {
    const out = html(true, { id: 'r1', name: 'Ievgen’s MacBook Pro' });
    expect(out).toContain('Ievgen’s MacBook Pro');
    expect(out).toContain('Claude Code');
    expect(out).toContain('Change');
  });
  it('with no Runner it says so and still offers Change (the way to add one)', () => {
    const out = html(true, null);
    expect(out).toContain('No Runner yet');
    expect(out).toContain('Change');
  });
  it('for anyone but the owner the line is read-only: no Change button', () => {
    const out = html(false, { id: 'r1', name: 'Ievgen’s MacBook Pro' });
    expect(out).toContain('Ievgen’s MacBook Pro');
    expect(out).not.toContain('Change');
  });
  it('offers no API key anywhere', () => {
    expect(html(true, null)).not.toMatch(/API key/i);
  });
});

describe('a Runner row on Settings › Runners', () => {
  const html = (r: RunnerDto) => renderToStaticMarkup(createElement(RunnerRow, { runner: r, now: NOW, onRemove: () => {}, tz }));
  it('shows machine, tool, paired date, its agents and its live status', () => {
    const out = html(runner);
    expect(out).toContain('Ievgen’s MacBook Pro');
    expect(out).toContain('Claude Code · paired 29 Oct · runs Onboarding Assistant');
    expect(out).toContain('Online · checked a minute ago');
  });
  it('shows offline-since and the limit wait with the chosen tool’s subscription', () => {
    expect(html({ ...runner, connection: 'offline', offline_since: '2026-10-29T18:40:00Z' })).toContain('Offline since 18:40 · agents wait until it’s back');
    expect(html({ ...runner, chosen_tool: 'cursor', connection: 'paused', pause_reason: 'limit_reached', paused_until: '2026-10-29T14:00:00Z' })).toContain(
      'Waiting for your Cursor limit to reset at 14:00',
    );
  });
  it('Sharing your subscription is drawn but NOT functional: switches disabled, off, and the section says so (ticket #1137 wires it)', () => {
    const out = html(runner);
    expect(out).toContain('Quiet hours');
    expect(out).toContain('Keep a share for me');
    expect(out).toContain('Agents pause when 80% of your Claude limit is used');
    expect((out.match(/role="switch"/g) ?? []).length).toBe(2);
    expect((out.match(/role="switch"[^>]*aria-checked="false"[^>]*disabled=""/g) ?? []).length).toBe(2);
    expect(out).toContain('not switched on yet');
  });
  it('Remove carries Dara’s sentence and no API-key card exists on the page', () => {
    const out = html(runner);
    expect(out).toContain('Its agents wait until you add another Runner. Nothing is deleted.');
    expect(out).toContain('Remove…');
    expect(out).not.toMatch(/No computer on all the time|API key/);
  });
});

describe('a guest with a grant on the Agents database is not told which computer or tool (Vera, PR #1366)', () => {
  const html = (assigned: { id: string; name: string } | null, o: { canChange: boolean; masked?: boolean }) =>
    renderToStaticMarkup(createElement(RunsOnLine, { assigned, runners: [runner], onPick: () => {}, onAdd: () => {}, now: NOW, ...o }));
  const assigned = { id: 'r1', name: 'Olga’s laptop' };
  it('the Runs-on line: owner and member see machine and tool, a guest sees only "Runs on a Runner" and no Change', () => {
    const owner = html(assigned, { canChange: true });
    expect(owner).toContain('Olga’s laptop');
    expect(owner).toContain('Change');
    const member = html(assigned, { canChange: false });
    expect(member).toContain('Olga’s laptop');
    expect(member).not.toContain('Change');
    const guest = html(assigned, { canChange: true, masked: true }); // even if the caller wrongly allowed Change
    expect(guest).toContain('Runs on <b class="font-semibold text-ink">a Runner</b>');
    expect(guest).not.toMatch(/Olga|Claude|Cursor|Change/);
  });
  it('the role predicates: guest and "not loaded yet" see nothing; member and admin see everything', () => {
    for (const role of ['guest', undefined]) {
      expect(canSeeRunnerDetails(role)).toBe(false);
      expect(canHireAgents(role)).toBe(false);
    }
    for (const role of ['member', 'admin']) {
      expect(canSeeRunnerDetails(role)).toBe(true);
      expect(canHireAgents(role)).toBe(true);
    }
  });
  it('run rows name no machine and no tool for a guest, in any state, and still name them for a member', () => {
    const all = ALL.map((s) => wake(s, { run_state: { state: s, runner_name: 'Olga’s laptop', since: '2026-10-29T18:40:00Z', until: '2026-10-30T14:00:00Z', tool: 'claude-code' } }));
    const guest = runList(all, { masked: true });
    expect(guest).not.toMatch(/Olga|Claude|Cursor/);
    expect(guest).toContain('Running<'); // "Running", not "Running on <machine>"
    expect(guest).toContain('Waiting to start<');
    expect(guest).toContain('Waiting for the limit to reset at 14:00');
    expect(guest).toContain('Runner offline since 18:40');
    const member = runList(all);
    expect(member).toContain('Running on Olga’s laptop');
    expect(member).toContain('Waiting for your Claude limit to reset at 14:00');
  });
  it('Hire is wrapped in the predicate on both screens that offer it (a guest gets neither the button nor the card)', () => {
    for (const rel of ['./agent-page.tsx', '../../app/w/[ws]/agents/page.tsx']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src.match(/canHireAgents\(role\) && \(?\s*<(Button|HireDialog)/g) ?? [], rel).toHaveLength(2);
    }
  });
  it('the Agents page says "Runs on a Runner" to a guest and never the machine', () => {
    const src = readFileSync(fileURLToPath(new URL('../../app/w/[ws]/agents/page.tsx', import.meta.url)), 'utf8');
    expect(src).toContain("showMachine ? `Runs on ${row.runner.name}` : 'Runs on a Runner'");
  });
});
