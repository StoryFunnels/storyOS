#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { main } from './cli.js';
import { terminalIo } from './io.js';

const controller = new AbortController();
// SIGTERM is `stop` (and launchd/systemd shutting down); SIGINT is Ctrl-C. Both ask the loop to wind down: running sessions are told
// to stop and their wakes are NOT reported, so StoryOS requeues them when the lease lapses.
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => controller.abort());

main(process.argv.slice(2), { io: terminalIo(), signal: controller.signal }).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
