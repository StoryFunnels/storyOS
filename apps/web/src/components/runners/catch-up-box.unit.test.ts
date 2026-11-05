import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CatchUpBox, CatchUpDialogBody } from './catch-up-box';
import type { ScopeWords } from '@/lib/runners/catch-up';

const post = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, api: { POST: (...a: unknown[]) => post(...a), GET: vi.fn() } };
});

import { apiErrorMessage } from '@/lib/api';
import { catchUpMutationOptions } from '@/lib/runners/use-catch-up';

/** Ticket #1152 — what is drawn, and what the click does to the queries behind it. */
const CLIENTS: ScopeWords = { noun: 'client', state: { field: 'Status', label: 'Onboarding' } };
const runs = { machine: 'M', tool: 'Claude Code', brand: 'Claude', runner: { connection: 'online' as const, pause_reason: null, paused_until: null }, clock: (s: string) => s };
const common = { agentName: 'Onboarding Assistant', words: CLIENTS, job: 'Send a welcome packet.', asksPhrases: ['sending email'], runs };

describe('the box', () => {
  const html = renderToStaticMarkup(createElement(CatchUpBox, { ...common, count: 3, pending: false, error: null, onOpen: () => {}, onStart: async () => true }));
  it('is a bordered card (not gold) with Dara’s title, body and primary button', () => {
    expect(html).toContain('data-testid="catch-up"');
    expect(html).toContain('3 clients already waiting');
    expect(html).toContain('They were in Onboarding before Onboarding Assistant could run');
    expect(html).toContain('Start on 3 waiting clients');
    expect(html).toContain('border-border-strong');
    expect(html).not.toMatch(/gold|accent/);
  });
  it('uses no undeclared var() fallback and no raw colour', () => {
    expect(html).not.toMatch(/var\([^)]*,/);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
  it('has no dismiss-forever control: "Not now" lives in the dialog and keeps the box', () => {
    expect(html).not.toMatch(/dismiss|hide|never show/i);
  });
});

describe('the dialog body', () => {
  const body = (over: Partial<Parameters<typeof CatchUpDialogBody>[0]> = {}) =>
    renderToStaticMarkup(createElement(CatchUpDialogBody, { ...common, count: 3, pending: false, error: null, onCancel: () => {}, onStart: () => {}, ...over }));
  it('shows the rule row, the job, the holds, the muted runs line and both buttons', () => {
    const h = body();
    expect(h).toContain('3 clients');
    expect(h).toContain('Status is Onboarding');
    expect(h).toContain('Onboarding Assistant’s job: “Send a welcome packet.”');
    expect(h).toContain('It asks you before sending email.');
    expect(h).toContain('3 runs on M with Claude Code, one at a time.');
    expect(h).toContain('Not now');
    expect(h).toContain('Start on 3 clients');
  });
  it('the runs line is the MUTED token at label size, not body or gold', () => {
    const m = body().match(/<p class="([^"]*)" data-testid="catch-up-runs"/);
    expect(m?.[1]).toContain('text-muted');
    expect(m?.[1]).toContain('text-label');
    expect(m?.[1]).not.toMatch(/ink|gold/);
  });
  it('while the click is in flight both buttons are disabled and the start button says so', () => {
    const h = body({ pending: true });
    expect(h.match(/ disabled=""/g)?.length).toBe(2);
    expect(h).toContain('Starting…');
    expect(body({ pending: false })).not.toContain(' disabled=""');
  });
  it('a refusal is shown in words as an alert; with none, no alert', () => {
    const h = body({ error: 'This agent is switched off. Turn it on first.' });
    expect(h).toContain('role="alert"');
    expect(h).toContain('This agent is switched off. Turn it on first.');
    expect(body()).not.toContain('role="alert"');
  });
  it('without a known state there is no invented rule row, and no hold sentence when no hold is set', () => {
    const h = body({ words: { noun: 'record', state: null }, asksPhrases: [] });
    expect(h).not.toContain('<ul');
    expect(h).not.toContain('asks you before');
  });
});

describe('the click', () => {
  beforeEach(() => post.mockReset());
  const run = (qc: QueryClient, ws = 'ws1') => new MutationObserver(qc, catchUpMutationOptions(qc, ws)).mutate('agent1');

  it('POSTs the catch-up for THAT agent with no body', async () => {
    post.mockResolvedValue({ data: { queued: 4, already_waiting: 0, remaining: 0, skipped: 0 } });
    const r = await run(new QueryClient());
    expect(r).toEqual({ queued: 4, already_waiting: 0, remaining: 0, skipped: 0 });
    expect(post).toHaveBeenCalledWith('/api/v1/workspaces/{ws}/agents/{agent}/catch-up', { params: { path: { ws: 'ws1', agent: 'agent1' } } });
  });
  it('re-reads the count (the summary) and the queue after the click, success or not', async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    post.mockResolvedValueOnce({ data: { queued: 1, already_waiting: 0, remaining: 0, skipped: 0 } });
    await run(qc);
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(['agent-wakes-summary', 'ws1']));
    expect(keys).toContain(JSON.stringify(['agent-wakes', 'ws1']));
    spy.mockClear();
    post.mockResolvedValueOnce({ error: { error: { message: 'This agent is switched off. Turn it on first.' } } });
    await expect(run(qc)).rejects.toBeTruthy();
    expect(spy.mock.calls.length).toBe(2);
  });
  it('a 422 reaches the caller as the API’s body, and apiErrorMessage turns it into the sentence', async () => {
    const body = { error: { message: 'Only an agent whose AI mode is "Your own AI" has a queue to catch up.' } };
    post.mockResolvedValue({ error: body });
    const err = await run(new QueryClient()).catch((e: unknown) => e);
    expect(err).toBe(body);
    expect(apiErrorMessage(err, 'fallback')).toBe('Only an agent whose AI mode is "Your own AI" has a queue to catch up.');
  });
});
