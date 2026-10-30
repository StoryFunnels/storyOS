// SPDX-License-Identifier: Apache-2.0
import type { AdapterResult, RunnerAdapter, WakeContext } from './adapters/types.js';
import { NetworkError, RunnerApiError, isRetryable } from './protocol/client.js';
import type { RunnerClient } from './protocol/client.js';
import { PROTOCOL_VERSION } from './protocol/types.js';
import type { ClaimedWake, CompleteRequest } from './protocol/types.js';
import { clearScratch, prepareAgentFolder } from './folders.js';
import type { Logger } from './log.js';
import { forgetSecret, redact, registerSecret } from './redact.js';
import type { InflightClaim, RunnerHome, StateStore } from './store.js';

export const SUMMARY_MAX_CHARS = 8_000;
export const ERROR_MAX_CHARS = 4_000;

/** Why the loop stopped by itself. Everything else is a retry. */
export type FatalReason =
  | { kind: 'revoked'; message: string }
  | { kind: 'outdated'; message: string }
  | { kind: 'server_older'; message: string };

export type ClaimLoopClient = Pick<RunnerClient, 'claim' | 'leaseHeartbeat' | 'complete'>;

export interface ClaimLoopOptions {
  client: ClaimLoopClient;
  adapter: RunnerAdapter;
  store: StateStore;
  home: RunnerHome;
  workspaceId: string;
  mcpUrl: string;
  log: Logger;
  /** Wakes run at once on this machine. Default 1. */
  concurrency?: number;
  /** How long one claim long poll asks the server to hold. Default 25 (the server's ceiling). */
  claimWaitSeconds?: number;
  /** The shortest a poll cycle may take, so a server that answers "nothing" instantly is not hammered. Default 1000. */
  minPollIntervalMs?: number;
  /** Backoff after a failed call: doubles from `minMs` to `maxMs`. */
  backoff?: { minMs: number; maxMs: number };
  /** Injected for tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

const DEFAULTS = { concurrency: 1, claimWaitSeconds: 25, minPollIntervalMs: 1000, backoff: { minMs: 1000, maxMs: 30_000 } };

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Errors that mean "stop, and tell the person", not "try again". */
export function classifyFatal(e: unknown): FatalReason | null {
  if (!(e instanceof RunnerApiError)) return null;
  if (e.status === 401) return { kind: 'revoked', message: revokedMessage(e) };
  if (e.status === 426) {
    const cmd = typeof e.meta.update_command === 'string' ? e.meta.update_command : 'npx @storyos/runner@latest';
    return { kind: 'outdated', message: `This Runner is too old for this StoryOS server. Update it with \`${cmd}\` and run it again.` };
  }
  if (e.status === 409 && e.code === 'server_older_than_runner') {
    return { kind: 'server_older', message: 'This StoryOS server is older than this Runner. Install the Runner version that matches the server, or ask your admin to update the server.' };
  }
  return null;
}

/** The sentence a person reads when this machine's pairing is gone. Ours, not the server's: the command people are told to run is fixed (ticket #1134). */
export function revokedMessage(e: RunnerApiError): string {
  if (e.code === 'runner_revoked') {
    if (e.meta.reason === 'cancelled') return 'Pairing was cancelled in StoryOS. Run npx @storyos/runner again to get a new code.';
    if (e.meta.reason === 'pairing_expired') return 'The pairing window ended before you pressed Done in StoryOS. Run npx @storyos/runner again to get a new code.';
    return 'This Runner was removed in StoryOS. Run npx @storyos/runner to pair it again.';
  }
  if (e.code === 'runner_owner_inactive') return 'The person this Runner belongs to is no longer a member of the workspace.';
  return 'StoryOS does not recognise this Runner any more. Run npx @storyos/runner to pair it again.';
}

function cap(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const clean = redact(text);
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max)}\n[cut: ${clean.length - max} more characters were not sent]`;
}

/** The exact body reported for a result. `usage` stays `null` when the tool did not say: never zero-filled. */
export function toCompleteRequest(nonce: string, result: AdapterResult): CompleteRequest {
  const until = result.exit === 'limit_reached' && result.limitReachedUntil ? Date.parse(result.limitReachedUntil) : Number.NaN;
  return {
    nonce,
    exit: result.exit,
    usage: result.usage ? { tokens_in: Math.max(0, Math.trunc(result.usage.tokensIn)), tokens_out: Math.max(0, Math.trunc(result.usage.tokensOut)) } : null,
    ...(result.sessionId ? { session_id: result.sessionId.slice(0, 200) } : {}),
    summary: cap(result.summary, SUMMARY_MAX_CHARS) ?? '',
    ...(result.error ? { error: cap(result.error, ERROR_MAX_CHARS) } : {}),
    ...(Number.isFinite(until) ? { limit_reached_until: new Date(until).toISOString() } : {}),
    ...(result.toolVersion ? { tool_version: result.toolVersion.slice(0, 60) } : {}),
  };
}

/**
 * The claim loop (ADR-0021 section 2). Outbound only: it long-polls the claim endpoint, holds each wake's lease with a heartbeat,
 * runs the adapter in the agent's own folder, and reports the result.
 *
 * The rules this class exists to keep:
 *  - A wake is never run twice by THIS Runner. Its claim is written to disk before its session starts; a result is written before
 *    the first attempt to report it; the report is idempotent on (wake, nonce) so retrying it after a dropped response is safe.
 *  - A lost lease ends the session. `409 lease_lost`, or the lease running out locally because the network is down, aborts the
 *    adapter and DISCARDS its result: the server has already revoked the run credential and put the wake back in the queue.
 *  - After a restart a `running` claim is abandoned (a session cannot be resumed; the server requeues it when the lease lapses) and a
 *    `completing` claim is reported again from the saved result, without running anything.
 *  - Delivery is at-least-once, not exactly-once (ADR-0021 section 2). A wake the server gives back after a lost lease runs again.
 */
export class ClaimLoop {
  private readonly o: Required<Pick<ClaimLoopOptions, 'concurrency' | 'claimWaitSeconds' | 'minPollIntervalMs'>> &
    ClaimLoopOptions & { backoff: { minMs: number; maxMs: number }; sleep: NonNullable<ClaimLoopOptions['sleep']>; now: () => number };
  private readonly active = new Map<string, Promise<void>>();
  private fatal: FatalReason | null = null;
  private inner = new AbortController();

  constructor(options: ClaimLoopOptions) {
    this.o = {
      ...DEFAULTS,
      ...options,
      backoff: options.backoff ?? DEFAULTS.backoff,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
    };
  }

  /** How many wakes are running or being reported right now. */
  get busy(): number {
    return this.active.size;
  }

  /** Runs until `signal` aborts or something fatal happens. Returns the fatal reason, or `null` for a normal stop. */
  async run(signal: AbortSignal): Promise<FatalReason | null> {
    const runSignal = AbortSignal.any([signal, this.inner.signal]);
    const { log } = this.o;
    this.recover(runSignal);
    let failures = 0;
    while (!runSignal.aborted) {
      const free = this.o.concurrency - this.active.size;
      if (free <= 0) {
        await this.anyActiveOrAbort(runSignal);
        continue;
      }
      const started = this.o.now();
      try {
        const res = await this.o.client.claim({ max: free, wait_seconds: this.o.claimWaitSeconds }, { signal: runSignal });
        failures = 0;
        for (const wake of res?.wakes ?? []) this.start(wake, runSignal);
        const took = this.o.now() - started;
        if (!res && took < this.o.minPollIntervalMs) await this.o.sleep(this.o.minPollIntervalMs - took, runSignal);
      } catch (e) {
        if (runSignal.aborted) break;
        const fatal = classifyFatal(e);
        if (fatal) {
          this.fail(fatal);
          break;
        }
        failures += 1;
        const wait = Math.min(this.o.backoff.maxMs, this.o.backoff.minMs * 2 ** Math.min(failures - 1, 10));
        log.warn(`claim failed (${describe(e)}); trying again in ${Math.round(wait / 1000)}s`);
        await this.o.sleep(wait, runSignal);
      }
    }
    // Whatever is still running has been told to stop (the same signal); wait until it has.
    await Promise.allSettled([...this.active.values()]);
    return this.fatal;
  }

  /** The persisted claims of a previous process. Called once, before the first poll. */
  private recover(runSignal: AbortSignal): void {
    for (const claim of this.o.store.list()) {
      if (claim.phase === 'completing' && claim.completion) {
        this.o.log.info(`recovering the report for wake ${claim.wakeId} (its result was saved before the last stop); nothing will be run again`);
        const p = this.report(claim, claim.completion, runSignal).finally(() => this.active.delete(claim.wakeId));
        this.active.set(claim.wakeId, p);
      } else {
        this.o.log.warn(`wake ${claim.wakeId} was running when the Runner last stopped. Its session cannot be resumed; StoryOS puts it back in the queue when its lease lapses.`);
        this.o.store.remove(claim.wakeId);
      }
    }
  }

  private fail(reason: FatalReason): void {
    this.fatal = reason;
    this.o.log.error(reason.message);
    this.inner.abort();
  }

  private anyActiveOrAbort(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      signal.addEventListener('abort', done, { once: true });
      void Promise.race([...this.active.values()]).then(done, done);
    });
  }

  private start(wake: ClaimedWake, runSignal: AbortSignal): void {
    const prior = this.active.get(wake.id);
    const job: Promise<void> = (async () => {
      // The same wake handed to us again while our old handling of it is still winding down: let that finish first.
      if (prior) await prior.catch(() => undefined);
      await this.handle(wake, runSignal);
    })()
      .catch((e: unknown) => this.o.log.error(`wake ${wake.id} failed unexpectedly: ${describe(e)}`))
      .finally(() => {
        if (this.active.get(wake.id) === job) this.active.delete(wake.id);
      });
    this.active.set(wake.id, job);
  }

  private async handle(wake: ClaimedWake, runSignal: AbortSignal): Promise<void> {
    const { log, store, client, adapter } = this.o;
    registerSecret(wake.credential.token);
    log.info(`claimed wake ${wake.id} for agent "${wake.agent.name}" (${wake.reason})`);
    const claim: InflightClaim = {
      wakeId: wake.id,
      nonce: wake.nonce,
      runId: wake.run_id,
      agentId: wake.agent.id,
      claimedAt: new Date(this.o.now()).toISOString(),
      phase: 'running',
    };
    store.put(claim);

    const session = new AbortController();
    const sessionSignal = AbortSignal.any([session.signal, runSignal]);
    let lost = false;
    let leaseDeadline = this.o.now() + wake.lease_seconds * 1000;
    let phase: 'running' | 'completing' = 'running';
    const heartbeat = new AbortController();
    const heartbeatMs = Math.max(50, Math.min(wake.heartbeat_seconds, wake.lease_seconds / 2) * 1000);

    const lose = (why: string): void => {
      if (lost) return;
      lost = true;
      log.warn(`wake ${wake.id}: ${why}. Stopping the session and discarding its result.`);
      session.abort();
    };
    const lease = (async () => {
      const stop = AbortSignal.any([heartbeat.signal, runSignal]);
      while (!stop.aborted) {
        await this.o.sleep(heartbeatMs, stop);
        if (stop.aborted) return;
        try {
          const r = await client.leaseHeartbeat(wake.id, wake.nonce, { signal: stop, timeoutMs: heartbeatMs });
          leaseDeadline = this.o.now() + (r?.lease_seconds ?? wake.lease_seconds) * 1000;
        } catch (e) {
          if (stop.aborted) return;
          if (e instanceof RunnerApiError && e.status === 409) {
            lose(`the server says this Runner no longer holds it (${e.code})`);
            return;
          }
          const fatal = classifyFatal(e);
          if (fatal) {
            lose('this Runner is no longer accepted by the server');
            this.fail(fatal);
            return;
          }
          // The network is down or the server is unwell. The lease is still ours until its own clock says otherwise.
          if (phase === 'running' && this.o.now() >= leaseDeadline) {
            lose('the lease ran out while the server could not be reached');
            return;
          }
          log.warn(`wake ${wake.id}: lease heartbeat failed (${describe(e)})`);
        }
      }
    })();

    let workdir = '';
    try {
      let result: AdapterResult;
      try {
        workdir = prepareAgentFolder(this.o.home, this.o.workspaceId, wake);
        const ctx = this.context(wake, workdir);
        result = await adapter.execute(ctx, sessionSignal);
      } catch (e) {
        result = { exit: 'error', usage: null, summary: '', error: `The session could not run: ${describe(e)}`, toolVersion: adapter.id };
      }
      if (lost || runSignal.aborted) {
        log.warn(`wake ${wake.id}: discarded. The Runner stopped or lost the lease, so no result is reported; StoryOS requeues the wake.`);
        store.remove(wake.id);
        return;
      }
      const completion = toCompleteRequest(wake.nonce, result);
      phase = 'completing';
      claim.phase = 'completing';
      claim.completion = completion;
      store.put(claim);
      await this.report(claim, completion, runSignal);
    } finally {
      heartbeat.abort();
      await lease.catch(() => undefined);
      if (workdir) {
        try {
          clearScratch(workdir);
        } catch {
          // the folder is the Runner's own; a failure to tidy it must not hide the result
        }
      }
      forgetSecret(wake.credential.token);
    }
  }

  /** Report a saved result until the server has it. Idempotent on (wake, nonce), so a retry after a dropped answer is the same request. */
  private async report(claim: InflightClaim, completion: CompleteRequest, runSignal: AbortSignal): Promise<void> {
    const { log, client, store } = this.o;
    let failures = 0;
    while (!runSignal.aborted) {
      try {
        const answer = await client.complete(claim.wakeId, completion, { signal: runSignal });
        log.info(`wake ${claim.wakeId}: reported ${completion.exit}${answer?.repeated ? ' (the server already had it)' : ''}${answer?.requeued ? '; StoryOS queued it again' : ''}`);
        store.remove(claim.wakeId);
        return;
      } catch (e) {
        if (runSignal.aborted) return; // stays saved: the next start reports it
        if (e instanceof RunnerApiError && e.status === 409) {
          log.warn(`wake ${claim.wakeId}: the server no longer holds this claim for us (${e.code}); the result is discarded`);
          store.remove(claim.wakeId);
          return;
        }
        const fatal = classifyFatal(e);
        if (fatal) {
          this.fail(fatal);
          store.remove(claim.wakeId);
          return;
        }
        if (!isRetryable(e)) {
          log.error(`wake ${claim.wakeId}: the server refused the report (${describe(e)}); giving up on it`);
          store.remove(claim.wakeId);
          return;
        }
        failures += 1;
        const wait = Math.min(this.o.backoff.maxMs, this.o.backoff.minMs * 2 ** Math.min(failures - 1, 10));
        log.warn(`wake ${claim.wakeId}: could not report (${describe(e)}); the result is saved, trying again in ${Math.round(wait / 1000)}s`);
        await this.o.sleep(wait, runSignal);
      }
    }
  }

  private context(wake: ClaimedWake, workdir: string): WakeContext {
    return {
      wakeId: wake.id,
      runId: wake.run_id,
      reason: wake.reason,
      reasons: wake.reasons.map((r) => ({ reason: r.reason, ...(r.count !== undefined ? { count: r.count } : {}) })),
      depth: wake.depth,
      agent: {
        id: wake.agent.id,
        name: wake.agent.name,
        goal: wake.agent.goal,
        instructions: wake.agent.instructions ?? '',
        skills: wake.agent.skills,
        targetDatabases: wake.agent.target_databases,
      },
      ...(wake.record ? { record: { id: wake.record.id, databaseId: wake.record.database_id, ref: wake.record.number != null ? `#${wake.record.number}` : wake.record.id } } : {}),
      mcp: { url: this.o.mcpUrl, token: wake.credential.token },
      workdir,
      allowedNativeTools: [],
      protocol: PROTOCOL_VERSION,
    };
  }
}

export function describe(e: unknown): string {
  if (e instanceof RunnerApiError) return `${e.status} ${e.code}`;
  if (e instanceof NetworkError) return e.message;
  return redact(e instanceof Error ? e.message : String(e));
}
