// SPDX-License-Identifier: Apache-2.0
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AdapterResult, Detection, RunnerAdapter, WakeContext } from './types.js';

export interface StubOptions {
  /** How long the pretend session takes. */
  delayMs?: number;
  /** What the pretend session ends with. */
  exit?: AdapterResult['exit'];
  limitReachedUntil?: string;
  /** Called when a session starts and when it is told to stop: tests watch these. */
  onStart?: (wake: WakeContext) => void;
  onAbort?: (wake: WakeContext) => void;
}

/**
 * The stub adapter: it does no work. It proves the loop (claim, folder, lease, report) end to end without a vendor tool, and it is
 * what `--adapter stub` selects for a dry run. The real Claude Code adapter is ticket #1135, Cursor is #1136.
 *
 * It honours the whole contract: it writes only inside its working folder, reports `usage: null` (it measured nothing, so it must not
 * say zero), and stops promptly when told to.
 */
export class StubAdapter implements RunnerAdapter {
  readonly id = 'stub' as const;

  constructor(private readonly options: StubOptions = {}) {}

  async detect(): Promise<Detection> {
    return {
      installed: true,
      version: 'stub-1',
      loggedIn: true,
      capabilities: { usageReporting: 'none', limitDetection: false, nativeToolAllowlist: 'none', mcpInjection: false, headless: true },
    };
  }

  async execute(wake: WakeContext, signal: AbortSignal): Promise<AdapterResult> {
    this.options.onStart?.(wake);
    const stopped = await sleepOrAbort(this.options.delayMs ?? 0, signal);
    if (stopped) {
      this.options.onAbort?.(wake);
      return { exit: 'aborted', usage: null, summary: 'The stub session was stopped.', toolVersion: 'stub-1' };
    }
    // Proof of work in the agent's own folder, and nothing about the credential: the stub never touches `wake.mcp.token`.
    await writeFile(join(wake.workdir, 'scratch', 'stub-run.txt'),`stub adapter ran wake ${wake.wakeId} for agent ${wake.agent.name}\n`, { mode: 0o600 });
    const exit = this.options.exit ?? 'ok';
    return {
      exit,
      usage: null,
      summary: `Stub adapter ran wake ${wake.wakeId} (${wake.reason}) for agent "${wake.agent.name}". It did no real work.`,
      ...(exit === 'limit_reached' && this.options.limitReachedUntil ? { limitReachedUntil: this.options.limitReachedUntil } : {}),
      ...(exit === 'error' ? { error: 'The stub was told to fail.' } : {}),
      toolVersion: 'stub-1',
    };
  }
}

function sleepOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  if (ms <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
