import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RUN_STATE_NAMES } from '@/lib/runners/types';
import type { RunStateName, WakeDto } from '@/lib/runners/types';
import { QUEUE_HIDDEN, RUNS_HIDDEN_HEADER, isLimited, limitedEmptyBody, limitedEmptyTitle, waitingFacts } from '@/lib/runners/visibility';
import { RunList } from './run-list';

/**
 * Ticket #1276 (the web half of #1228) — what an agent's page says when the API tells the viewer some of its activity is hidden.
 * The fixtures cover EVERY run state and both the empty and the non-empty list: a guest is the only viewer who can be limited, and a
 * test that renders only the empty case would pass while a limited list still printed "N finished so far".
 */
const wake = (state: RunStateName, over: Partial<WakeDto> = {}): WakeDto => ({
  id: `w-${state}`,
  agent: { id: 'a1', name: 'Onboarding Assistant' },
  record: { id: 'rec', database_id: 'db', title: `Client ${state}`, number: 1 },
  reason: 'state_change',
  coalesced_count: 1,
  status: 'done',
  run_id: null,
  run_state: { state },
  created_at: '2026-10-12T09:00:00Z',
  finished_at: '2026-10-12T10:00:00Z',
  ...over,
});
const html = (wakes: WakeDto[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(RunList, { ws: 'w1', wakes, more: false, agentName: 'Onboarding Assistant', ...extra }));

describe('#1276 isLimited', () => {
  it("is true only for 'limited'; a missing field from an older API reads as full", () => {
    expect(isLimited('limited')).toBe(true);
    expect(isLimited('full')).toBe(false);
    expect(isLimited(undefined)).toBe(false);
    expect(isLimited(null)).toBe(false);
    expect(isLimited('unexpected')).toBe(false);
  });
});

describe('#1276 the run list when the activity is limited', () => {
  it('with no visible rows says the activity is hidden, with a lock and no Quill, never "No runs yet"', () => {
    const out = html([], { limited: true });
    expect(out).toContain("You can&#x27;t see Onboarding Assistant&#x27;s activity");
    expect(out).toContain(limitedEmptyBody('Onboarding Assistant').replace(/'/g, '&#x27;'));
    expect(out).toContain('data-testid="runs-limited"');
    expect(out).toContain('lucide-lock');
    expect(out).not.toContain('No runs yet');
    expect(out).not.toContain('They show up here when an agent wakes.');
    // "Yes, chef." is Quill saying "nothing yet": false here.
    expect(out).not.toContain('Yes, chef');
  });

  it('draws no total in the header, whatever the rows: not "N finished so far", not "Latest N"', () => {
    for (const rows of [[], [wake('done')], [wake('done'), wake('running'), wake('failed')]]) {
      for (const more of [false, true]) {
        const out = html(rows, { limited: true, more });
        expect(out, `${rows.length} rows, more=${more}`).toContain(RUNS_HIDDEN_HEADER);
        expect(out).not.toMatch(/finished so far/);
        expect(out).not.toMatch(/Latest \d/);
      }
    }
  });

  it('every visible row still draws as normal, in every state', () => {
    const rows = RUN_STATE_NAMES.map((s) => wake(s));
    const out = html(rows, { limited: true });
    expect(out.match(/<li/g)?.length).toBe(rows.length);
    expect(out).toContain('Client done');
    expect(out).toContain('Needs your approval');
  });

  it('does not celebrate a "first run" it cannot know is the first (hidden runs may be earlier)', () => {
    const done = [wake('done')];
    // The first success carries Quill's "Order up." (lib/quill/run-outcome.ts); the control proves the marker is the real one.
    expect(html(done, { limited: false })).toContain('Order up.');
    expect(html(done, { limited: true })).not.toContain('Order up.');
  });

  it("with full visibility the list is exactly what it was: totals, Quill's empty state, the same words", () => {
    expect(html([], { limited: false })).toContain('No runs yet');
    expect(html([], { limited: false })).toContain('Yes, chef');
    expect(html([wake('done')], { limited: false })).toContain('1 finished so far');
    expect(html([wake('done')])).toContain('1 finished so far');
    expect(html([], { limited: false })).not.toContain('runs-limited');
  });

  it('loading and failed-to-load are unchanged when limited', () => {
    expect(html([], { limited: true, loading: true })).toContain('Loading');
    expect(html([], { limited: true, error: true })).toContain('Could not load');
  });
});

describe('#1276 the words', () => {
  it('are the design spec\'s, and the queue fact is the spec\'s three words', () => {
    expect(limitedEmptyTitle('Rosa')).toBe("You can't see Rosa's activity");
    expect(RUNS_HIDDEN_HEADER).toBe('Some runs are hidden from you');
    expect(QUEUE_HIDDEN).toBe('Hidden from you');
  });
});

describe('#1276 waitingFacts: the agent page states no waiting count when the queue is partly hidden', () => {
  const row = (over: Record<string, unknown> = {}) => ({ waiting: 3, catch_up: 4, ...over }) as Parameters<typeof waitingFacts>[0];

  it('limited: no queued-run line, no records-waiting count, no catch-up count, and it says hidden', () => {
    expect(waitingFacts(row({ waiting_visibility: 'limited' }))).toEqual({ hidden: true, catchUp: null, recordsWaiting: null, queued: null });
    // zero is a quantity too: "waiting 0" about a queue the viewer cannot see is the most dangerous number to print
    expect(waitingFacts(row({ waiting_visibility: 'limited', waiting: 0, catch_up: 0 }))).toEqual({ hidden: true, catchUp: null, recordsWaiting: null, queued: null });
  });

  it('full (or a field the API did not send): today\'s facts, unchanged', () => {
    for (const v of ['full', undefined]) {
      expect(waitingFacts(row({ waiting_visibility: v }))).toEqual({ hidden: false, catchUp: 4, recordsWaiting: 4, queued: '3 runs are queued for it' });
    }
    expect(waitingFacts(row({ waiting: 1, catch_up: null }))).toEqual({ hidden: false, catchUp: null, recordsWaiting: null, queued: '1 run is queued for it' });
    expect(waitingFacts(row({ waiting: 0, catch_up: 0 }))).toEqual({ hidden: false, catchUp: null, recordsWaiting: null, queued: null });
    expect(waitingFacts(undefined)).toEqual({ hidden: false, catchUp: null, recordsWaiting: null, queued: null });
  });
});
