// SPDX-License-Identifier: Apache-2.0
import { classifyFatal, describe } from '../claim-loop.js';
import type { Io } from '../io.js';
import { RunnerClient } from '../protocol/client.js';
import { PROTOCOL_VERSION } from '../protocol/types.js';
import { registerSecret } from '../redact.js';
import { StateStore, readConfig } from '../store.js';
import type { RunnerHome } from '../store.js';
import { detectTools } from '../adapters/detect.js';
import { machineName, runnerVersion } from '../version.js';
import { describeTools } from './pair.js';
import { pidAlive, readPid } from './start.js';

export interface StatusOptions {
  home: RunnerHome;
  io: Io;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** Skip the live check against the server. */
  offline?: boolean;
}

/** `status`: what this computer knows about itself, plus a live check. Prints no token, no code, no credential. */
export async function status(opts: StatusOptions): Promise<number> {
  const { io, home } = opts;
  const config = readConfig(home);
  io.out(`StoryOS Runner ${runnerVersion()}`);
  if (!config) {
    io.out('Paired:   no. Run npx @storyos/runner to pair this computer.');
    return 1;
  }
  registerSecret(config.token);
  io.out(`Paired:   yes, as "${config.runnerName}" with ${config.server}`);
  const pid = readPid(home);
  const alive = pid !== null && pidAlive(pid);
  io.out(`Running:  ${alive ? `yes (process ${pid})` : 'no'}`);
  const inflight = new StateStore(home).list();
  io.out(`Claims:   ${inflight.length === 0 ? 'none in flight' : `${inflight.length} in flight (${inflight.map((c) => c.phase).join(', ')})`}`);
  io.out(`Log:      ${home.logFile}`);
  const tools = await detectTools();
  io.out('Tools on this computer:');
  for (const line of describeTools(tools)) io.out(line);
  if (opts.offline) return 0;

  const client = new RunnerClient({ server: config.server, token: config.token, runnerVersion: runnerVersion(), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  try {
    const beat = await client.heartbeat({ machine_name: machineName(opts.env), tools, runner_version: runnerVersion(), protocol_version: PROTOCOL_VERSION }, { timeoutMs: 10_000 });
    io.out(`Server:   reachable. This Runner is ${beat.runner.status}${beat.runner.chosen_tool ? `, using ${beat.runner.chosen_tool}` : ''}; ${beat.assigned_agents.length} agent(s) assigned.`);
    return 0;
  } catch (e) {
    const fatal = classifyFatal(e);
    io.out(`Server:   ${fatal ? fatal.message : describe(e)}`);
    return 1;
  }
}
