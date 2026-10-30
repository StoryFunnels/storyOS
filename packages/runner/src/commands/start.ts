// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { RunnerAdapter } from '../adapters/types.js';
import { resolveAdapter } from '../adapters/index.js';
import { detectTools } from '../adapters/detect.js';
import { ClaimLoop, classifyFatal, defaultSleep, describe } from '../claim-loop.js';
import type { ClaimLoopOptions, FatalReason } from '../claim-loop.js';
import type { Io } from '../io.js';
import { createFileLogger } from '../log.js';
import type { Logger } from '../log.js';
import { NetworkError, RunnerApiError, RunnerClient } from '../protocol/client.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';
import type { HeartbeatResponse, RunnerReport, ToolReport } from '../protocol/types.js';
import { registerSecret } from '../redact.js';
import { StateStore, clearConfig, ensureDir, readConfig, writePrivateFile } from '../store.js';
import type { RunnerHome } from '../store.js';
import { machineName, mcpUrlFor, runnerVersion } from '../version.js';

export interface StartOptions {
  home: RunnerHome;
  io: Io;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
  /** `stub` selects the stub adapter (a dry run). Otherwise the adapter follows the tool chosen in StoryOS. */
  adapterOverride?: string;
  /** Inject an adapter (tests). */
  adapter?: RunnerAdapter;
  concurrency?: number;
  mcpUrl?: string;
  log?: Logger;
  detect?: () => Promise<ToolReport[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  loop?: Pick<ClaimLoopOptions, 'claimWaitSeconds' | 'minPollIntervalMs' | 'backoff' | 'now'>;
  /** Overrides the server's heartbeat interval (tests). */
  heartbeatMs?: number;
}

export const EXIT = { ok: 0, failed: 1, usage: 2, outdated: 3 } as const;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readPid(home: RunnerHome): number | null {
  try {
    const n = Number.parseInt(readFileSync(home.pid, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * `start`: the outbound-only claim loop. Heartbeat the machine, wait for Done if it is still pending, then long-poll for wakes and run
 * each through the adapter. Runs until `signal` aborts (a stop request) or the server ends this Runner's pairing. Returns the exit code.
 */
export async function start(opts: StartOptions): Promise<number> {
  const { home, io } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const config = readConfig(home);
  if (!config) {
    io.err('This computer is not paired yet. Run npx @storyos/runner to pair it.');
    return EXIT.failed;
  }
  const running = readPid(home);
  if (running && running !== process.pid && pidAlive(running)) {
    io.err(`The Runner is already running on this computer (process ${running}). Stop it first, or leave it be.`);
    return EXIT.failed;
  }
  ensureDir(home.dir);
  writePrivateFile(home.pid, `${process.pid}\n`);

  const log = opts.log ?? createFileLogger({ file: home.logFile, echo: (l) => io.out(l) });
  registerSecret(config.token);
  const stop = new AbortController();
  const signal = AbortSignal.any([opts.signal, stop.signal]);
  let fatal: FatalReason | null = null;
  const fail = (f: FatalReason): void => {
    fatal ??= f;
    log.error(f.message);
    stop.abort();
  };

  try {
    const tools = await (opts.detect ?? detectTools)();
    const report: RunnerReport = { machine_name: machineName(opts.env), tools, runner_version: runnerVersion(), protocol_version: PROTOCOL_VERSION };
    const client = new RunnerClient({ server: config.server, token: config.token, runnerVersion: report.runner_version, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    log.info(`Runner ${report.runner_version} starting for ${config.server} as "${report.machine_name}"`);

    // The first heartbeat: also how a Runner started at login, before the network is up, waits instead of dying.
    let beat: HeartbeatResponse | null = null;
    let failures = 0;
    while (!signal.aborted && !beat) {
      try {
        beat = await client.heartbeat(report, { signal });
      } catch (e) {
        if (signal.aborted) break;
        const f = classifyFatal(e);
        if (f) {
          fail(f);
          break;
        }
        failures += 1;
        const wait = Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5));
        log.warn(`could not reach StoryOS (${describe(e)}); trying again in ${Math.round(wait / 1000)}s`);
        await sleep(wait, signal);
      }
    }

    let chosenTool = beat?.runner.chosen_tool ?? null;
    // Pending: the person has not pressed Done yet. Do nothing until they do (ADR-0021 section 3).
    while (beat && beat.runner.status === 'pending' && !signal.aborted) {
      log.info('Waiting for you to press Done in StoryOS.');
      await sleep(opts.heartbeatMs ?? 2000, signal);
      if (signal.aborted) break;
      try {
        beat = await client.heartbeat(report, { signal });
        chosenTool = beat.runner.chosen_tool;
      } catch (e) {
        if (signal.aborted) break;
        const f = classifyFatal(e);
        if (f) {
          fail(f);
          break;
        }
        if (!(e instanceof NetworkError) && !(e instanceof RunnerApiError)) throw e;
      }
    }
    if (beat?.runner.status === 'revoked') fail({ kind: 'revoked', message: 'This Runner was removed in StoryOS. Run npx @storyos/runner to pair it again.' });

    if (!signal.aborted && beat) {
      const everyMs = opts.heartbeatMs ?? Math.max(5, beat.heartbeat_interval_seconds) * 1000;
      const heartbeats = (async () => {
        let n = 0;
        let latest = tools;
        while (!signal.aborted) {
          await sleep(everyMs, signal);
          if (signal.aborted) return;
          n += 1;
          if (n % 20 === 0) latest = await (opts.detect ?? detectTools)().catch(() => latest);
          try {
            const b = await client.heartbeat({ ...report, tools: latest }, { signal });
            chosenTool = b.runner.chosen_tool;
          } catch (e) {
            if (signal.aborted) return;
            const f = classifyFatal(e);
            if (f) return fail(f);
            log.warn(`heartbeat failed (${describe(e)})`);
          }
        }
      })();

      // An adapter for the tool the person chose. This version has only the stub, and only when asked for by name.
      let adapter: RunnerAdapter | null = opts.adapter ?? resolveAdapter(chosenTool, opts.adapterOverride ?? opts.env?.STORYOS_RUNNER_ADAPTER);
      let said = false;
      while (!adapter && !signal.aborted) {
        if (!said) {
          log.warn(`This Runner version has no adapter for ${chosenTool ?? 'the tool you chose'} yet, so it claims nothing and your agents' wakes wait in StoryOS.`);
          said = true;
        }
        await sleep(everyMs, signal);
        adapter = resolveAdapter(chosenTool, opts.adapterOverride ?? opts.env?.STORYOS_RUNNER_ADAPTER);
      }
      if (adapter) {
        if (adapter.id === 'stub') log.warn('Using the STUB adapter: wakes are claimed and reported, but no real work is done.');
        const loop = new ClaimLoop({
          client,
          adapter,
          store: new StateStore(home),
          home,
          workspaceId: config.workspaceId,
          mcpUrl: mcpUrlFor(config.server, opts.mcpUrl ?? config.mcpUrl ?? opts.env?.STORYOS_MCP_URL),
          log,
          concurrency: opts.concurrency ?? 1,
          ...opts.loop,
          ...(opts.sleep ? { sleep: opts.sleep } : {}),
        });
        const f = await loop.run(signal);
        if (f) fail(f);
      }
      stop.abort();
      await heartbeats.catch(() => undefined);
    }
  } finally {
    stop.abort();
    if (existsSync(home.pid) && readPid(home) === process.pid) rmSync(home.pid, { force: true });
  }

  const reason = fatal as FatalReason | null;
  if (reason) {
    if (reason.kind === 'revoked') clearConfig(home);
    io.err(reason.message);
    return reason.kind === 'revoked' ? EXIT.failed : EXIT.outdated;
  }
  log.info('Runner stopped.');
  return EXIT.ok;
}
