// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRunDir, RUN_DIR_PREFIX } from '../src/smoke-run-dir.js';
import { until } from './helpers.js';

/** The tests use their OWN parent directory, so nothing here can touch a real temp dir another session is using. */
let parent: string;
beforeEach(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'storyos-rundir-test-')));
});
afterEach(() => rmSync(parent, { recursive: true, force: true }));

describe('the smoke run directory', () => {
  it('cleans up only what it made: a sibling with the same prefix survives', () => {
    const sibling = join(parent, `${RUN_DIR_PREFIX}OTHER`);
    mkdirSync(join(sibling, 'logs'), { recursive: true });
    writeFileSync(join(sibling, 'logs', 'runner.log'), "another session's log");
    const unrelated = join(parent, 'unrelated');
    mkdirSync(unrelated);

    const run = createRunDir(parent);
    expect(run.root.startsWith(join(parent, RUN_DIR_PREFIX))).toBe(true);
    expect(run.root).not.toBe(sibling);
    const home = run.track(run.path('home'));
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(join(home, 'logs', 'runner.log'), 'mine');

    const report = run.cleanup();
    expect(existsSync(run.root)).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(report.deleted).toContain(run.root);
    expect(report.refused).toEqual([]);
    // The other session's directory, and everything else, is untouched.
    expect(existsSync(join(sibling, 'logs', 'runner.log'))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('refuses a path outside its own root, whether tracked or asked for', () => {
    const run = createRunDir(parent);
    const sibling = join(parent, `${RUN_DIR_PREFIX}OTHER`);
    mkdirSync(sibling);
    expect(() => run.track(sibling)).toThrow(/outside this run's directory/);
    expect(() => run.track(parent)).toThrow(/outside/);
    expect(() => run.track(run.root)).toThrow(/outside/); // the root is removed by cleanup itself, not as a tracked path
    expect(() => run.path('..', `${RUN_DIR_PREFIX}OTHER`)).toThrow(/outside/);
    expect(() => run.path('home', '..', '..', 'unrelated')).toThrow(/outside/);
    run.cleanup();
    expect(existsSync(sibling)).toBe(true);
  });

  it('stops the processes it started, and only those', async () => {
    const run = createRunDir(parent);
    const mine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      run.trackProcess(mine);
      const report = run.cleanup();
      expect(report.stopped).toEqual([mine.pid]);
      await until(() => mine.exitCode !== null || mine.signalCode !== null, 'the tracked process to stop');
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
    } finally {
      other.kill('SIGKILL');
      mine.kill('SIGKILL');
    }
  });

  it('every run gets its own directory', () => {
    const a = createRunDir(parent);
    const b = createRunDir(parent);
    expect(a.root).not.toBe(b.root);
    a.cleanup();
    expect(existsSync(b.root)).toBe(true);
    b.cleanup();
  });
});
