// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CODE, FakeServer, TOKEN } from './fake-server.js';
import { until } from './helpers.js';

/**
 * The BUILT binary, as a person runs it, against the fake server: pair with a code, press Done, start, claim a wake, run it with the
 * stub adapter, report, status, refuse a second copy, stop on SIGTERM. The package is compiled to a temp folder first so this test
 * does not depend on `pnpm build` having run.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let out: string;
let bin: string;
let server: FakeServer;
let home: string;

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d));
    p.stderr.on('data', (d: Buffer) => (stderr += d));
    p.on('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'storyos-runner-bin-build-'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const built = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.build.json'), '--outDir', join(out, 'dist'), '--declaration', 'false'], { cwd: root, encoding: 'utf8' });
  if (built.status !== 0) throw new Error(`could not compile the package: ${built.stdout}${built.stderr}`);
  bin = join(out, 'dist', 'index.js');
  server = new FakeServer();
  await server.listen();
  home = mkdtempSync(join(tmpdir(), 'storyos-runner-bin-home-'));
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(out, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('the built binary', () => {
  it('pairs, starts, claims, runs the stub, reports, and stops', async () => {
    const env = { ...process.env, STORYOS_RUNNER_HOME: home, STORYOS_URL: server.url, STORYOS_RUNNER_NAME: 'Binary Test Mac' };

    const pairing = run(['pair', CODE.toLowerCase()], env);
    await until(() => server.paired, 'the exchange');
    server.pressDone();
    const paired = await pairing;
    expect(paired.status).toBe(0);
    expect(paired.stdout).toContain('Press Done in StoryOS');
    expect(paired.stdout).toContain('Done. This computer is ready');
    expect(paired.stdout + paired.stderr).not.toContain(TOKEN);
    expect((paired.stdout + paired.stderr).toUpperCase()).not.toContain(CODE);
    expect(statSync(join(home, 'config.json')).mode & 0o777).toBe(0o600);

    const wake = server.enqueue();
    const runner: ChildProcess = spawn(process.execPath, [bin, 'start', '--adapter', 'stub'], { env });
    const exited = new Promise<number | null>((resolve) => runner.on('exit', resolve));
    await until(() => wake.completions.length === 1, 'the stub run to be reported', 15_000);
    expect(wake.completions[0]).toMatchObject({ exit: 'ok', usage: null, tool_version: 'stub-1' });

    const status = await run(['status'], env);
    expect(status.stdout).toContain('Running:  yes');
    expect(status.stdout).toContain('Server:   reachable');
    expect(status.stdout).not.toContain(TOKEN);

    const second = await run(['start'], env);
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already running');

    const stopped = await run(['stop'], env);
    expect(stopped.status).toBe(0);
    expect(await exited).toBe(0);
    expect(existsSync(join(home, 'runner.pid'))).toBe(false);

    const log = readFileSync(join(home, 'logs', 'runner.log'), 'utf8');
    expect(log).toContain('claimed wake');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('secretsecret');
  }, 60_000);
});
