// SPDX-License-Identifier: Apache-2.0
/**
 * The adapter contract (ADR-0021 section 5). The Runner owns the claim loop, the lease, the folders and the reporting; an adapter
 * owns ONLY "run the tool once, for this wake, and say what happened".
 *
 * Where this differs from the ADR's sketch, on purpose, and why:
 *  - `id` also admits `'stub'`, the adapter this package ships so the whole loop is testable without a vendor tool;
 *  - `runId` and `agent.skills` are what the server actually sends (`string | null` and a raw string);
 *  - the context also carries the agent's `goal`, `targetDatabases`, the wake's `reasons` and `context`, because the server sends
 *    them and an adapter writes the agent's instructions file from them.
 */
export type AdapterId = 'claude-code' | 'cursor' | 'codex' | 'local-openai' | 'stub';

export type WakeReason = string;

export interface WakeContext {
  wakeId: string;
  runId: string | null;
  reason: WakeReason;
  reasons: Array<{ reason: string; count?: number }>;
  depth: number;
  agent: {
    id: string;
    name: string;
    goal: string | null;
    instructions: string;
    skills: string | null;
    targetDatabases: string | null;
  };
  /** An id and a reference, never the record's text: the agent reads the record through MCP, under the run credential. */
  record?: { id: string; databaseId: string; ref: string };
  /** The run credential. Written to a 0600 file or an environment variable by the adapter, NEVER to argv, NEVER logged. */
  mcp: { url: string; token: string };
  /** The per-agent folder: the session's working directory, and the only directory it is given. */
  workdir: string;
  /** Native tools the manager allowed for this agent. Empty by default (ADR-0021 section 7). */
  allowedNativeTools: string[];
  protocol: number;
}

export interface AdapterResult {
  exit: 'ok' | 'error' | 'limit_reached' | 'aborted' | 'timeout';
  /** `null` = the tool did not report it. NEVER zero-filled: a zero is a quantity. */
  usage: { tokensIn: number; tokensOut: number } | null;
  sessionId?: string;
  /** Capped by the Runner, and the cut says so. */
  summary: string;
  /** ISO time. Only meaningful when `exit` is `limit_reached`. */
  limitReachedUntil?: string;
  error?: string;
  toolVersion: string;
}

export interface Capabilities {
  usageReporting: 'full' | 'partial' | 'none';
  limitDetection: boolean;
  nativeToolAllowlist: 'enforced' | 'advisory' | 'none';
  mcpInjection: boolean;
  headless: boolean;
}

export interface Detection {
  installed: boolean;
  version?: string;
  loggedIn?: boolean;
  capabilities: Capabilities;
}

export interface RunnerAdapter {
  readonly id: AdapterId;
  /** Is the tool installed, logged in, and what can it do? Never throws. */
  detect(): Promise<Detection>;
  /**
   * Run the tool once for this wake. When `signal` aborts (the lease was lost, the Runner is stopping) the adapter must stop the
   * session, kill any child process it started, and return promptly. Its result is then discarded by the Runner.
   */
  execute(wake: WakeContext, signal: AbortSignal): Promise<AdapterResult>;
}
