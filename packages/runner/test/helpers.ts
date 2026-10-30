// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Io } from '../src/io.js';
import type { RunnerHome } from '../src/store.js';
import { runnerHome } from '../src/store.js';
import type { ToolReport } from '../src/protocol/types.js';

export interface TestIo extends Io {
  lines: string[];
  errors: string[];
  answers: string[];
  all(): string;
}

export function testIo(answers: string[] = []): TestIo {
  const lines: string[] = [];
  const errors: string[] = [];
  const queue = [...answers];
  return {
    lines,
    errors,
    answers: queue,
    out: (l) => void lines.push(l),
    err: (l) => void errors.push(l),
    prompt: async (q) => {
      lines.push(q);
      const a = queue.shift();
      if (a === undefined) throw new Error('No terminal to ask on.');
      return a;
    },
    all: () => [...lines, ...errors].join('\n'),
  };
}

export function tempHome(): { home: RunnerHome; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'storyos-runner-test-'));
  return { home: runnerHome({ STORYOS_RUNNER_HOME: dir }), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const FAKE_TOOLS: ToolReport[] = [
  { id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104' },
  { id: 'cursor', name: 'Cursor', installed: false },
];

export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** Fast settings for tests: short polls, short backoff, short heartbeats. */
export const FAST = {
  heartbeatMs: 40,
  loop: { claimWaitSeconds: 0.25, minPollIntervalMs: 10, backoff: { minMs: 15, maxMs: 60 } },
} as const;
