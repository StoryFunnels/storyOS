// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ToolReport } from '../protocol/types.js';

/**
 * Which vendor tools are on this machine. Pairing shows the person what the Runner found, and the server stores it so the app can
 * ask "which should agents use?". This only LOOKS: it never logs in, never starts a session, never reads a tool's config.
 *
 * `logged_in` is reported ONLY where the tool says so itself: `claude auth status` prints `loggedIn`. It is a statement about a stored
 * login, not a working token (a login whose token has expired still says true: seen on the machine ticket #1135 was built on), and an
 * unknown stays absent, never a yes.
 */
const CANDIDATES: Array<{ id: string; name: string; bins: string[] }> = [
  { id: 'claude-code', name: 'Claude Code', bins: ['claude'] },
  { id: 'cursor', name: 'Cursor', bins: ['cursor-agent', 'cursor'] },
];

export function findOnPath(bin: string, pathVar: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

function versionOf(file: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined);
      const match = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(String(stdout));
      resolve(match ? match[0] : undefined);
    });
  });
}

function loggedInOf(file: string): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    execFile(file, ['auth', 'status'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(undefined);
      try {
        const v = (JSON.parse(String(stdout)) as { loggedIn?: unknown }).loggedIn;
        resolve(typeof v === 'boolean' ? v : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export async function detectTools(pathVar: string | undefined = process.env.PATH): Promise<ToolReport[]> {
  const out: ToolReport[] = [];
  for (const tool of CANDIDATES) {
    let file: string | null = null;
    for (const bin of tool.bins) {
      file = findOnPath(bin, pathVar);
      if (file) break;
    }
    if (!file) {
      out.push({ id: tool.id, name: tool.name, installed: false });
      continue;
    }
    const version = await versionOf(file);
    const loggedIn = tool.id === 'claude-code' ? await loggedInOf(file) : undefined;
    out.push({ id: tool.id, name: tool.name, installed: true, ...(version ? { version } : {}), ...(loggedIn !== undefined ? { logged_in: loggedIn } : {}) });
  }
  return out;
}
