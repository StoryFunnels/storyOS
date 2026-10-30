// SPDX-License-Identifier: Apache-2.0
import { detectTools } from '../adapters/detect.js';
import { defaultSleep, revokedMessage } from '../claim-loop.js';
import type { Io } from '../io.js';
import { NetworkError, RunnerApiError, RunnerClient } from '../protocol/client.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';
import type { RunnerReport, ToolReport } from '../protocol/types.js';
import { registerSecret } from '../redact.js';
import { clearConfig, readConfig, writeConfig } from '../store.js';
import type { RunnerHome } from '../store.js';
import { machineName, runnerVersion } from '../version.js';

export interface PairOptions {
  home: RunnerHome;
  io: Io;
  server: string;
  /** The code, if it was given on the command line. Otherwise the person is asked. */
  code?: string;
  mcpUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  detect?: () => Promise<ToolReport[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How often the pending status is checked while the person presses Done. Default 2000. */
  pollMs?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export const REPAIR_HINT = 'Run npx @storyos/runner again to get a new code.';

export function describeTools(tools: ToolReport[]): string[] {
  return tools.map((t) => {
    const name = t.name ?? t.id;
    return t.installed ? `  found    ${name}${t.version ? ` ${t.version}` : ''}` : `  missing  ${name}`;
  });
}

/** What the person is told for each way an exchange can fail. Ours, so the command named in it is the one people are told to run. */
export function pairErrorMessage(e: unknown): string {
  if (e instanceof RunnerApiError) {
    switch (e.code) {
      case 'invalid_code':
        return 'That code is not valid. Check it, or start again from "Add a Runner" in StoryOS.';
      case 'pairing_cancelled':
        return `Pairing was cancelled in StoryOS. ${REPAIR_HINT}`;
      case 'pairing_expired':
        return `The pairing window ended before you pressed Done in StoryOS. ${REPAIR_HINT}`;
      case 'code_already_used':
        return `That code was already used. ${REPAIR_HINT}`;
      case 'runner_upgrade_required': {
        const cmd = typeof e.meta.update_command === 'string' ? e.meta.update_command : 'npx @storyos/runner@latest';
        return `This Runner is too old for this StoryOS server. Update it with \`${cmd}\` and try again.`;
      }
      default:
        return e.message;
    }
  }
  if (e instanceof NetworkError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Normalise what was typed: letters and digits only, upper case. The server forgives the same, so a dash or a space never matters. */
export function tidyCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * `pair`: exchange the 6-character code for a Runner token, show what was found on this machine, and wait for the person to press
 * Done in StoryOS (the Runner is PENDING and does nothing until then; ADR-0021 section 3). Returns the exit code.
 */
export async function pair(opts: PairOptions): Promise<number> {
  const { io, home } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const signal = opts.signal ?? new AbortController().signal;

  let code = opts.code ?? '';
  if (!code) {
    try {
      code = await io.prompt('Type the 6-character code StoryOS is showing: ');
    } catch (e) {
      io.err(e instanceof Error ? e.message : String(e));
      return 2;
    }
  }
  code = tidyCode(code);
  if (!code) {
    io.err('No code was given. Open "Add a Runner" in StoryOS to get one.');
    return 2;
  }
  registerSecret(code);

  const tools = await (opts.detect ?? detectTools)();
  io.out('This computer:');
  for (const line of describeTools(tools)) io.out(line);
  if (!tools.some((t) => t.installed)) io.out('  No supported tool was found. Install Claude Code or Cursor, then StoryOS can use this computer.');

  const existing = readConfig(home);
  if (existing) io.out('This computer was paired before. Pairing again replaces that; remove the old one from StoryOS if you no longer need it.');

  const report: RunnerReport = { machine_name: machineName(opts.env), tools, runner_version: runnerVersion(), protocol_version: PROTOCOL_VERSION };
  const client = new RunnerClient({ server: opts.server, runnerVersion: report.runner_version, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  let paired;
  try {
    paired = await client.pair({ ...report, code }, { signal });
  } catch (e) {
    io.err(pairErrorMessage(e));
    return 1;
  }
  registerSecret(paired.token);
  client.setToken(paired.token);
  writeConfig(home, {
    server: opts.server.replace(/\/+$/, ''),
    token: paired.token,
    runnerId: paired.runner.id,
    runnerName: paired.runner.name,
    workspaceId: paired.workspace_id,
    pairedAt: new Date(now()).toISOString(),
    pendingExpiresAt: paired.pending_expires_at,
    ...(opts.mcpUrl ? { mcpUrl: opts.mcpUrl } : {}),
  });

  io.out(`Connected as "${paired.runner.name}". Press Done in StoryOS to turn this computer on.`);
  const deadline = Date.parse(paired.pending_expires_at);
  const interval = opts.pollMs ?? 2000;
  while (!signal.aborted) {
    try {
      const beat = await client.heartbeat(report, { signal });
      if (beat.runner.status === 'active') {
        const cfg = readConfig(home);
        if (cfg) {
          const { pendingExpiresAt: _gone, ...rest } = cfg;
          void _gone;
          writeConfig(home, rest);
        }
        io.out(`Done. This computer is ready${beat.runner.chosen_tool ? ` and will use ${beat.runner.chosen_tool}` : ''}.`);
        return 0;
      }
    } catch (e) {
      if (signal.aborted) return 130;
      if (e instanceof RunnerApiError && e.status === 401) {
        clearConfig(home);
        io.err(revokedMessage(e));
        return 1;
      }
      if (e instanceof RunnerApiError && (e.status === 426 || e.code === 'server_older_than_runner')) {
        io.err(pairErrorMessage(e));
        return 1;
      }
      // A dropped connection while waiting is not the end of the pairing: keep waiting.
    }
    if (Number.isFinite(deadline) && now() > deadline + 5000) {
      clearConfig(home);
      io.err(`The pairing window ended before you pressed Done in StoryOS. ${REPAIR_HINT}`);
      return 1;
    }
    await sleep(interval, signal);
  }
  return 130;
}
