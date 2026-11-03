// SPDX-License-Identifier: Apache-2.0
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Where a smoke run keeps what it creates, and the ONLY way it cleans up.
 *
 * Why this exists: an earlier cleanup deleted every `storyos-smoke-runner-*` directory under the OS temp dir, which can destroy the
 * throwaway Runner homes of OTHER sessions. So: the run makes ONE parent directory with `mkdtemp`, records its exact path, tracks
 * every path and process it creates, and removes only those. A path outside that root is refused, never deleted. There is no glob and
 * no "everything that looks like ours".
 */
export interface RunDir {
  /** The exact directory this run owns. Print it. */
  readonly root: string;
  /** A path inside the root (not created). Throws for a name that would leave it. */
  path(...parts: string[]): string;
  /** Register a file or directory this run created. Throws if it is not inside the root. */
  track(p: string): string;
  /** Register a child process this run started; cleanup stops it first. */
  trackProcess(child: Pick<ChildProcess, 'pid' | 'kill' | 'exitCode'>): void;
  /** Stop tracked processes, delete tracked paths, then the root. Returns what happened; refusals are reported, never silent. */
  cleanup(): CleanupReport;
}

export interface CleanupReport {
  deleted: string[];
  refused: string[];
  stopped: number[];
}

export const RUN_DIR_PREFIX = 'storyos-smoke-runner-';

export function createRunDir(parent: string = tmpdir()): RunDir {
  const base = realpathSync(parent);
  const root = realpathSync(mkdtempSync(join(base, RUN_DIR_PREFIX)));
  const tracked = new Set<string>();
  const procs: Array<Pick<ChildProcess, 'pid' | 'kill' | 'exitCode'>> = [];

  const inside = (p: string): boolean => {
    const abs = resolve(p);
    return abs !== root && abs.startsWith(root + sep);
  };
  const path = (...parts: string[]): string => {
    const p = resolve(root, ...parts);
    if (!inside(p)) throw new Error(`Refusing a path outside this run's directory (${root}): ${p}`);
    return p;
  };

  return {
    root,
    path,
    track(p) {
      const abs = resolve(p);
      if (!inside(abs)) throw new Error(`Refusing to track a path outside this run's directory (${root}): ${abs}`);
      tracked.add(abs);
      return abs;
    },
    trackProcess(child) {
      procs.push(child);
    },
    cleanup() {
      const report: CleanupReport = { deleted: [], refused: [], stopped: [] };
      for (const child of procs) {
        if (child.pid && child.exitCode === null) {
          child.kill('SIGTERM');
          report.stopped.push(child.pid);
        }
      }
      // Deepest paths first, each checked again at the moment of deletion.
      for (const p of [...tracked].sort((a, b) => b.length - a.length)) {
        if (!inside(p)) report.refused.push(p);
        else {
          rmSync(p, { recursive: true, force: true });
          report.deleted.push(p);
        }
      }
      // The root itself: only if it is still exactly the directory mkdtemp made, directly under the temp dir we started from.
      if (dirname(root) === base && basename(root).startsWith(RUN_DIR_PREFIX)) {
        rmSync(root, { recursive: true, force: true });
        report.deleted.push(root);
      } else report.refused.push(root);
      return report;
    },
  };
}
