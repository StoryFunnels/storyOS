// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';

/**
 * The only place the adapter touches an operating-system process. Everything else is a pure function of what this returns, so the
 * adapter is tested with a real child process (a fake `claude` script) or, for the pure parts, with no process at all.
 */
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin, then closed. The task text goes here, never in argv. */
  stdin: string;
  /** A hard wall-clock limit. At the limit the whole process group is killed. */
  timeoutMs: number;
  signal: AbortSignal;
  /** Called once per complete stdout line (the CLI's stream-json is one event per line). */
  onStdoutLine: (line: string) => void;
}

export interface SpawnOutcome {
  code: number | null;
  /** The signal that ended it, if any. */
  killedBy: string | null;
  timedOut: boolean;
  aborted: boolean;
  /** The tail of stderr, capped. NOT yet redacted: the adapter redacts before anything leaves it. */
  stderr: string;
  /** Set when the process could not be started at all (no such file, not executable). */
  spawnError?: string;
}

export type ProcessRunner = (spec: SpawnSpec) => Promise<SpawnOutcome>;

export const STDERR_CAP = 16_000;
const LINE_CAP = 8_000_000;
/** After SIGTERM, how long a child gets before SIGKILL. */
const KILL_GRACE_MS = 1_500;
/** After SIGKILL, how long to wait for the pipes to close before giving up on them. */
const CLOSE_WAIT_MS = 3_000;

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    // A negative pid is the whole process group: the tool and every helper it started (a shell, a language server, an MCP stdio child).
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

export const runProcess: ProcessRunner = (spec) =>
  new Promise<SpawnOutcome>((resolve) => {
    let timedOut = false;
    let aborted = false;
    let stderr = '';
    let settled = false;
    let buffer = '';
    let dropping = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group, so a timeout can take the whole tree down and not just the top process.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      resolve({ code: null, killedBy: null, timedOut: false, aborted: false, stderr: '', spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }

    const finish = (outcome: SpawnOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardStop);
      spec.signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    let hardStop: NodeJS.Timeout | undefined;
    const stop = (): void => {
      killGroup(child.pid, 'SIGTERM');
      const killer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
      killer.unref();
      // If the pipes never close (a grandchild kept them), do not hang the Runner on them.
      hardStop = setTimeout(() => finish({ code: null, killedBy: 'SIGKILL', timedOut, aborted, stderr }), KILL_GRACE_MS + CLOSE_WAIT_MS);
      hardStop.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    if (spec.signal.aborted) onAbort();
    else spec.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => finish({ code: null, killedBy: null, timedOut, aborted, stderr, spawnError: e.message }));

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (dropping) dropping = false; // the tail of an over-long line
        else if (line.trim()) spec.onStdoutLine(line);
        nl = buffer.indexOf('\n');
      }
      if (buffer.length > LINE_CAP) {
        buffer = '';
        dropping = true;
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_CAP);
    });

    child.on('close', (code, sig) => {
      if (buffer.trim() && !dropping) spec.onStdoutLine(buffer);
      finish({ code, killedBy: sig, timedOut, aborted, stderr });
    });

    // The child may exit before reading its stdin: EPIPE is not an error worth failing the run for.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(spec.stdin);
  });
