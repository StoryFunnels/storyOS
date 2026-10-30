// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ToolReport } from '../protocol/types.js';

/**
 * Which vendor tools are on this machine. Pairing shows the person what the Runner found, and the server stores it so the app can
 * ask "which should agents use?". This only LOOKS: it never logs in, never starts a session, never reads a tool's config.
 *
 * `logged_in` is left out on purpose: no tool's login state is verified here, and an unknown must not read as a yes. The real
 * adapters (#1135, #1136) report it from `detect()` once they have checked how.
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
    out.push({ id: tool.id, name: tool.name, installed: true, ...(version ? { version } : {}) });
  }
  return out;
}
