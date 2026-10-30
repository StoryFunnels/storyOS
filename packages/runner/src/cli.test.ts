// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HELP, main, parseArgs } from './cli.js';
import { tempHome, testIo } from '../test/helpers.js';

let h: ReturnType<typeof tempHome>;
beforeEach(() => (h = tempHome()));
afterEach(() => h.cleanup());

describe('arguments', () => {
  it('parses commands, positionals and flags', () => {
    expect(parseArgs(['pair', 'K7M2QX', '--server', 'https://x.example', '--adapter=stub', '--no-load'])).toEqual({
      command: 'pair',
      positional: ['K7M2QX'],
      flags: { server: 'https://x.example', adapter: 'stub', 'no-load': true },
    });
    expect(parseArgs([])).toEqual({ command: undefined, positional: [], flags: {} });
    expect(parseArgs(['-h']).flags.help).toBe(true);
  });
});

describe('commands', () => {
  const env = () => ({ STORYOS_RUNNER_HOME: h.home.dir });

  it('prints the version and help', async () => {
    const io = testIo();
    expect(await main(['--version'], { io, env: env() })).toBe(0);
    expect(io.lines[0]).toMatch(/^\d+\.\d+\.\d+/);
    const help = testIo();
    expect(await main(['--help'], { io: help, env: env() })).toBe(0);
    expect(help.lines.join('\n')).toBe(HELP.trimEnd());
  });

  it('the one command people are told to run is `npx @storyos/runner`; help leads with it', () => {
    expect(HELP.split('\n').find((l) => l.includes('Usage'))).toBeDefined();
    expect(HELP).toContain('npx @storyos/runner            Pairs this computer');
  });

  it('an unknown command is a usage error, not a crash', async () => {
    const io = testIo();
    expect(await main(['frobnicate'], { io, env: env() })).toBe(2);
    expect(io.errors[0]).toContain('Unknown command');
  });

  it('start and status on an unpaired computer say how to pair', async () => {
    const a = testIo();
    expect(await main(['start'], { io: a, env: env() })).toBe(1);
    expect(a.errors.join(' ')).toContain('npx @storyos/runner');
    const b = testIo();
    expect(await main(['status', '--offline'], { io: b, env: env() })).toBe(1);
    expect(b.lines.join('\n')).toContain('Paired:   no');
  });

  it('stop on a computer with nothing running is not an error', async () => {
    const io = testIo();
    expect(await main(['stop'], { io, env: env() })).toBe(0);
    expect(io.lines.join(' ')).toContain('not running');
  });

  it('pair with no terminal and no code says so instead of hanging', async () => {
    const io = testIo(); // no scripted answers: the prompt rejects, as a non-terminal does
    expect(await main(['pair'], { io, env: env() })).toBe(2);
    expect(io.errors.join(' ')).toContain('No terminal');
  });
});
