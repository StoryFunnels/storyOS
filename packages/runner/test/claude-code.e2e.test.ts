// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { start } from '../src/commands/start.js';
import { clearSecrets } from '../src/redact.js';
import { writeConfig } from '../src/store.js';
import { FakeServer, TOKEN } from './fake-server.js';
import { FAKE_TOOLS, FAST, readText, tempHome, testIo, until } from './helpers.js';

/**
 * The whole path with the Claude Code adapter chosen the way a person chooses it: the server says `chosen_tool: claude-code`, the
 * Runner builds the adapter itself (nothing injected), claims a wake from a fake StoryOS, runs a FAKE `claude` and reports. What this
 * does not show: a real `claude` (it was logged out on the build machine) and the real server's requeue (see the PR's NOT VERIFIED).
 */
const FAKE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

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
  server.runnerStatus = 'active';
  writeConfig(h.home, { server: server.url, token: TOKEN, runnerId: 'runner-1', runnerName: 'Test', workspaceId: server.workspaceId, pairedAt: new Date().toISOString() });
});
afterEach(async () => {
  stop.abort();
  await running?.catch(() => undefined);
  running = null;
  await server.close();
  h.cleanup();
});

function runner(mode: string, extraEnv: Record<string, string> = {}) {
  const io = testIo();
  running = start({
    home: h.home,
    io,
    signal: stop.signal,
    detect: async () => FAKE_TOOLS,
    env: { ...process.env, STORYOS_RUNNER_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: mode, ...extraEnv },
    ...FAST,
  });
  return io;
}

describe('Claude Code adapter through the claim loop', () => {
  it('a wake runs, and the report carries tokens, the session id and the summary', async () => {
    const wake = server.enqueue();
    const io = runner('success');
    await until(() => wake.completions.length === 1, 'the report');
    const c = wake.completions[0]!;
    expect(c).toMatchObject({ exit: 'ok', usage: { tokens_in: 600, tokens_out: 77 }, session_id: '5b2f7f6e-3c1a-4e55-9a37-0f1c2d3e4a5b', tool_version: 'claude-code 2.1.104' });
    expect(c.summary).toBe('Commented on #12 and moved it to Review.');
    const log = readText(h.home.logFile);
    expect(log).toContain('claude-code ok');
    for (const text of [io.all(), log]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('SECRET-LOOKING-INPUT-NEVER-LOGGED');
    }
  });

  it('a limit stop is reported with the reset time (the server then queues the wake until then)', async () => {
    const wake = server.enqueue();
    const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
    runner('limit', { FAKE_CLAUDE_RESET: String(reset) });
    await until(() => wake.completions.length === 1, 'the report');
    expect(wake.completions[0]).toMatchObject({ exit: 'limit_reached', limit_reached_until: new Date(reset * 1000).toISOString() });
  });

  it('the credential the server issued reaches the session through its environment and nowhere else it could be read afterwards', async () => {
    const wake = server.enqueue();
    runner('success');
    await until(() => wake.completions.length === 1, 'the report');
    const folder = join(h.home.agents, server.workspaceId, wake.agentId);
    // The MCP config file is gone, and the log has no credential.
    expect(readText(join(folder, `.storyos-mcp-${wake.id}.json`))).toBe('');
    expect(readText(h.home.logFile)).not.toMatch(/mn_(run|agt)_[A-Za-z0-9]{8,}/);
  });
});
