// SPDX-License-Identifier: Apache-2.0
import type { Io } from '../io.js';
import type { RunnerHome } from '../store.js';
import { pidAlive, readPid } from './start.js';

export interface StopOptions {
  home: RunnerHome;
  io: Io;
  /** How long to wait for the process to leave. Default 15 s. */
  waitMs?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * `stop`: ask the running Runner to stop (SIGTERM). A session in progress is stopped and its wake is NOT reported: StoryOS puts it
 * back in the queue when the lease lapses (about 90 seconds), so a stop never turns half a run into a "cancelled" one.
 */
export async function stop(opts: StopOptions): Promise<number> {
  const { io, home } = opts;
  const pid = readPid(home);
  if (pid === null || !pidAlive(pid)) {
    io.out('The Runner is not running.');
    return 0;
  }
  (opts.kill ?? ((p, s) => process.kill(p, s)))(pid, 'SIGTERM');
  const until = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < until) {
    if (!pidAlive(pid)) {
      io.out('The Runner stopped.');
      return 0;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  io.err(`The Runner (process ${pid}) is still winding down. If it does not leave, end that process yourself.`);
  return 1;
}
