import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATE_NAMES } from '@/lib/runners/types';
import type { RunStateName, WakeDto } from '@/lib/runners/types';
import { RunList } from '@/components/runners/run-list';
import { firstSuccessfulRunId, runQuill } from '@/lib/quill/run-outcome';
import {
  QUILL_MIN_VISIBLE_MS,
  QUILL_SHOW_AFTER_MS,
  nextQuillWaitChange,
  quillWaitView,
} from '@/lib/quill/quill-wait';
import {
  installFailureSurface,
  installFailureText,
  installReadyToastCopy,
  installSuccessSurface,
  shouldShowTips,
} from '@/lib/quill/install-moments';
import { QUILL_POSES } from './quill-poses';
import { Quill } from './quill';
import { AgentsEmpty } from '@/components/runners/agents-empty';
import { canSetupAgents } from '@/lib/runners/access';

const toastCalls = vi.hoisted(() => ({ success: [] as unknown[][], custom: [] as unknown[][] }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: (...a: unknown[]) => void toastCalls.success.push(a),
    custom: (...a: unknown[]) => void toastCalls.custom.push(a),
    dismiss: vi.fn(),
  }),
}));
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
/** Code only: the comments are allowed to SAY "no gold". */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Quill never wears gold (#831: gold means an agent is acting)', () => {
  it('every colour in every pose is ink, paper or steel', () => {
    const colours = new Set(Object.values(QUILL_POSES).flatMap((p) => p.match(/#[0-9a-fA-F]{6}\b/g) ?? []));
    // The one warm tone is the cloche's rust-brown shadow (#8c4a3b), a brown, not the agent gold #d4a017.
    expect([...colours].sort()).toEqual(['#1c2138', '#4a4f68', '#8c4a3b', '#a3abbd', '#fbf6ea']);
    expect(JSON.stringify(QUILL_POSES).toLowerCase()).not.toContain('d4a017');
  });
  it('no component or helper of this ticket reaches for the accent token', () => {
    const files = [
      ...readdirSync(here).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && f !== 'quill-poses.ts'),
      '../../lib/quill/run-outcome.ts',
      '../../lib/quill/install-moments.ts',
    ];
    for (const f of files) expect(code(read(f)), f).not.toMatch(/accent|gold|d4a017/i);
  });
  it('the install dialog’s waiting and tips blocks use no accent either', () => {
    const src = read('../pack-install-dialog.tsx');
    const waiting = src.slice(src.indexOf('data-testid="pack-installing"'), src.indexOf('data-testid="pack-install-failed"'));
    const tips = src.slice(src.indexOf('data-testid="pack-tips"'), src.indexOf('{result.unmet.length > 0 && (', src.indexOf('data-testid="pack-tips"')));
    expect(waiting.length).toBeGreaterThan(200);
    expect(tips.length).toBeGreaterThan(200);
    expect(waiting + tips).not.toMatch(/accent|gold/i);
  });
});

describe('Quill is decorative and still by default', () => {
  const html = renderToStaticMarkup(createElement(Quill, { pose: 'unpack', size: 88, caption: 'Unpacking. Mind the jars.', animate: true }));
  it('is aria-hidden, carries her caption, and two of her never share a filter id', () => {
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('Unpacking. Mind the jars.');
    const two = renderToStaticMarkup(createElement('div', null, createElement(Quill, { pose: 'order', size: 64 }), createElement(Quill, { pose: 'order', size: 64 })));
    const ids = [...two.matchAll(/<filter id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('motion is a class that globals.css gates on prefers-reduced-motion, and nothing else animates her', () => {
    expect(html).toContain('quill-bob');
    const css = readFileSync(fileURLToPath(new URL('../../app/globals.css', import.meta.url)), 'utf8');
    const block = css.slice(css.indexOf('/* She bobs only'));
    expect(block).toMatch(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*\.quill-bob/);
    expect(renderToStaticMarkup(createElement(Quill, { pose: 'drop', size: 56 }))).not.toContain('quill-bob');
  });
  it('the caption face is Instrument Serif, which is vendored', () => {
    expect(read('quill.tsx')).toContain('--font-quill');
    const fonts = readFileSync(fileURLToPath(new URL('../../app/fonts/fonts.css', import.meta.url)), 'utf8');
    expect(fonts).toContain("font-family: 'Instrument Serif'");
  });
});

describe('the wait: no Quill under a second, then at least 600ms', () => {
  const T0 = 10_000;
  // A delayed mock: the install ends `took` ms after it began; sample the screen every 50ms and report when Quill was up and when it moved on.
  function simulate(took: number) {
    let shownFrom: number | null = null;
    let shownTo: number | null = null;
    let settledAt: number | null = null;
    for (let t = 0; t <= 3000; t += 50) {
      const v = quillWaitView(T0, took === Infinity ? null : T0 + took, T0 + t);
      if (v.showQuill && shownFrom === null) shownFrom = t;
      if (!v.showQuill && shownFrom !== null && shownTo === null) shownTo = t;
      if (v.settled && settledAt === null) settledAt = t;
    }
    return { shownFrom, shownTo, settledAt };
  }
  it('an install that takes 400ms or 999ms shows no Quill at all and settles at once', () => {
    for (const took of [0, 400, 999]) {
      const r = simulate(took);
      expect(r.shownFrom, `${took}ms`).toBeNull();
      expect(r.settledAt, `${took}ms`).toBe(took <= 950 ? Math.ceil(took / 50) * 50 : 1000);
    }
    expect(quillWaitView(T0, T0 + 999, T0 + 999)).toEqual({ showQuill: false, settled: true });
  });
  it('one that is still running at a second shows her from 1000ms', () => {
    expect(simulate(Infinity).shownFrom).toBe(QUILL_SHOW_AFTER_MS);
    expect(quillWaitView(T0, null, T0 + 999).showQuill).toBe(false);
  });
  it('one that ends at 1100ms keeps her up until 1600ms (600ms after she appeared), then settles', () => {
    const r = simulate(1100);
    expect(r.shownFrom).toBe(1000);
    expect(r.shownTo).toBe(1000 + QUILL_MIN_VISIBLE_MS);
    expect(r.settledAt).toBe(1000 + QUILL_MIN_VISIBLE_MS);
    expect(quillWaitView(T0, T0 + 1100, T0 + 1500)).toEqual({ showQuill: true, settled: false });
  });
  it('one that ends at 2.5s drops her at the moment it ends, without a held tail', () => {
    const r = simulate(2500);
    expect(r.shownTo).toBe(2500);
    expect(r.settledAt).toBe(2500);
  });
  it('the timer asks for exactly the next change and then nothing', () => {
    expect(nextQuillWaitChange(T0, null, T0 + 10)).toBe(T0 + 1000);
    expect(nextQuillWaitChange(T0, T0 + 1100, T0 + 1150)).toBe(T0 + 1600);
    expect(nextQuillWaitChange(T0, T0 + 400, T0 + 500)).toBeNull();
    expect(nextQuillWaitChange(T0, null, T0 + 2000)).toBeNull();
    expect(nextQuillWaitChange(T0, T0 + 1100, T0 + 1700)).toBeNull();
  });
});

describe('the ready dialog’s tips', () => {
  it('show only for a pack with lines to say, once the opt-out has LOADED as "not dismissed"', () => {
    expect(shouldShowTips(['Open the board'], false)).toBe(true);
    expect(shouldShowTips(['Open the board'], true)).toBe(false);
    expect(shouldShowTips(['Open the board'], undefined)).toBe(false);
    expect(shouldShowTips([], false)).toBe(false);
  });
  it('the opt-out button and Quill are in the same block, so hiding one hides both', () => {
    const src = read('../pack-install-dialog.tsx');
    const block = src.slice(src.indexOf('{showTips && ('), src.indexOf('{result.unmet.length > 0 && (', src.indexOf('{showTips && (')));
    expect(block).toContain('<Quill pose="order"');
    expect(block).toContain('Don’t show these tips again');
    expect(block).toContain('QUILL_TIPS_HINT, true');
    // There is no other Quill on the ready screen.
    const ready = src.slice(src.indexOf('result && !update ? ('), src.indexOf(') : result ? ('));
    expect(ready.match(/<Quill\b/g)).toHaveLength(1);
  });
});

describe('closing the dialog mid-install', () => {
  it('a success is told by a toast and does not navigate; an open dialog navigates or shows its result', () => {
    expect(installSuccessSurface({ closedMidInstall: true, route: '/w/x/d/1' })).toBe('toast');
    expect(installSuccessSurface({ closedMidInstall: true, route: null })).toBe('toast');
    expect(installSuccessSurface({ closedMidInstall: false, route: '/w/x/d/1' })).toBe('navigate');
    expect(installSuccessSurface({ closedMidInstall: false, route: null })).toBe('dialog');
  });
  it('a failure is never silent', () => {
    expect(installFailureSurface({ closedMidInstall: true })).toBe('toast');
    expect(installFailureSurface({ closedMidInstall: false })).toBe('dialog');
  });
  it('the dialog notices a close during an install in ONE wrapper that every exit uses', () => {
    const src = read('../pack-install-dialog.tsx');
    expect(src).toContain('if (!open && install.isPending) closedMidInstall.current = true;');
    expect(src).toContain('onOpenChange: onOpenChangeProp');
    expect(src).not.toMatch(/onOpenChangeProp\(false\)/);
  });
  beforeEach(() => {
    toastCalls.success.length = 0;
    toastCalls.custom.length = 0;
  });
  it('the done toast names the result, carries the way in, and has NO Quill and no tips', async () => {
    const { toastInstallReady } = await import('./install-toasts');
    toastInstallReady({ packName: 'Deal Desk', spaceName: 'Deal Desk', intoExisting: false, goLabel: 'Go there', onGo: () => {} });
    const [title, opts] = toastCalls.success[0] as [string, { description: string; action: { label: string } }];
    expect(title).toBe('Deal Desk is ready');
    expect(opts.description).toBe('A new space, Deal Desk, is in your sidebar.');
    expect(opts.action.label).toBe('Go there');
    expect(JSON.stringify(opts)).not.toMatch(/quill|Try these/i);
    expect(installReadyToastCopy('Deal Desk', 'Sales', true).description).toBe('Sales now has everything in the pack.');
  });
  it('the failure toast: the real error and Retry first, then a small Quill, last in the document; role=alert', async () => {
    const { toastInstallFailed } = await import('./install-toasts');
    toastInstallFailed({ packName: 'Deal Desk', message: 'Stopped at 6 of 10: creating the view timed out.', onRetry: () => {} });
    const [render, opts] = toastCalls.custom[0] as [(id: string) => never, { duration: number }];
    const html = renderToStaticMarkup(render('t1'));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Couldn’t install Deal Desk');
    const err = html.indexOf('Stopped at 6 of 10: creating the view timed out. Nothing was installed.');
    const retry = html.indexOf('Retry');
    const quill = html.indexOf('data-pose="drop"');
    expect(err).toBeGreaterThan(-1);
    expect(retry).toBeGreaterThan(err);
    expect(quill).toBeGreaterThan(retry);
    expect(opts.duration).toBe(Infinity);
  });
});

describe('the failed install text', () => {
  it('is the real error, then "Nothing was installed.", with one full stop between and not two', () => {
    expect(installFailureText('Stopped at 6 of 10: creating the view timed out.')).toBe('Stopped at 6 of 10: creating the view timed out. Nothing was installed.');
    expect(installFailureText('Timed out')).toBe('Timed out. Nothing was installed.');
    expect(installFailureText('  ')).toBe('The install did not finish. Nothing was installed.');
  });
});

describe('run outcomes: Quill beside the pill, never instead of it', () => {
  const ALL: readonly RunStateName[] = RUN_STATE_NAMES;
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
  const list = (wakes: WakeDto[], extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(createElement(RunList, { ws: 'w1', wakes, more: false, tz: { timeZone: 'UTC' }, ...extra }));

  it('the caption table: failed, approval and limit always; done only for the first success; nothing for any other state', () => {
    const expected: Partial<Record<RunStateName, string>> = {
      failed: 'drop',
      needs_approval: 'call',
      waiting_for_limit: 'asleep',
    };
    for (const s of ALL) {
      const q = runQuill(wake(s), 'w-first');
      if (s === 'done') expect(q, 'a done run that is not the first').toBeNull();
      else expect(q?.pose ?? null, s).toBe(expected[s] ?? null);
    }
    expect(runQuill(wake('done', { id: 'w-first' }), 'w-first')).toEqual({ pose: 'order', caption: 'Order up.' });
    expect(runQuill(wake('failed'), null)?.caption).toBe('Dropped it.');
    expect(runQuill(wake('needs_approval'), null)?.caption).toBe('Your call.');
    expect(runQuill(wake('waiting_for_limit'), null)?.caption).toBe('Asleep in the pot.');
  });
  it('the first success is the EARLIEST done run, and unknowable (null) when the list is only a page of a longer history', () => {
    const older = wake('done', { id: 'old', finished_at: '2026-10-01T10:00:00Z' });
    const newer = wake('done', { id: 'new', finished_at: '2026-10-20T10:00:00Z' });
    expect(firstSuccessfulRunId([newer, wake('failed'), older], false)).toBe('old');
    expect(firstSuccessfulRunId([newer, older], true)).toBeNull();
    expect(firstSuccessfulRunId([wake('failed'), wake('canceled')], false)).toBeNull();
    expect(firstSuccessfulRunId([], false)).toBeNull();
  });
  it('every row keeps its pill: Quill follows the label, and a failed row’s real text comes before her', () => {
    const failed = list([wake('failed')]);
    expect(failed.indexOf('Failed')).toBeGreaterThan(-1);
    expect(failed.indexOf('Stopped before it finished')).toBeLessThan(failed.indexOf('data-pose="drop"'));
    expect(failed.indexOf('Failed · ')).toBeLessThan(failed.indexOf('data-pose="drop"'));
    const approval = list([wake('needs_approval')]);
    expect(approval.indexOf('Review')).toBeGreaterThan(-1);
    expect(approval.indexOf('Review')).toBeLessThan(approval.indexOf('data-pose="call"'));
    expect(list([wake('waiting_for_limit')])).toContain('Asleep in the pot.');
  });
  it('a quiet row for a later success, a canceled run and a running one; “Order up.” once, on the first', () => {
    const quiet = list([wake('canceled'), wake('running')]);
    expect(quiet).not.toContain('data-testid="quill"');
    const only = wake('done', { id: 'only' });
    expect(list([only])).toContain('Order up.');
    expect(list([only], { more: true })).not.toContain('Order up.');
    const two = list([wake('done', { id: 'b', finished_at: '2026-10-20T10:00:00Z' }), wake('done', { id: 'a', finished_at: '2026-10-02T10:00:00Z' })]);
    expect(two.match(/Order up\./g)).toHaveLength(1);
  });
  it('an empty Runs box says so in plain words with Quill first and the sentence after her (as the prototype draws it), and loading or failed-to-load draw no Quill', () => {
    const empty = list([]);
    expect(empty).toContain('No runs yet');
    expect(empty).toContain('They show up here when an agent wakes.');
    expect(empty).toContain('data-pose="ready"');
    expect(empty.indexOf('data-pose="ready"')).toBeLessThan(empty.indexOf('No runs yet'));
    expect(list([], { loading: true })).not.toContain('data-testid="quill"');
    expect(list([], { error: true })).not.toContain('data-testid="quill"');
  });
});

describe('empty Agents list and the 404', () => {
  it('the Agents list draws her only in its empty branch (AgentsEmpty), and hides the header button there', () => {
    const src = read('../../app/w/[ws]/agents/page.tsx');
    expect(src.match(/<Quill\b/g)).toBeNull();
    expect(src).toContain('<AgentsEmpty');
    expect(src).toContain('canHireAgents(role) && agents.length > 0');
    expect(read('../runners/agents-empty.tsx').match(/<Quill\b/g)).toHaveLength(1);
  });
  const empty = (o: Partial<Parameters<typeof AgentsEmpty>[0]> = {}) =>
    renderToStaticMarkup(createElement(AgentsEmpty, { role: 'admin', hasAgentsDb: true, onHire: () => {}, onSetup: () => {}, setupPending: false, setupError: null, ...o }));
  it('with an Agents database the one action is Hire an agent (members and admins, never a guest)', () => {
    for (const role of ['admin', 'member']) {
      const html = empty({ role });
      expect(html).toContain('No agents yet');
      expect(html).toContain('Hire an agent');
      expect(html).not.toContain('Set up agents');
    }
    expect(empty({ role: 'guest' })).not.toContain('<button');
  });
  it('a fresh workspace (NO Agents database): an admin gets ONE action, Set up agents, and no Hire and no pack hint', () => {
    const html = empty({ hasAgentsDb: false });
    expect(html).toContain('Set up agents');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('Hire an agent');
    expect(html).not.toMatch(/pack/i);
    expect(empty({ hasAgentsDb: false, setupPending: true })).toMatch(/<button[^>]*disabled[^>]*>Setting up…/);
  });
  it('a failed setup shows the real reason and a Retry, still one button; a non-admin is told whom to ask, never a dead end', () => {
    const failed = empty({ hasAgentsDb: false, setupError: 'The workspace is read-only.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('The workspace is read-only.');
    expect(failed).toContain('Retry');
    expect(failed.match(/<button/g)).toHaveLength(1);
    const member = empty({ hasAgentsDb: false, role: 'member' });
    expect(member).toContain('Ask a workspace admin');
    expect(member).not.toContain('<button');
    expect(empty({ hasAgentsDb: false, role: undefined })).not.toContain('Ask a workspace admin');
  });
  it('the setup action is the one the MCP tool uses: POST /agents/ensure, then the databases list is refetched', () => {
    const src = read('../../lib/runners/queries.ts');
    const hook = src.slice(src.indexOf('export function useSetupAgents'), src.indexOf('export function useRunnerMutations'));
    expect(hook).toContain("'/api/v1/workspaces/{ws}/agents/ensure'");
    expect(hook).toContain("queryKey: ['databases', ws]");
    expect(canSetupAgents('admin')).toBe(true);
    expect(canSetupAgents('member')).toBe(false);
    expect(canSetupAgents(undefined)).toBe(false);
  });
  it('the install dialog’s background note is the prototype’s words, exactly', () => {
    expect(read('../pack-install-dialog.tsx')).toContain('Closing this won’t stop the install. You’ll see the result here.');
  });
  it('the 404 reads plainly, has one way back, and no search link', async () => {
    const { QuillNotFound, homeHrefFor } = await import('./not-found-view');
    const html = renderToStaticMarkup(createElement(QuillNotFound));
    expect(html).toContain('This page doesn’t exist');
    expect(html).toContain('It may have moved, or the link is wrong.');
    expect(html).toContain('data-pose="lost"');
    expect(html).toContain('This was a page once.');
    expect(html).toContain('href="/"');
    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/search/i);
    expect(homeHrefFor('ws1')).toBe('/w/ws1');
    expect(homeHrefFor(undefined)).toBe('/');
  });
  it('both 404 files exist and render the same component: the app root, and the workspace shell', () => {
    expect(read('../../app/not-found.tsx')).toContain('<QuillNotFound />');
    expect(read('../../app/w/[ws]/not-found.tsx')).toContain('<QuillNotFound />');
  });
});
