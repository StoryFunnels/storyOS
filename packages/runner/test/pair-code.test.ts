// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { pair, tidyCode } from '../src/commands/pair.js';
import { clearSecrets } from '../src/redact.js';
import { readConfig } from '../src/store.js';
import { FakeServer } from './fake-server.js';
import { FAKE_TOOLS, tempHome, testIo, until } from './helpers.js';

/**
 * Ticket #1209: the code StoryOS shows has no space any more, but people still paste "7PV UVC", type "7pv-uvc" or run
 * `pair 7PV UVC` unquoted. All of them must reach the server as the same 6 characters, and a code that cannot be one is refused
 * in words, before any request.
 */
// `main` does not take a detector, and the real one shells out to the tools on whatever machine runs the tests (about 7 s each).
vi.mock('../src/adapters/detect.js', () => ({ detectTools: async () => [] }));

let server: FakeServer;
let h: ReturnType<typeof tempHome>;
beforeEach(async () => {
  clearSecrets();
  server = new FakeServer();
  await server.listen();
  h = tempHome();
});
afterEach(async () => {
  await server.close();
  h.cleanup();
});

/** The code the server RECEIVED, not what the fake would have forgiven: the fake normalises too, so asserting on its answer proves nothing. */
const received = () => server.callsTo('/pair').map((c) => c.body.code);

describe('tidyCode', () => {
  it.each([
    ['7PV UVC', '7PVUVC'],
    ['7pv-uvc', '7PVUVC'],
    ['7PVUVC', '7PVUVC'],
    ['  7pv \t uvc\n', '7PVUVC'],
    ['7-P V_U.V C', '7PVUVC'],
    ['', ''],
  ])('%j -> %j', (typed, tidy) => expect(tidyCode(typed)).toBe(tidy));
});

describe('pair accepts the code however it was typed', () => {
  it.each([['K7M 2QX'], ['k7m-2qx'], ['K7M2QX'], ['\tk7m 2qx '], ['K7M - 2QX']])('%j pairs, and the server receives K7M2QX', async (typed) => {
    const io = testIo();
    const p = pair({ home: h.home, io, server: server.url, code: typed, detect: async () => FAKE_TOOLS, pollMs: 10 });
    await until(() => server.paired, 'the exchange');
    server.pressDone();
    expect(await p).toBe(0);
    expect(received()).toEqual(['K7M2QX']);
    expect(readConfig(h.home)).not.toBeNull();
  });

  it('asked at the prompt, a code typed with a space pairs too', async () => {
    const io = testIo(['k7m 2qx']);
    const p = pair({ home: h.home, io, server: server.url, detect: async () => FAKE_TOOLS, pollMs: 10 });
    await until(() => server.paired, 'the exchange');
    server.pressDone();
    expect(await p).toBe(0);
    expect(received()).toEqual(['K7M2QX']);
  });
});

describe('pair refuses what cannot be a code, in words, without a request', () => {
  it.each([['K7M2Q'], ['K7M2QXZ'], ['K7M 2Q'], ['---']])('%j', async (typed) => {
    const io = testIo();
    const exit = await pair({ home: h.home, io, server: server.url, code: typed, detect: async () => FAKE_TOOLS });
    expect(exit).toBe(2);
    expect(server.calls).toHaveLength(0);
    expect(readConfig(h.home)).toBeNull();
  });

  it('names how many characters it got and how many it wants', async () => {
    const io = testIo();
    await pair({ home: h.home, io, server: server.url, code: 'K7M 2Q', detect: async () => FAKE_TOOLS });
    expect(io.errors.join(' ')).toContain('That code has 5 characters; the code in StoryOS has 6.');
  });

  it('a wrong 6-character code still reaches the server and is refused there', async () => {
    const io = testIo();
    expect(await pair({ home: h.home, io, server: server.url, code: 'ZZZ ZZZ', detect: async () => FAKE_TOOLS })).toBe(1);
    expect(received()).toEqual(['ZZZZZZ']);
    expect(io.errors.join(' ')).toContain('not valid');
  });
});

describe('the command line', () => {
  const run = async (argv: string[]) => {
    const calls: Array<Record<string, unknown>> = [];
    const io = testIo();
    const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
      calls.push(JSON.parse(init?.body ?? '{}'));
      return new Response(JSON.stringify({ error: { code: 'invalid_code', message: 'no', request_id: 'r' } }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const exit = await main(argv, { io, env: { STORYOS_RUNNER_HOME: h.home.dir }, fetchImpl });
    return { exit, calls, io };
  };

  it.each([
    [['pair', '7PV UVC']],
    [['pair', '7PV', 'UVC']],
    [['pair', '7pv-uvc']],
    [['pair', '7PVUVC']],
    [['pair', '7pv', '-', 'uvc']],
  ])('%j sends 7PVUVC', async (argv) => {
    const { calls } = await run(argv);
    expect(calls.map((c) => c.code)).toEqual(['7PVUVC']);
  });

  it('three groups are still more than a code', async () => {
    const { exit, calls } = await run(['pair', '7PV', 'UVC', 'XYZ']);
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
