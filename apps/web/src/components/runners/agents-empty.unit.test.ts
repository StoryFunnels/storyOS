import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WakeDto } from '@/lib/runners/types';
import { recordsWaitingCount } from '@/lib/runners/runner-state';
import { AgentsEmpty } from './agents-empty';
import { FirstRunCard } from './first-run-card';
import { RunList } from './run-list';

/*
 * Ticket #1289 items 3 and 4 — the two empty states of the agents surface, RENDERED, with the words a person reads asserted. The earlier
 * tests only read the source text of agents-empty.tsx, which cannot see a dropped `body`, a wrong variant or a missing action.
 */
const props = { onHire: () => {}, onSetup: () => {}, setupPending: false, setupError: null as string | null };
const agents = (o: Partial<Parameters<typeof AgentsEmpty>[0]>) => renderToStaticMarkup(createElement(AgentsEmpty, { role: 'admin', hasAgentsDb: true, ...props, ...o }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ''));

describe('no agents (ticket #1289 item 3)', () => {
  it('is the big EmptyState: Quill in her slot, one heading, exactly ONE action, "Hire an agent"', () => {
    const out = agents({});
    expect(out).toContain('data-empty-state="big"');
    expect(out).toContain('<h3');
    expect(out).toContain('No agents yet');
    expect(out).toContain('Nothing to cook yet.');
    expect(buttons(out)).toEqual(['Hire an agent']);
  });
  it('a workspace with no Agents database offers Set up agents instead, still one button; a pending setup disables it', () => {
    expect(buttons(agents({ hasAgentsDb: false }))).toEqual(['Set up agents']);
    expect(agents({ hasAgentsDb: false, setupPending: true })).toMatch(/<button[^>]*disabled[^>]*>.*Setting up…/);
  });
  it('a failed setup says so in an alert and the action becomes Retry', () => {
    const out = agents({ hasAgentsDb: false, setupError: 'Could not set up agents. Nothing was created. Try again.' });
    expect(out).toContain('role="alert"');
    expect(out).toContain('Could not set up agents. Nothing was created. Try again.');
    expect(buttons(out)).toEqual(['Retry']);
  });
  it('KEEPS: a person who cannot hire or set up sees the heading and no button (a guest, a member), and a member is told whom to ask', () => {
    const guest = agents({ role: 'guest' });
    expect(guest).toContain('No agents yet');
    expect(buttons(guest)).toEqual([]);
    const member = agents({ role: 'member', hasAgentsDb: false });
    expect(buttons(member)).toEqual([]);
    expect(member).toContain('Ask a workspace admin to set them up.');
  });
});

describe('empty runs (ticket #1289 item 4)', () => {
  const runs = (wakes: WakeDto[]) => renderToStaticMarkup(createElement(RunList, { ws: 'w1', wakes, more: false }));
  it('is the big EmptyState with Quill ("Yes, chef."), the title AND the body, and no action', () => {
    const out = runs([]);
    expect(out).toContain('data-empty-state="big"');
    expect(out).toContain('Yes, chef.');
    expect(out).toContain('No runs yet');
    expect(out).toContain('They show up here when an agent wakes.');
    expect(buttons(out)).toEqual([]);
    expect(out).toContain('0 finished so far');
  });
});

describe('records already in the trigger state before the hire (ticket #1289 item 4, recordsWaitingCount)', () => {
  const card = (catchUp: number | undefined) =>
    renderToStaticMarkup(createElement(FirstRunCard, { agentName: 'Triage Bot', recordsWaiting: recordsWaitingCount(catchUp === undefined ? undefined : { catch_up: catchUp }), noun: 'issue', onAdd: () => {} }));
  it('prints the summary\'s catch_up through the trigger database\'s noun, singular and plural', () => {
    expect(card(1)).toContain('1 issue is waiting for it');
    expect(card(3)).toContain('3 issues are waiting for it');
  });
  it('KEEPS: no count line when the figure is 0, absent or unknown (never a guess, never a printed zero)', () => {
    for (const n of [0, undefined]) expect(card(n)).not.toMatch(/waiting for it/);
    expect(recordsWaitingCount({ catch_up: 0 })).toBeNull();
    expect(recordsWaitingCount({ catch_up: null as unknown as number })).toBeNull();
  });
});
