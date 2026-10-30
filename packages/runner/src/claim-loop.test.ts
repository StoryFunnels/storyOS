// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterResult, RunnerAdapter, WakeContext } from './adapters/types.js';
import { ClaimLoop, SUMMARY_MAX_CHARS, classifyFatal, toCompleteRequest } from './claim-loop.js';
import type { ClaimLoopClient } from './claim-loop.js';
import { nullLogger } from './log.js';
import { NetworkError, RunnerApiError } from './protocol/client.js';
import type { ClaimedWake, ClaimRequest, ClaimResponse, CompleteRequest } from './protocol/types.js';
import { clearSecrets, registerSecret } from './redact.js';
import { StateStore } from './store.js';
import { tempHome } from '../test/helpers.js';

let h: ReturnType<typeof tempHome>;
beforeEach(() => {
  clearSecrets();
  h = tempHome();
});
afterEach(() => h.cleanup());

let n = 0;
function wake(over: Partial<ClaimedWake> = {}): ClaimedWake {
  n += 1;
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    id,
    nonce: `nonce-${n}`,
    lease_expires_at: new Date(Date.now() + 90_000).toISOString(),
    lease_seconds: 90,
    heartbeat_seconds: 0.05,
    reason: 'manual',
    reasons: [{ reason: 'manual', count: 1 }],
    depth: 0,
    run_id: null,
    agent: { id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `Agent ${n}`, goal: null, instructions: 'do it', skills: null, target_databases: null },
    record: null,
    context: null,
    credential: { token: `cred_${id}_zzzzzzzz`, scope: 'write', expires_at: new Date(Date.now() + 90_000).toISOString() },
    ...over,
  };
}

const ok = (): AdapterResult => ({ exit: 'ok', usage: null, summary: 'done', toolVersion: 't1' });
const adapterOf = (execute: RunnerAdapter['execute']): RunnerAdapter => ({
  id: 'stub',
  detect: async () => ({ installed: true, capabilities: { usageReporting: 'none', limitDetection: false, nativeToolAllowlist: 'none', mcpInjection: false, headless: true } }),
  execute,
});

/** A session that never ends by itself but, as the contract requires, stops when told to. */
const holdUntilAborted: RunnerAdapter['execute'] = (_ctx, signal) =>
  new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exit: 'aborted', usage: null, summary: '', toolVersion: 't' }), { once: true }));

/** A scripted client: `claims` is a queue of answers; once empty it answers 204 after a short pause. */
function scripted(claims: Array<ClaimResponse | undefined | Error>) {
  const queue = [...claims];
  const client = {
    claim: vi.fn(async (_body?: ClaimRequest, _opts?: unknown): Promise<ClaimResponse | undefined> => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined && queue.length === 0) await new Promise((r) => setTimeout(r, 5));
      return next;
    }),
    leaseHeartbeat: vi.fn(async (_id: string, _nonce: string, _opts?: unknown) => ({ wake_id: _id, lease_expires_at: '', lease_seconds: 90 })),
    complete: vi.fn(async (id: string, _body?: CompleteRequest, _opts?: unknown) => ({ wake_id: id, status: 'done', requeued: false, repeated: false })),
  };
  return client as typeof client & ClaimLoopClient;
}

function loopOf(client: ClaimLoopClient, adapter: RunnerAdapter, extra: Partial<ConstructorParameters<typeof ClaimLoop>[0]> = {}) {
  const waits: number[] = [];
  const loop = new ClaimLoop({
    client,
    adapter,
    store: new StateStore(h.home),
    home: h.home,
    workspaceId: 'ws-1',
    mcpUrl: 'https://mcp.example/mcp',
    log: nullLogger,
    claimWaitSeconds: 0.01,
    minPollIntervalMs: 0,
    backoff: { minMs: 100, maxMs: 800 },
    sleep: (ms, signal) => {
      waits.push(ms);
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 1);
        signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
      });
    },
    ...extra,
  });
  return { loop, waits };
}

async function runFor(loop: ClaimLoop, until: () => boolean, ms = 3000) {
  const ctl = new AbortController();
  const done = loop.run(ctl.signal);
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  return { fatal: await done, timedOut: !until() };
}

describe('the claim loop', () => {
  it('asks for as many wakes as it has free slots, and never claims while full', async () => {
    const w1 = wake();
    const release: Array<() => void> = [];
    const client = scripted([{ wakes: [w1] }]);
    const { loop } = loopOf(client, adapterOf(() => new Promise((r) => release.push(() => r(ok())))));
    const ctl = new AbortController();
    const done = loop.run(ctl.signal);
    await vi.waitFor(() => expect(release).toHaveLength(1));
    const callsWhileBusy = client.claim.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(client.claim.mock.calls.length).toBe(callsWhileBusy); // full: no new poll
    expect(client.claim.mock.calls[0]![0]).toMatchObject({ max: 1 });
    release[0]!();
    await vi.waitFor(() => expect(client.complete).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(client.claim.mock.calls.length).toBeGreaterThan(callsWhileBusy)); // a slot freed: polling resumes
    ctl.abort();
    await done;
    expect(client.claim.mock.calls.at(-1)![0]).toMatchObject({ max: 1 });
  });

  it('with concurrency 3 it asks for up to 3, and for 2 when one is running', async () => {
    const client = scripted([{ wakes: [wake()] }]);
    const { loop } = loopOf(client, adapterOf(holdUntilAborted), { concurrency: 3 });
    const ctl = new AbortController();
    const done = loop.run(ctl.signal);
    await vi.waitFor(() => expect(client.claim.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(client.claim.mock.calls[0]![0]).toMatchObject({ max: 3 });
    expect(client.claim.mock.calls[1]![0]).toMatchObject({ max: 2 });
    ctl.abort();
    await done;
  });

  it('paces an instant "nothing queued" so it does not hammer the server', async () => {
    const client = scripted([undefined]);
    client.claim.mockImplementation(async () => undefined);
    const { loop, waits } = loopOf(client, adapterOf(async () => ok()), { minPollIntervalMs: 500, now: () => 0 });
    await runFor(loop, () => waits.length >= 2);
    expect(waits.filter((w) => w === 500).length).toBeGreaterThanOrEqual(2);
  });

  it('backs off after a failed claim, doubling to a ceiling, and recovers', async () => {
    const boom = () => new NetworkError('Could not reach the StoryOS server (ECONNREFUSED).');
    const client = scripted([boom(), boom(), boom(), boom(), boom(), boom(), { wakes: [wake()] }]);
    const { loop, waits } = loopOf(client, adapterOf(async () => ok()));
    const { timedOut } = await runFor(loop, () => client.complete.mock.calls.length === 1);
    expect(timedOut).toBe(false);
    expect(waits.filter((w) => w >= 100).slice(0, 6)).toEqual([100, 200, 400, 800, 800, 800]);
  });

  it('stops, and says why, when the server ends this Runner (401) or says it is too old (426)', async () => {
    const revoked = scripted([new RunnerApiError(401, 'runner_revoked', 'x', { reason: 'removed' })]);
    const a = await runFor(loopOf(revoked, adapterOf(async () => ok())).loop, () => false, 500);
    expect(a.fatal?.kind).toBe('revoked');
    expect(a.fatal?.message).toBe('This Runner was removed in StoryOS. Run npx @storyos/runner to pair it again.');

    const old = scripted([new RunnerApiError(426, 'runner_upgrade_required', 'x', { update_command: 'npx @storyos/runner@latest' })]);
    const b = await runFor(loopOf(old, adapterOf(async () => ok())).loop, () => false, 500);
    expect(b.fatal?.kind).toBe('outdated');
    expect(b.fatal?.message).toContain('npx @storyos/runner@latest');
    expect(classifyFatal(new RunnerApiError(500, 'internal_error', 'x'))).toBeNull();
    expect(classifyFatal(new NetworkError('down'))).toBeNull();
  });

  it('keeps going on a server error: a 500 is the server being unwell, not the Runner being wrong', async () => {
    const client = scripted([new RunnerApiError(503, 'unavailable', 'x'), { wakes: [wake()] }]);
    const { timedOut } = await runFor(loopOf(client, adapterOf(async () => ok())).loop, () => client.complete.mock.calls.length === 1);
    expect(timedOut).toBe(false);
  });

  it('runs a wake the server hands over a second time only after the first handling has finished', async () => {
    const w = wake();
    const again = { ...w, nonce: 'second-nonce' };
    const order: string[] = [];
    const client = scripted([{ wakes: [w] }, { wakes: [again] }]);
    const { loop } = loopOf(
      client,
      adapterOf(async (ctx) => {
        order.push(`start:${ctx.wakeId}`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`end:${ctx.wakeId}`);
        return ok();
      }),
      { concurrency: 2 },
    );
    await runFor(loop, () => client.complete.mock.calls.length === 2);
    expect(order).toEqual([`start:${w.id}`, `end:${w.id}`, `start:${w.id}`, `end:${w.id}`]); // never two sessions for one wake
    expect(client.complete.mock.calls.map((c) => c[1]?.nonce)).toEqual([w.nonce, 'second-nonce']);
  });
});

describe('lease loss', () => {
  it('409 on the lease heartbeat aborts the session and reports NOTHING', async () => {
    const w = wake();
    const client = scripted([{ wakes: [w] }]);
    client.leaseHeartbeat.mockRejectedValue(new RunnerApiError(409, 'lease_lost', 'x'));
    let sawAbort = false;
    const { loop } = loopOf(
      client,
      adapterOf((_ctx, signal) => new Promise((resolve) => signal.addEventListener('abort', () => ((sawAbort = true), resolve(ok())), { once: true }))),
    );
    const { timedOut } = await runFor(loop, () => sawAbort);
    expect(timedOut).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(client.complete).not.toHaveBeenCalled();
    expect(new StateStore(h.home).list()).toEqual([]);
  });

  it('a 409 on the REPORT discards the result and does not retry', async () => {
    const client = scripted([{ wakes: [wake()] }]);
    client.complete.mockRejectedValue(new RunnerApiError(409, 'lease_lost', 'x'));
    const { loop } = loopOf(client, adapterOf(async () => ok()));
    await runFor(loop, () => client.complete.mock.calls.length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(new StateStore(h.home).list()).toEqual([]);
  });

  it('the lease running out locally (the server unreachable for longer than the lease) aborts the session', async () => {
    const w = wake({ lease_seconds: 0.2, heartbeat_seconds: 0.05 });
    const client = scripted([{ wakes: [w] }]);
    client.leaseHeartbeat.mockRejectedValue(new NetworkError('down'));
    let sawAbort = false;
    const { loop } = loopOf(
      client,
      adapterOf((_c, signal) => new Promise((resolve) => signal.addEventListener('abort', () => ((sawAbort = true), resolve(ok())), { once: true }))),
    );
    const { timedOut } = await runFor(loop, () => sawAbort, 4000);
    expect(timedOut).toBe(false);
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('a lease that IS renewed keeps the session alive past the original lease', async () => {
    const w = wake({ lease_seconds: 0.2, heartbeat_seconds: 0.05 });
    const client = scripted([{ wakes: [w] }]);
    client.leaseHeartbeat.mockImplementation(async (id: string) => ({ wake_id: id, lease_expires_at: '', lease_seconds: 0.2 }));
    let aborted = false;
    let abortedBeforeDone = true;
    const { loop } = loopOf(
      client,
      adapterOf(async (_c, signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        await new Promise((r) => setTimeout(r, 500)); // well past the 200 ms lease
        abortedBeforeDone = aborted;
        return ok();
      }),
    );
    await runFor(loop, () => client.complete.mock.calls.length === 1, 4000);
    expect(abortedBeforeDone).toBe(false);
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(client.leaseHeartbeat.mock.calls.length).toBeGreaterThan(2);
  });
});

describe('what is reported', () => {
  it('an adapter that throws is reported as an error, not lost', async () => {
    const client = scripted([{ wakes: [wake()] }]);
    const { loop } = loopOf(client, adapterOf(async () => { throw new Error('the tool crashed'); }));
    await runFor(loop, () => client.complete.mock.calls.length === 1);
    const body = client.complete.mock.calls[0]![1]!;
    expect(body.exit).toBe('error');
    expect(body.error).toContain('the tool crashed');
  });

  it('usage the tool did not report stays null, and one it did report is passed through whole', () => {
    expect(toCompleteRequest('n', ok()).usage).toBeNull();
    expect(toCompleteRequest('n', { ...ok(), usage: { tokensIn: 0, tokensOut: 0 } }).usage).toEqual({ tokens_in: 0, tokens_out: 0 });
    expect(toCompleteRequest('n', { ...ok(), usage: { tokensIn: 12.9, tokensOut: 3 } }).usage).toEqual({ tokens_in: 12, tokens_out: 3 });
  });

  it('caps a long summary and SAYS it cut', () => {
    const body = toCompleteRequest('n', { ...ok(), summary: 'x'.repeat(SUMMARY_MAX_CHARS + 50) });
    expect(body.summary!.length).toBeLessThan(SUMMARY_MAX_CHARS + 100);
    expect(body.summary).toContain('[cut: 50 more characters were not sent]');
  });

  it('sends the limit time only for a limit stop, and only if it is a time', () => {
    const t = '2026-11-01T14:00:00.000Z';
    expect(toCompleteRequest('n', { ...ok(), exit: 'limit_reached', limitReachedUntil: t }).limit_reached_until).toBe(t);
    expect(toCompleteRequest('n', { ...ok(), exit: 'limit_reached', limitReachedUntil: 'tomorrow-ish' }).limit_reached_until).toBeUndefined();
    expect(toCompleteRequest('n', { ...ok(), exit: 'ok', limitReachedUntil: t }).limit_reached_until).toBeUndefined();
  });

  it('redacts a secret an adapter quoted in its summary or error', () => {
    registerSecret('cred_super_secret_value');
    const body = toCompleteRequest('n', { ...ok(), summary: 'used cred_super_secret_value', error: 'Bearer abcdef123456 failed' });
    expect(body.summary).toBe('used [redacted]');
    expect(body.error).toBe('Bearer [redacted] failed');
  });

  it('gives the adapter an id and a reference, never record text, and the credential in memory only', async () => {
    const w = wake({ record: { id: 'rec-1', database_id: 'db-1', number: 7 } });
    const seen: WakeContext[] = [];
    const client = scripted([{ wakes: [w] }]);
    const { loop } = loopOf(client, adapterOf(async (ctx) => (seen.push(ctx), ok())));
    await runFor(loop, () => seen.length === 1);
    const ctx = seen[0]!;
    expect(ctx.record).toEqual({ id: 'rec-1', databaseId: 'db-1', ref: '#7' });
    expect(ctx.mcp).toEqual({ url: 'https://mcp.example/mcp', token: w.credential.token });
    expect(ctx.allowedNativeTools).toEqual([]);
    expect(ctx.workdir).toContain(`ws-1`);
    expect(JSON.stringify(h.home) + JSON.stringify(new StateStore(h.home).list())).not.toContain(w.credential.token);
  });
});
