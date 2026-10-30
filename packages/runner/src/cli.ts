// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from 'node:fs';
import type { Io } from './io.js';
import { installAutostart, uninstallAutostart } from './commands/autostart.js';
import { pair } from './commands/pair.js';
import { EXIT, start } from './commands/start.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { readConfig, runnerHome } from './store.js';
import { DEFAULT_SERVER, runnerVersion } from './version.js';

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUE_FLAGS = new Set(['server', 'adapter', 'concurrency', 'mcp-url']);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) flags[name] = argv[++i]!;
      else flags[name] = true;
    } else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else positional.push(a);
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

export const HELP = `StoryOS Runner: runs your hired agents on this computer, inside your own Claude Code or Cursor.

Usage
  npx @storyos/runner            Pairs this computer if it is not paired yet, then starts.

For scripts and the server guide
  storyos-runner pair [code]     Pair with the 6-character code from "Add a Runner" in StoryOS
  storyos-runner start           Run the claim loop in the foreground
  storyos-runner status          Show what this computer knows, and check the server
  storyos-runner stop            Ask the running Runner to stop
  storyos-runner install-autostart [--print] [--no-load]
  storyos-runner uninstall-autostart

Options
  --server <url>        The StoryOS server (default ${DEFAULT_SERVER}; or STORYOS_URL)
  --concurrency <n>     Wakes to run at once on this computer (default 1)
  --adapter stub        A dry run: claims and reports wakes, does no real work
  --mcp-url <url>       Where the tool reaches StoryOS's MCP server (or STORYOS_MCP_URL)
  --version, --help
`;

export interface MainContext {
  io: Io;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function main(argv: string[], ctx: MainContext): Promise<number> {
  const env = ctx.env ?? process.env;
  const { io } = ctx;
  const args = parseArgs(argv);
  if (args.flags.version) {
    io.out(runnerVersion());
    return 0;
  }
  if (args.flags.help || args.command === 'help') {
    io.out(HELP.trimEnd());
    return 0;
  }
  const home = runnerHome(env);
  const server = (typeof args.flags.server === 'string' ? args.flags.server : env.STORYOS_URL || DEFAULT_SERVER).replace(/\/+$/, '');
  const mcpUrl = typeof args.flags['mcp-url'] === 'string' ? args.flags['mcp-url'] : env.STORYOS_MCP_URL;
  const signal = ctx.signal ?? new AbortController().signal;
  const common = { home, io, env, ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) };
  const startOptions = () => {
    const concurrency = typeof args.flags.concurrency === 'string' ? Number.parseInt(args.flags.concurrency, 10) : undefined;
    const adapter = typeof args.flags.adapter === 'string' ? args.flags.adapter : undefined;
    return {
      ...common,
      signal,
      ...(concurrency && concurrency > 0 ? { concurrency } : {}),
      ...(adapter ? { adapterOverride: adapter } : {}),
      ...(mcpUrl ? { mcpUrl } : {}),
    };
  };

  switch (args.command) {
    case undefined: {
      if (!readConfig(home)) {
        const code = await pair({ ...common, server, ...(mcpUrl ? { mcpUrl } : {}), signal });
        if (code !== 0) return code;
      }
      return start(startOptions());
    }
    case 'pair': {
      const code = args.positional[0];
      return pair({ ...common, server, ...(code ? { code } : {}), ...(mcpUrl ? { mcpUrl } : {}), signal });
    }
    case 'start':
      return start(startOptions());
    case 'status':
      return status({ ...common, offline: args.flags.offline === true });
    case 'stop':
      return stop({ home, io });
    case 'install-autostart':
    case 'uninstall-autostart': {
      const scriptPath = safeRealpath(process.argv[1] ?? '');
      const opts = { home, io, env, scriptPath, ...(args.flags.print === true ? { print: true } : {}), ...(args.flags['no-load'] === true ? { noLoad: true } : {}) };
      return args.command === 'install-autostart' ? installAutostart(opts) : uninstallAutostart(opts);
    }
    default:
      io.err(`Unknown command "${args.command}".`);
      io.err(HELP.trimEnd());
      return EXIT.usage;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
