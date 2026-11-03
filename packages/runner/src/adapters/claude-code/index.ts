// SPDX-License-Identifier: Apache-2.0
import { execFile } from 'node:child_process';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact, registerSecret } from '../../redact.js';
import { nullLogger } from '../../log.js';
import type { Logger } from '../../log.js';
import { findOnPath } from '../detect.js';
import type { AdapterResult, Detection, RunnerAdapter, WakeContext } from '../types.js';
import { interpret, newStreamState, readLine, usageOf } from './events.js';
import { runProcess } from './process.js';
import type { ProcessRunner } from './process.js';
import { MCP_BLOCKING_ENV } from './pins.js';
import { buildSystemPrompt, buildTaskText, newDataMarker } from './prompt.js';
import { buildToolPolicy, MCP_SERVER_NAME } from './tools.js';

/**
 * The Claude Code adapter (ticket #1135, ADR-0021 sections 5-7): runs the customer's own logged-in `claude` CLI, headless, once per
 * wake, in the agent's folder, on the customer's own subscription.
 *
 * What it does NOT do, on purpose: it never logs in (it does not touch the CLI's credentials), never uses `--bare` (that mode never
 * reads the subscription login), never uses `bypassPermissions` or `--dangerously-skip-permissions`, never resumes a session, and
 * never puts the run credential in argv or in a file.
 */
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
/** The name of the environment variable the MCP config refers to. The config file holds this NAME, never the credential. */
export const TOKEN_ENV = 'STORYOS_RUN_TOKEN';

export interface ClaudeCodeOptions {
  /** Path to the `claude` executable. Default: found on PATH at the time it is needed. */
  binary?: string;
  /** A hard wall-clock limit for one run. Default 30 minutes. */
  timeoutMs?: number;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  /** The process seam. Tests use the real one with a fake executable; nothing else replaces it. */
  run?: ProcessRunner;
  now?: () => number;
  /** Let the CLI bill an API key found in the environment instead of the subscription. Off: the point of this adapter is the subscription. */
  keepApiKey?: boolean;
}

/** Environment the session must NOT inherit: it would redirect the CLI away from the subscription, or hand it StoryOS secrets. */
const STRIPPED = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'STORYOS_RUNNER_TOKEN', 'STORYOS_RUN_TOKEN'];

export class ClaudeCodeAdapter implements RunnerAdapter {
  readonly id = 'claude-code' as const;
  private readonly log: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly run: ProcessRunner;
  private readonly now: () => number;

  constructor(private readonly options: ClaudeCodeOptions = {}) {
    this.log = options.log ?? nullLogger;
    this.env = options.env ?? process.env;
    this.run = options.run ?? runProcess;
    this.now = options.now ?? Date.now;
  }

  private binary(): string | null {
    return this.options.binary ?? findOnPath('claude', this.env.PATH);
  }

  async detect(): Promise<Detection> {
    const capabilities: Detection['capabilities'] = { usageReporting: 'full', limitDetection: true, nativeToolAllowlist: 'enforced', mcpInjection: true, headless: true };
    const file = this.binary();
    if (!file) return { installed: false, capabilities };
    const version = await outputOf(file, ['--version'], this.env);
    const auth = await outputOf(file, ['auth', 'status'], this.env);
    let loggedIn: boolean | undefined;
    try {
      const parsed = JSON.parse(auth ?? '') as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === 'boolean') loggedIn = parsed.loggedIn;
    } catch {
      // unknown stays unknown
    }
    const v = version ? /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(version)?.[0] : undefined;
    return { installed: true, ...(v ? { version: v } : {}), ...(loggedIn !== undefined ? { loggedIn } : {}), capabilities };
  }

  async execute(wake: WakeContext, signal: AbortSignal): Promise<AdapterResult> {
    const file = this.binary();
    if (!file) {
      return { exit: 'error', usage: null, summary: '', error: 'Claude Code (`claude`) was not found on this computer\'s PATH. Install it and sign in, then let the Runner try again.', toolVersion: 'claude-code' };
    }
    const toolVersion = `claude-code`;
    registerSecret(wake.mcp.token);

    const policy = buildToolPolicy(wake.allowedNativeTools);
    if (policy.rejected.length) this.log.warn(`wake ${wake.wakeId}: ignored native tool rule(s) that are not a plain tool rule: ${policy.rejected.map((r) => JSON.stringify(redact(r))).join(', ')}`);
    const nativeRules = policy.allowedTools.split(',').slice(1);

    let url: URL;
    try {
      url = new URL(wake.mcp.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not http(s)');
    } catch {
      return { exit: 'error', usage: null, summary: '', error: 'The StoryOS MCP address is not a valid http(s) URL. Set it with --mcp-url (or STORYOS_MCP_URL).', toolVersion };
    }

    // The config holds the NAME of an environment variable. The credential itself goes to the child's environment only: not argv (ps
    // shows it), not a file (a backup shows it). Verified against the installed CLI: it expands ${VAR} in an MCP server's headers.
    const configPath = join(wake.workdir, `.storyos-mcp-${wake.wakeId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
    const config = { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: url.toString(), headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } };

    const marker = newDataMarker();
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--strict-mcp-config',
      '--mcp-config', configPath,
      '--tools', policy.tools,
      '--allowedTools', policy.allowedTools,
      '--disallowedTools', policy.disallowedTools,
      '--permission-mode', 'dontAsk',
      // The customer's own settings (hooks, permission allow-lists, skills) are theirs for their own sessions. Here a settings.json that
      // allows `Bash` would re-open what this list closes.
      '--setting-sources', '',
      '--disable-slash-commands',
      '--append-system-prompt', buildSystemPrompt(wake, nativeRules),
    ];

    const env: NodeJS.ProcessEnv = { ...this.env };
    for (const name of STRIPPED) if (!(name === 'ANTHROPIC_API_KEY' && this.options.keepApiKey)) delete env[name];
    env[TOKEN_ENV] = wake.mcp.token;
    // UNDOCUMENTED and verified on claude 2.1.104 only: without it the real CLI, run with a restricted --setting-sources, starts the
    // session while the StoryOS MCP server is still "pending" and the model gets NO StoryOS tools (it writes tool calls as plain text).
    // Why, what fails if it breaks, and the version pin that catches a CLI upgrade: see pins.ts.
    Object.assign(env, MCP_BLOCKING_ENV);

    const state = newStreamState();
    try {
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
      chmodSync(configPath, 0o600);
      const outcome = await this.run({
        file,
        args,
        cwd: wake.workdir,
        env,
        stdin: buildTaskText(wake, marker),
        timeoutMs: this.options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
        signal,
        onStdoutLine: (line) => readLine(state, line),
      });
      const result = interpret({ state, outcome, toolVersion: state.init?.version ? `claude-code ${state.init.version}` : toolVersion, now: this.now() });
      this.report(wake, state, result);
      return result;
    } catch (e) {
      return { exit: 'error', usage: null, summary: '', error: redact(`The Claude Code session could not run: ${e instanceof Error ? e.message : String(e)}`), toolVersion };
    } finally {
      rmSync(configPath, { force: true });
    }
  }

  /** One line per run, and none of it is content: no prompt, no summary text, no tool input, no credential. */
  private report(wake: WakeContext, state: ReturnType<typeof newStreamState>, result: AdapterResult): void {
    const used = state.toolCalls.length ? [...new Set(state.toolCalls)].join(', ') : 'none';
    const tokens = usageOf(state);
    this.log.info(
      `wake ${wake.wakeId}: claude-code ${result.exit}; ${state.result?.numTurns ?? '?'} turns, tools used: ${used}; tokens ${tokens ? `${tokens.tokensIn} in / ${tokens.tokensOut} out` : 'not reported'}; mcp ${state.init?.mcpServers.map((s) => `${s.name}=${s.status}`).join(',') || 'unknown'}; permission mode ${state.init?.permissionMode ?? 'unknown'}`,
    );
    if (state.result?.denials.length) this.log.warn(`wake ${wake.wakeId}: the allowlist refused: ${[...new Set(state.result.denials)].join(', ')}`);
    if (state.init?.mcpServers.some((s) => s.name === MCP_SERVER_NAME && s.status !== 'connected')) {
      this.log.warn(`wake ${wake.wakeId}: Claude Code could not connect to the StoryOS MCP server (${state.init.mcpServers.find((s) => s.name === MCP_SERVER_NAME)?.status}). Check --mcp-url.`);
    }
    if (result.exit === 'limit_reached') this.log.warn(`wake ${wake.wakeId}: usage limit; ${result.limitReachedUntil ? `lifts ${result.limitReachedUntil}` : 'no reset time given'}`);
    if (state.unparsedLines) this.log.debug(`wake ${wake.wakeId}: ${state.unparsedLines} output line(s) were not JSON and were skipped`);
  }
}

function outputOf(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 8_000, windowsHide: true, env }, (error, stdout) => resolve(error ? undefined : String(stdout)));
  });
}
