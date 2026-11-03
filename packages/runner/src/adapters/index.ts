// SPDX-License-Identifier: Apache-2.0
import type { Logger } from '../log.js';
import { ClaudeCodeAdapter, DEFAULT_RUN_TIMEOUT_MS } from './claude-code/index.js';
import { StubAdapter } from './stub.js';
import type { RunnerAdapter } from './types.js';

export interface ResolveOptions {
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  /** `--run-timeout <minutes>`; wins over the environment. */
  runTimeoutMinutes?: number;
}

/** The wall-clock limit for one run, in ms: the flag, then STORYOS_RUNNER_RUN_TIMEOUT_MINUTES, then 30 minutes. Zero or junk falls back. */
export function runTimeoutMs(options: ResolveOptions): number {
  const fromEnv = Number.parseFloat(options.env?.STORYOS_RUNNER_RUN_TIMEOUT_MINUTES ?? '');
  const minutes = options.runTimeoutMinutes && options.runTimeoutMinutes > 0 ? options.runTimeoutMinutes : fromEnv > 0 ? fromEnv : undefined;
  return minutes ? Math.round(minutes * 60_000) : DEFAULT_RUN_TIMEOUT_MS;
}

/**
 * Which adapter serves which chosen tool. `claude-code` (ticket #1135) follows the tool the person chose in StoryOS; the stub exists
 * only when it is asked for by name (`--adapter stub` or `STORYOS_RUNNER_ADAPTER=stub`). `--adapter claude-code` forces Claude Code
 * whatever was chosen. Cursor is ticket #1136: a Runner whose chosen tool has no adapter yet claims nothing and says so.
 */
export function resolveAdapter(chosenTool: string | null, override: string | undefined, options: ResolveOptions = {}): RunnerAdapter | null {
  const claude = () =>
    new ClaudeCodeAdapter({
      timeoutMs: runTimeoutMs(options),
      ...(options.log ? { log: options.log } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.env?.STORYOS_RUNNER_CLAUDE_BIN ? { binary: options.env.STORYOS_RUNNER_CLAUDE_BIN } : {}),
      ...(options.env?.STORYOS_RUNNER_CLAUDE_KEEP_API_KEY === '1' ? { keepApiKey: true } : {}),
    });
  if (override === 'stub') return new StubAdapter();
  if (override === 'claude-code') return claude();
  if (override) return null;
  if (chosenTool === 'claude-code') return claude();
  return null;
}
