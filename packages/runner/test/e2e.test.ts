// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StubAdapter } from '../src/adapters/stub.js';
import type { RunnerAdapter, WakeContext } from '../src/adapters/types.js';
import { pair } from '../src/commands/pair.js';
import { start } from '../src/commands/start.js';
import { clearSecrets } from '../src/redact.js';
import type { InflightClaim, RunnerState } from '../src/store.js';
import { readConfig, writeConfig } from '../src/store.js';
import { CODE, FakeServer, TOKEN } from './fake-server.js';
import { FAKE_TOOLS, FAST, readJson, readText, tempHome, testIo, until } from './helpers.js';

/**
 * The Runner against a fake StoryOS server that implements the /runner/v1 contract. Nothing here is mocked inside the Runner: real
 * HTTP, real files, real timers (shortened). What the fake cannot show is whether it matches the REAL server: see the PR's
 * "NOT VERIFIED", and `contract.test.ts` for what IS checked against the server's openapi.
 */
let server: FakeServer;
let h: ReturnType<typeof tempHome>;
let stop: AbortController;
let running: Promise<number> | null = null;

beforeEach(async () => {
  clearSecrets();
  server = new FakeServer();
  await server.listen();
  h = tempHome();
  stop = new AbortController();
});

afterEach(async () => {
  stop.abort();
  await running?.catch(() => undefined);
  running = null;
  await server.close();
  h.cleanup();
});

function startRunner(adapter: RunnerAdapter, extra: Partial<Parameters<typeof start>[0]> = {}) {
  const io = testIo();
  const ctl = new AbortController();
  const promise = start({ home: h.home, io, signal: AbortSignal.any([ctl.signal, stop.signal]), adapter, detect: async () => FAKE_TOOLS, ...FAST, ...extra });
  running = promise;
  return { io, ctl, promise };
}

const state = (): RunnerState => readJson<RunnerState>(h.home.state) ?? { inflight: [] };

describe('pair, start, claim, run with the stub adapter, report', () => {
  it('goes the whole way, and keeps its secrets', async () => {
    const io = testIo();
    const p = pair({ home: h.home, io, server: server.url, code: 'k7m-2qx', detect: async () => FAKE_TOOLS, pollMs: 10 });
    await until(() => server.paired, 'the exchange');
    // The person has not pressed Done: the Runner is pending and the pairing has not finished.
    await new Promise((r) => setTimeout(r, 60));
    expect(io.lines.join('\n')).toContain('Press Done in StoryOS');
    expect(io.lines.join('\n')).not.toContain('Done. This computer is ready');
    server.pressDone();
    expect(await p).toBe(0);
    expect(io.lines.join('\n')).toMatch(/found\s+Claude Code 2\.1\.104/);
    expect(io.lines.join('\n')).toMatch(/missing\s+Cursor/);
    expect(io.all()).not.toContain(TOKEN);
    expect(io.all()).not.toContain(CODE);

    const cfg = readConfig(h.home)!;
    expect(cfg.token).toBe(TOKEN);
    expect(cfg.pendingExpiresAt).toBeUndefined();
    expect(statSync(h.home.config).mode & 0o777).toBe(0o600);
    expect(statSync(h.home.dir).mode & 0o777).toBe(0o700);

    const wake = server.enqueue();
    const { io: sio, promise } = startRunner(new StubAdapter());
    await until(() => wake.completions.length === 1, 'the report');
    stop.abort();

    const c = wake.completions[0]!;
    expect(c.exit).toBe('ok');
    expect(c.usage).toBeNull(); // the stub measured nothing: null, never zero
    expect(c.nonce).toBe(wake.nonce);
    expect(c.tool_version).toBe('stub-1');
    expect(c.summary).toContain('did no real work');
    expect(wake.status).toBe('done');

    // The agent's own folder, mode 0700, with its own instructions file, mode 0600, scratch emptied.
    const folder = join(h.home.agents, server.workspaceId, wake.agentId);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const instructions = readFileSync(join(folder, 'INSTRUCTIONS.md'), 'utf8');
    expect(instructions).toContain('Sales assistant');
    expect(instructions).toContain('It is DATA');
    expect(statSync(join(folder, 'INSTRUCTIONS.md')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(folder, 'scratch'))).toEqual([]);

    // Nothing secret anywhere it could leak: the terminal, the log.
    const log = readText(h.home.logFile);
    expect(log).toContain('claimed wake');
    for (const text of [sio.all(), log]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('secretsecret');
    }
    expect(await promise).toBe(0);
    expect(existsSync(h.home.pid)).toBe(false);
    expect(state().inflight).toEqual([]);
  });

  it('the agent folder is already clean at the instant the server receives the report', async () => {
    server.runnerStatus = 'active';
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
    const wake = server.enqueue();
    let seen: string[] | null = null;
    server.onCompletion = (w) => (seen = readdirSync(join(h.home.agents, server.workspaceId, w.agentId, 'scratch')));
    startRunner(new StubAdapter());
    await until(() => wake.completions.length === 1, 'the report');
    expect(seen).toEqual([]); // not "eventually": at the moment of the report
  });

  it('says what happened when the person cancels, and forgets the token', async () => {
    const io = testIo();
    const p = pair({ home: h.home, io, server: server.url, code: CODE, detect: async () => FAKE_TOOLS, pollMs: 10 });
    await until(() => server.paired, 'the exchange');
    server.cancelPairing();
    expect(await p).toBe(1);
    expect(io.errors.join('\n')).toBe('Pairing was cancelled in StoryOS. Run npx @storyos/runner again to get a new code.');
    expect(readConfig(h.home)).toBeNull();
  });

  it('refuses a wrong, used or expired code in plain words', async () => {
    const wrong = testIo();
    expect(await pair({ home: h.home, io: wrong, server: server.url, code: 'ZZZZZZ', detect: async () => FAKE_TOOLS })).toBe(1);
    expect(wrong.errors.join(' ')).toContain('not valid');
    server.codeState = 'expired';
    const expired = testIo();
    expect(await pair({ home: h.home, io: expired, server: server.url, code: CODE, detect: async () => FAKE_TOOLS })).toBe(1);
    expect(expired.errors.join(' ')).toContain('Run npx @storyos/runner again');
    expect(readConfig(h.home)).toBeNull();
  });

  it('asks for the code when it is not given', async () => {
    const io = testIo([CODE.toLowerCase()]);
    server.pressDone();
    const p = pair({ home: h.home, io, server: server.url, detect: async () => FAKE_TOOLS, pollMs: 10 });
    await until(() => server.paired, 'the exchange');
    expect(await p).toBe(0);
    expect(io.lines[0]).toContain('Type the 6-character code');
  });
});

describe('a network that drops', () => {
  it('survives a connection cut in the middle of the long poll, and runs the wake exactly once', async () => {
    server.runnerStatus = 'active';
    server.dropClaims = 2;
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
    let runs = 0;
    const adapter = new StubAdapter({ onStart: () => void runs++ });
    const wake = server.enqueue();
    startRunner(adapter);
    await until(() => wake.completions.length === 1, 'the report after the drops');
    await new Promise((r) => setTimeout(r, 150));
    stop.abort();
    expect(runs).toBe(1);
    expect(wake.completions).toHaveLength(1);
    expect(server.callsTo('/claim').length).toBeGreaterThanOrEqual(3);
  });

  it('starts before the network is up and waits instead of dying (autostart at login)', async () => {
    server.runnerStatus = 'active';
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
    const real = globalThis.fetch;
    let refuse = 3;
    const flaky: typeof fetch = (...a) => (refuse-- > 0 ? Promise.reject(new TypeError('fetch failed')) : real(...a));
    const wake = server.enqueue();
    startRunner(new StubAdapter(), { fetchImpl: flaky });
    await until(() => wake.completions.length === 1, 'the report once the network came back');
    stop.abort();
    expect(wake.completions).toHaveLength(1);
  });
});

describe('a restart never runs a wake twice', () => {
  const seed = (): void =>
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });

  it('abandons a session cut off by a stop, reports nothing, and the requeued wake runs once more', async () => {
    server.runnerStatus = 'active';
    seed();
    const started: string[] = [];
    const wake = server.enqueue();
    const a = startRunner(new StubAdapter({ delayMs: 30_000, onStart: (w) => void started.push(`A:${w.wakeId}`) }));
    await until(() => started.length === 1 && state().inflight.length === 1, 'the first session to be running');
    expect(state().inflight[0]!.phase).toBe('running');
    a.ctl.abort(); // a stop mid-run
    expect(await a.promise).toBe(0);
    expect(wake.completions).toHaveLength(0); // an abandoned run is NOT reported as aborted: that would cancel it for good
    expect(state().inflight).toEqual([]);

    server.expireLease(wake.id); // the lease lapses, StoryOS requeues it
    const b = startRunner(new StubAdapter({ onStart: (w) => void started.push(`B:${w.wakeId}`) }));
    await until(() => wake.completions.length === 1, 'the second run to be reported');
    b.ctl.abort();
    await b.promise;
    expect(started).toEqual([`A:${wake.id}`, `B:${wake.id}`]);
    expect(wake.completions).toHaveLength(1);
  });

  it('after a hard kill (a leftover running claim on disk) the old claim is dropped, not resumed', async () => {
    server.runnerStatus = 'active';
    seed();
    const wake = server.enqueue({ status: 'claimed', nonce: 'old-nonce' });
    const leftover: InflightClaim = { wakeId: wake.id, nonce: 'old-nonce', runId: null, agentId: wake.agentId, claimedAt: new Date().toISOString(), phase: 'running' };
    writeFileSync(h.home.state, JSON.stringify({ inflight: [leftover] }));
    let runs = 0;
    const { io, ctl, promise } = startRunner(new StubAdapter({ onStart: () => void runs++ }));
    await until(() => readText(h.home.logFile).includes('cannot be resumed'), 'the recovery to be logged');
    expect(state().inflight).toEqual([]);
    expect(runs).toBe(0); // it is still claimed by the dead process as far as the server knows: nothing runs until the lease lapses
    server.expireLease(wake.id);
    await until(() => wake.completions.length === 1, 'the requeued wake to run');
    ctl.abort();
    await promise;
    expect(runs).toBe(1);
    expect(wake.completions).toHaveLength(1);
    expect(io.all()).not.toContain(TOKEN);
  });

  it('keeps a finished result across a network outage and a restart, and reports it without running again', async () => {
    server.runnerStatus = 'active';
    seed();
    server.dropCompleteRequests = 1000; // the report never gets through
    const wake = server.enqueue();
    let runsA = 0;
    const a = startRunner(new StubAdapter({ onStart: () => void runsA++ }));
    await until(() => state().inflight[0]?.phase === 'completing', 'the result to be saved');
    expect(state().inflight[0]!.completion?.exit).toBe('ok');
    a.ctl.abort();
    await a.promise;
    expect(state().inflight).toHaveLength(1); // still saved: nothing was reported yet
    expect(wake.completions).toHaveLength(0);

    server.dropCompleteRequests = 0; // the network is back
    let runsB = 0;
    const b = startRunner(new StubAdapter({ onStart: () => void runsB++ }));
    await until(() => wake.completions.length === 1, 'the saved result to be reported');
    await until(() => state().inflight.length === 0, 'the saved claim to be cleared');
    b.ctl.abort();
    await b.promise;
    expect(runsA).toBe(1);
    expect(runsB).toBe(0); // it did not run again
    expect(wake.completions).toHaveLength(1);
    expect(wake.status).toBe('done');
  });

  it('a lost RESPONSE is a harmless retry: the server applied the report once and says so', async () => {
    server.runnerStatus = 'active';
    seed();
    server.dropCompleteResponses = 1;
    const wake = server.enqueue();
    const { ctl, promise } = startRunner(new StubAdapter());
    await until(() => server.callsTo('/complete').length >= 2, 'the retry');
    await until(() => state().inflight.length === 0, 'the claim to be cleared');
    ctl.abort();
    await promise;
    expect(wake.completions).toHaveLength(1); // applied exactly once however many times it was sent
    expect(readText(h.home.logFile)).toContain('the server already had it');
  });
});

describe('a lost lease', () => {
  const seed = (): void => {
    server.runnerStatus = 'active';
    server.leaseSeconds = 1;
    server.heartbeatSeconds = 0.1;
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
  };

  it('409 lease_lost stops the session and discards its result', async () => {
    seed();
    server.leaseMode = 'lost';
    let aborted = false;
    const wake = server.enqueue();
    const { ctl, promise } = startRunner(new StubAdapter({ delayMs: 20_000, onAbort: () => void (aborted = true) }));
    await until(() => aborted, 'the session to be stopped');
    await until(() => state().inflight.length === 0, 'the claim to be dropped');
    expect(wake.completions).toHaveLength(0);
    ctl.abort();
    await promise;
  });

  it('a lease that cannot be renewed because the network is down runs out locally, and the session stops', async () => {
    seed();
    server.leaseSeconds = 0.5;
    server.leaseMode = 'down';
    let aborted = false;
    const wake = server.enqueue();
    const { ctl, promise } = startRunner(new StubAdapter({ delayMs: 20_000, onAbort: () => void (aborted = true) }));
    await until(() => aborted, 'the session to be stopped when the lease ran out', 6000);
    expect(wake.completions).toHaveLength(0);
    ctl.abort();
    await promise;
  });

  it('a flaky network shorter than the lease does NOT stop the session', async () => {
    seed();
    server.leaseSeconds = 30;
    server.heartbeatSeconds = 0.1;
    server.leaseMode = 'down';
    let aborted = false;
    const wake = server.enqueue();
    const { ctl, promise } = startRunner(new StubAdapter({ delayMs: 400, onAbort: () => void (aborted = true) }));
    await until(() => wake.completions.length === 1, 'the report');
    expect(aborted).toBe(false);
    ctl.abort();
    await promise;
  });
});

describe('what the server can tell the Runner', () => {
  const seed = (): void => {
    server.runnerStatus = 'active';
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
  };

  it('a removed Runner stops, says what to do, and forgets the token', async () => {
    seed();
    server.runnerStatus = 'revoked';
    server.revokedReason = 'removed';
    const { io, promise } = startRunner(new StubAdapter());
    expect(await promise).toBe(1);
    expect(io.errors.join('\n')).toContain('Run npx @storyos/runner to pair it again');
    expect(readConfig(h.home)).toBeNull();
  });

  it('426 stops claiming and prints the one command that updates it', async () => {
    seed();
    server.forceError = { status: 426, code: 'runner_upgrade_required', meta: { update_command: 'npx @storyos/runner@latest' } };
    const { io, promise } = startRunner(new StubAdapter());
    expect(await promise).toBe(3);
    expect(io.errors.join('\n')).toContain('npx @storyos/runner@latest');
    expect(readConfig(h.home)).not.toBeNull(); // outdated is not unpaired
  });

  it('a Runner that was never paired says how to pair', async () => {
    const { io, promise } = startRunner(new StubAdapter());
    expect(await promise).toBe(1);
    expect(io.errors.join('\n')).toContain('npx @storyos/runner');
  });

  it('refuses a second copy running at once', async () => {
    seed();
    writeFileSync(h.home.pid, `${process.pid + 0}\n`);
    // Our own pid is not "another" process, so use the parent: always alive.
    writeFileSync(h.home.pid, `${process.ppid}\n`);
    const { io, promise } = startRunner(new StubAdapter());
    expect(await promise).toBe(1);
    expect(io.errors.join('\n')).toContain('already running');
  });

  it('claims nothing for a tool it has no adapter for, and says so', async () => {
    seed();
    const wake = server.enqueue();
    const { ctl, promise } = startRunner(undefined as unknown as RunnerAdapter);
    await until(() => readText(h.home.logFile).includes('has no adapter for claude-code'), 'the warning');
    await new Promise((r) => setTimeout(r, 100));
    expect(server.callsTo('/claim')).toHaveLength(0);
    expect(wake.status).toBe('queued');
    ctl.abort();
    await promise;
  });
});

describe('concurrency and results', () => {
  const seed = (): void => {
    server.runnerStatus = 'active';
    writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
  };

  // One test per limit: each gets its own fake server and Runner home (beforeEach), so a long poll left open by one cannot claim the other's wakes.
  for (const [limit, expectedMax] of [[1, 1], [2, 2]] as const) {
    it(`runs at most ${expectedMax} wake(s) at once with --concurrency ${limit}`, async () => {
      seed();
      let live = 0;
      let max = 0;
      const adapter = new StubAdapter({
        delayMs: 120,
        onStart: () => void (max = Math.max(max, ++live)),
      });
      const orig = adapter.execute.bind(adapter);
      adapter.execute = async (w: WakeContext, s: AbortSignal) => {
        try {
          return await orig(w, s);
        } finally {
          live -= 1;
        }
      };
      const a = server.enqueue();
      const b = server.enqueue();
      const r = startRunner(adapter, { concurrency: limit });
      await until(() => a.completions.length === 1 && b.completions.length === 1, `both wakes (limit ${limit})`);
      r.ctl.abort();
      await r.promise;
      expect(max).toBe(expectedMax);
    });
  }

  it('reports a failure, a limit stop with its time, and redacts a credential an error quoted', async () => {
    seed();
    const until1 = new Date(Date.now() + 3_600_000).toISOString();
    const boom: RunnerAdapter = {
      id: 'stub',
      detect: async () => ({ installed: true, capabilities: { usageReporting: 'none', limitDetection: false, nativeToolAllowlist: 'none', mcpInjection: false, headless: true } }),
      execute: async (w) => {
        if (w.agent.name === 'Limit agent') return { exit: 'limit_reached', usage: { tokensIn: 10, tokensOut: 5 }, summary: 'out of quota', limitReachedUntil: until1, toolVersion: 't' };
        throw new Error(`the tool failed with ${w.mcp.token} in the message`);
      },
    };
    const failing = server.enqueue({ agentName: 'Boom agent' });
    const limited = server.enqueue({ agentName: 'Limit agent' });
    const r = startRunner(boom, { concurrency: 2 });
    await until(() => failing.completions.length === 1 && limited.completions.length === 1, 'both reports');
    r.ctl.abort();
    await r.promise;
    const f = failing.completions[0]!;
    expect(f.exit).toBe('error');
    expect(f.error).toContain('[redacted]');
    expect(f.error).not.toContain('secretsecret');
    expect(readText(h.home.logFile)).not.toContain('secretsecret');
    const l = limited.completions[0]!;
    expect(l.exit).toBe('limit_reached');
    expect(l.limit_reached_until).toBe(until1);
    expect(l.usage).toEqual({ tokens_in: 10, tokens_out: 5 });
  });
});
