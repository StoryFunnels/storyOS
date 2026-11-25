import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CatchUpBox, CatchUpDialogBody } from './catch-up-box';
import { RunList } from './run-list';
import { andMoreLine, moreCount, notListedLine, notStartedSub, usableList } from '@/lib/runners/catch-up-list';
import type { WaitingItem, WaitingList } from '@/lib/runners/catch-up-list';
import type { ScopeWords } from '@/lib/runners/catch-up';

/** Ticket #1224 (web half): the waiting records by name, in the box, the dialog and the Runs list. */
const CLIENTS: ScopeWords = { noun: 'client', state: { field: 'Status', label: 'Onboarding' } };
const GENERIC: ScopeWords = { noun: 'record', state: null };
const runs = { machine: 'M', tool: 'Claude Code', brand: 'Claude', runner: { connection: 'online' as const, pause_reason: null, paused_until: null }, clock: (s: string) => s };
const common = { agentName: 'Onboarding Assistant', job: 'Send a welcome packet.', asksPhrases: [] as string[], runs };

const item = (i: number, title: string | null = `Client ${i}`): WaitingItem => ({ id: `r${i}`, title, database_id: 'db1', database_name: 'Clients' });
const list = (total: number, shown: number, over: Partial<WaitingList> = {}): WaitingList => ({
  total,
  listed_total: total,
  not_listed: 0,
  items: Array.from({ length: shown }, (_, i) => item(i + 1)),
  limit: 25,
  offset: 0,
  truncated: shown < total,
  ...over,
});

const box = (count: number, l: WaitingList | null, words = CLIENTS) =>
  renderToStaticMarkup(createElement(CatchUpBox, { ...common, count, words, list: l, pending: false, error: null, onOpen: () => {}, onStart: async () => true }));
const dialog = (count: number, l: WaitingList | null, words = CLIENTS) =>
  renderToStaticMarkup(createElement(CatchUpDialogBody, { ...common, count, words, list: l, pending: false, error: null, onCancel: () => {}, onStart: () => {} }));
const runList = (nl: WaitingList | null, words: ScopeWords | null = CLIENTS, wakes: never[] = []) =>
  renderToStaticMarkup(createElement(RunList, { ws: 'ws1', wakes, more: false, notStarted: nl, notStartedWords: words }));

describe('the box names a single record', () => {
  it('N=1: "<Title> was in <state> before ..."', () => {
    const h = box(1, list(1, 1, { items: [item(1, 'Acme Co')] }));
    expect(h).toContain('Acme Co was in Onboarding before Onboarding Assistant could run, so it won’t wake it.');
    expect(h).not.toContain('It was in');
  });
  it('without the list the old wording stands', () => {
    expect(box(1, null)).toContain('It was in Onboarding before');
  });
  it('an untitled record reads Untitled, and a state-less scope keeps its words', () => {
    expect(box(1, list(1, 1, { items: [item(1, null)] }))).toContain('Untitled was in Onboarding');
    expect(box(1, list(1, 1, { items: [item(1, 'Acme')] }), GENERIC)).toContain('Acme was already in its trigger state before');
  });
  it('more than one record keeps the count wording (no name is spliced in)', () => {
    const h = box(3, list(3, 3));
    expect(h).toContain('They were in Onboarding');
    expect(h).not.toContain('Client 1 was');
  });
});

describe('the dialog lists names', () => {
  it('5 names then "and N more" where N = total - 5', () => {
    const h = dialog(12, list(12, 12));
    expect(h).toContain('Client 1');
    expect(h).toContain('Client 5');
    expect(h).not.toContain('Client 6');
    expect(h).toContain('and 7 more');
    expect(h).toContain('Status is Onboarding');
    expect(h.match(/Status is Onboarding/g)).toHaveLength(5);
  });
  it('without a known state the right side names the database', () => {
    expect(dialog(2, list(2, 2), GENERIC)).toContain('>Clients<');
  });
  it('N = total - shown holds for another total (148 waiting, 25 fetched)', () => {
    expect(dialog(148, list(148, 25))).toContain('and 143 more');
  });
  it('exactly 5 waiting: five names and no "more" line', () => {
    const h = dialog(5, list(5, 5));
    expect(h).toContain('Client 5');
    expect(h).not.toMatch(/and \d+ more/);
  });
  it('not_listed is said as a number, never named, and is not part of "more"', () => {
    const h = dialog(9, list(9, 5, { listed_total: 7, not_listed: 2, truncated: true }));
    expect(h).toContain('and 2 more');
    expect(h).toContain('2 you cannot open');
  });
  it('everything unopenable: only the number is shown', () => {
    const h = dialog(2, list(2, 0, { listed_total: 0, not_listed: 2, truncated: false }));
    expect(h).toContain('2 you cannot open');
    expect(h).not.toContain('and 0 more');
  });
  it('an untitled record reads Untitled', () => {
    expect(dialog(1, list(1, 1, { items: [item(1, '')] }))).toContain('Untitled');
  });
  it('no list: the dialog keeps its one count row', () => {
    const h = dialog(3, null);
    expect(h).toContain('3 clients');
    expect(h).toContain('Status is Onboarding');
    expect(h).not.toContain('catch-up-names');
  });
});

describe('usableList (the fallback to the count)', () => {
  it('uses the list when it agrees with the count', () => expect(usableList(list(3, 3), 3)).not.toBeNull());
  it('ignores a list for another count, a missing list and an unknown count', () => {
    expect(usableList(list(3, 3), 4)).toBeNull();
    expect(usableList(undefined, 3)).toBeNull();
    expect(usableList(list(3, 3), null)).toBeNull();
  });
  it('an empty page with nothing hidden is not usable; with hidden records it is', () => {
    expect(usableList(list(3, 0), 3)).toBeNull();
    expect(usableList(list(3, 0, { not_listed: 3 }), 3)).not.toBeNull();
  });
});

describe('the "N more" arithmetic', () => {
  it('is total - not_listed - shown, never below zero', () => {
    expect(moreCount({ total: 12, not_listed: 0 }, 5)).toBe(7);
    expect(moreCount({ total: 12, not_listed: 2 }, 5)).toBe(5);
    expect(moreCount({ total: 3, not_listed: 0 }, 5)).toBe(0);
  });
  it('words', () => {
    expect(andMoreLine(7)).toBe('and 7 more');
    expect(andMoreLine(0)).toBeNull();
    expect(notListedLine(2)).toBe('2 you cannot open');
    expect(notListedLine(0)).toBeNull();
  });
});

describe('the Runs list shows the waiting records as Not started', () => {
  it('one grey Not started row per record, naming the state when it is known', () => {
    const h = runList(list(3, 3));
    expect(h.match(/data-testid="not-started-row"/g)).toHaveLength(3);
    expect(h.match(/>Not started</g)).toHaveLength(3);
    expect(h).toContain('data-tone="off"');
    expect(h).toContain('Entered Onboarding before the Runner was added');
    expect(h).toContain('href="/w/ws1/d/db1/r/r1"');
    expect(h).not.toContain('No runs yet');
  });
  it('without a known state the row claims nothing about state or time', () => {
    const sub = notStartedSub(GENERIC);
    expect(sub).not.toMatch(/Entered|before|since|ago/i);
    expect(runList(list(1, 1), GENERIC)).toContain(sub);
  });
  it('an untitled record reads Untitled', () => {
    expect(runList(list(1, 1, { items: [item(1, null)] }))).toContain('>Untitled<');
  });
  it('past the fetched page: "N more clients not started" from the total, plus "N you cannot open"', () => {
    const h = runList(list(40, 25, { not_listed: 3, listed_total: 37 }));
    expect(h).toContain('12 more clients not started');
    expect(h).toContain('3 you cannot open');
  });
  it('after Start the list is empty/absent and the rows are gone (the empty state returns)', () => {
    for (const nl of [null, list(0, 0)]) {
      const h = runList(nl);
      expect(h).not.toContain('not-started-row');
      expect(h).not.toContain('Not started');
      expect(h).toContain('No runs yet');
    }
  });
});
