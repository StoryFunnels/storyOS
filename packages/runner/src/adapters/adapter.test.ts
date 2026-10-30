// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAdapter } from './index.js';
import { StubAdapter } from './stub.js';
import type { RunnerAdapter, WakeContext } from './types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'storyos-adapter-'));
  mkdirSync(join(dir, 'scratch'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ctx = (): WakeContext => ({
  wakeId: 'w1',
  runId: null,
  reason: 'manual',
  reasons: [],
  depth: 0,
  agent: { id: 'a1', name: 'Sales assistant', goal: null, instructions: '', skills: null, targetDatabases: null },
  mcp: { url: 'https://mcp.example/mcp', token: 'tok_should_never_be_written' },
  workdir: dir,
  allowedNativeTools: [],
  protocol: 1,
});

/** What every adapter must satisfy. Real adapters (#1135, #1136) are run through the same function. */
export async function adapterContract(make: () => RunnerAdapter): Promise<void> {
  const a = make();
  const d = await a.detect(); // never throws
  expect(typeof d.installed).toBe('boolean');
  expect(['full', 'partial', 'none']).toContain(d.capabilities.usageReporting);
  expect(['enforced', 'advisory', 'none']).toContain(d.capabilities.nativeToolAllowlist);

  const result = await a.execute(ctx(), new AbortController().signal);
  expect(['ok', 'error', 'limit_reached', 'aborted', 'timeout']).toContain(result.exit);
  expect(result.usage === null || (Number.isInteger(result.usage.tokensIn) && Number.isInteger(result.usage.tokensOut))).toBe(true);
  expect(typeof result.summary).toBe('string');
  expect(typeof result.toolVersion).toBe('string');

  const early = new AbortController();
  early.abort();
  const stopped = await make().execute(ctx(), early.signal);
  expect(stopped.exit).toBe('aborted'); // an aborted session returns promptly and says so
}

describe('the adapter interface', () => {
  it('the stub satisfies the whole contract', async () => {
    await adapterContract(() => new StubAdapter());
  });

  it('reports usage as null, never zero: it measured nothing', async () => {
    expect((await new StubAdapter().execute(ctx(), new AbortController().signal)).usage).toBeNull();
  });

  it('stops promptly when told to, in the middle of a session', async () => {
    const ctl = new AbortController();
    let aborted = false;
    const run = new StubAdapter({ delayMs: 30_000, onAbort: () => (aborted = true) }).execute(ctx(), ctl.signal);
    setTimeout(() => ctl.abort(), 20);
    const started = Date.now();
    const r = await run;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.exit).toBe('aborted');
    expect(aborted).toBe(true);
  });

  it('writes only inside the agent folder, and never the credential', async () => {
    await new StubAdapter().execute(ctx(), new AbortController().signal);
    const file = readFileSync(join(dir, 'scratch', 'stub-run.txt'), 'utf8');
    expect(file).toContain('Sales assistant');
    expect(file).not.toContain('tok_should_never_be_written');
  });

  it('reports a failure and a limit stop as the contract says', async () => {
    const fail = await new StubAdapter({ exit: 'error' }).execute(ctx(), new AbortController().signal);
    expect(fail).toMatchObject({ exit: 'error', error: expect.any(String) });
    const limit = await new StubAdapter({ exit: 'limit_reached', limitReachedUntil: '2026-11-01T14:00:00.000Z' }).execute(ctx(), new AbortController().signal);
    expect(limit.limitReachedUntil).toBe('2026-11-01T14:00:00.000Z');
  });

  it('the stub is only ever chosen by name; a real tool with no adapter yet gets none', () => {
    expect(resolveAdapter('claude-code', undefined)).toBeNull();
    expect(resolveAdapter('cursor', undefined)).toBeNull();
    expect(resolveAdapter('claude-code', 'stub')?.id).toBe('stub');
    expect(resolveAdapter('claude-code', 'nope')).toBeNull();
  });
});
