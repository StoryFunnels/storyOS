// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CompleteRequest } from './protocol/types.js';

/**
 * Where the Runner keeps its things. Everything is under ONE directory, `~/.storyos-runner` (or `STORYOS_RUNNER_HOME`), created 0700:
 *
 *   config.json   the server, the runner token and who it belongs to. 0600. The token lives ONLY here (no OS keychain in v1).
 *   state.json    the claims this machine holds right now, so a restart never runs a wake twice. 0600.
 *   runner.pid    the running process, so `status` and `stop` can find it and a second `start` refuses.
 *   logs/         the rotating log.
 *   agents/<workspace id>/<agent id>/   each agent's own working folder (ADR-0021 section 6).
 */
export interface RunnerHome {
  dir: string;
  config: string;
  state: string;
  pid: string;
  logs: string;
  logFile: string;
  agents: string;
}

export function runnerHome(env: NodeJS.ProcessEnv = process.env): RunnerHome {
  const dir = env.STORYOS_RUNNER_HOME && env.STORYOS_RUNNER_HOME.trim() ? env.STORYOS_RUNNER_HOME : join(homedir(), '.storyos-runner');
  return {
    dir,
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    pid: join(dir, 'runner.pid'),
    logs: join(dir, 'logs'),
    logFile: join(dir, 'logs', 'runner.log'),
    agents: join(dir, 'agents'),
  };
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/** Write a file that only this user can read, atomically (write a sibling, then rename), and set the mode even if it already existed. */
export function writePrivateFile(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export interface RunnerConfig {
  /** The StoryOS server, e.g. `https://app.storyos.dev`. */
  server: string;
  /** `mn_run_...`. Never printed, never logged. */
  token: string;
  runnerId: string;
  runnerName: string;
  workspaceId: string;
  pairedAt: string;
  /** Set when the person must still press Done in StoryOS. Cleared once the Runner is active. */
  pendingExpiresAt?: string;
  /** Where the tool's MCP server is, if it is not derivable from `server`. */
  mcpUrl?: string;
}

export function readConfig(home: RunnerHome): RunnerConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(home.config, 'utf8')) as Partial<RunnerConfig>;
    if (typeof parsed.server === 'string' && typeof parsed.token === 'string' && typeof parsed.runnerId === 'string') {
      return parsed as RunnerConfig;
    }
  } catch {
    // missing or unreadable: not paired
  }
  return null;
}

export function writeConfig(home: RunnerHome, config: RunnerConfig): void {
  ensureDir(home.dir);
  writePrivateFile(home.config, `${JSON.stringify(config, null, 2)}\n`);
}

export function clearConfig(home: RunnerHome): void {
  rmSync(home.config, { force: true });
}

/** One claim this machine holds. `running` cannot be resumed after a restart; `completing` can, because its result is saved. */
export interface InflightClaim {
  wakeId: string;
  nonce: string;
  runId: string | null;
  agentId: string;
  claimedAt: string;
  phase: 'running' | 'completing';
  /** Present once the adapter has finished: the exact body to (re)send, so a retry is the same request the first one was. */
  completion?: CompleteRequest;
}

export interface RunnerState {
  inflight: InflightClaim[];
}

/**
 * The persisted in-flight claims. A claim is written BEFORE its session starts and its result BEFORE the first attempt to report it, so
 * a crash, a kill or a lost network at any point leaves a record that says what is safe to do next (see `ClaimLoop.recover`).
 */
export class StateStore {
  private state: RunnerState = { inflight: [] };

  constructor(private readonly home: RunnerHome) {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.home.state, 'utf8')) as Partial<RunnerState>;
      if (Array.isArray(parsed.inflight)) this.state = { inflight: parsed.inflight as InflightClaim[] };
    } catch {
      this.state = { inflight: [] };
    }
  }

  private save(): void {
    ensureDir(this.home.dir);
    writePrivateFile(this.home.state, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  list(): InflightClaim[] {
    return this.state.inflight.map((c) => ({ ...c }));
  }

  has(wakeId: string): boolean {
    return this.state.inflight.some((c) => c.wakeId === wakeId);
  }

  put(claim: InflightClaim): void {
    this.state.inflight = [...this.state.inflight.filter((c) => c.wakeId !== claim.wakeId), claim];
    this.save();
  }

  remove(wakeId: string): void {
    if (!this.has(wakeId)) return;
    this.state.inflight = this.state.inflight.filter((c) => c.wakeId !== wakeId);
    this.save();
  }

  exists(): boolean {
    return existsSync(this.home.state);
  }
}
