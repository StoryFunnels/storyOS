// SPDX-License-Identifier: Apache-2.0
/**
 * What a Claude Code session may use (ADR-0021 section 7, points 1 and 2).
 *
 * The decision, and why:
 *  - The StoryOS MCP server is the ONLY tool source (`--strict-mcp-config`), and the ONLY thing allowed by default is that server.
 *    What the agent may do inside StoryOS is decided by its run credential (a write-capped agent token, held for approval where a
 *    manager declared a gate), not by this list: this list decides what the session can do on the CUSTOMER'S COMPUTER, which is nothing.
 *  - NO built-in tool by default, not even a read-only one. `Read` with no path scope reads `~/.ssh` and `.env`, and the agent could
 *    then write what it found into a StoryOS comment; the agent's instructions and skills already arrive in the system prompt, so the
 *    local file system has nothing it needs. `--tools ""` removes the built-ins altogether (verified against the installed CLI: the
 *    session's tool list was exactly the MCP tools).
 *  - `--permission-mode dontAsk`: a tool that is not allowed is denied without asking. The modes that ask (`default`) cannot be
 *    answered in a headless run, and `bypassPermissions` / `--dangerously-skip-permissions` are NEVER used here.
 *  - A manager may allow a native tool for ONE agent (`WakeContext.allowedNativeTools`, empty today: nothing sends it yet). Those are
 *    added to both `--tools` and `--allowedTools`, nothing else is.
 */
export const MCP_SERVER_NAME = 'storyos';
export const MCP_TOOL_RULE = `mcp__${MCP_SERVER_NAME}`;

/** Built-in tools that are denied outright unless the manager allowed that very tool. Belt and braces over `--tools`. */
const ALWAYS_DENIED = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Read', 'Glob', 'Grep', 'KillShell', 'BashOutput'];

const NATIVE_RULE = /^([A-Za-z][A-Za-z0-9_]{0,40})(\([^()\n]{0,300}\))?$/;

export interface ToolPolicy {
  /** The value of `--tools`: the built-ins that exist at all. Empty string = none. */
  tools: string;
  /** The value of `--allowedTools`. */
  allowedTools: string;
  /** The value of `--disallowedTools`. */
  disallowedTools: string;
  /** Rules that were asked for and refused because they do not look like a tool rule. */
  rejected: string[];
}

export function buildToolPolicy(allowedNativeTools: string[]): ToolPolicy {
  const natives: string[] = [];
  const rejected: string[] = [];
  for (const raw of allowedNativeTools) {
    const rule = raw.trim();
    const m = NATIVE_RULE.exec(rule);
    // A wildcard, or an `mcp__` rule (another tool source), is not a native tool: refused, loudly, not guessed at. A manager who allows
    // `Bash` for an agent has said so on purpose (the app shows it); a SCOPED rule such as `Bash(ls:*)` is the way to say less.
    if (!m || rule.startsWith('mcp__') || /^(\*|all)$/i.test(rule)) {
      rejected.push(rule);
      continue;
    }
    natives.push(rule);
  }
  const baseNames = [...new Set(natives.map((r) => r.replace(/\(.*$/, '')))];
  const denied = ALWAYS_DENIED.filter((t) => !baseNames.includes(t));
  return {
    tools: baseNames.join(','),
    allowedTools: [MCP_TOOL_RULE, ...natives].join(','),
    disallowedTools: denied.join(','),
    rejected,
  };
}

/** The MCP server's tool profile for an agent run (packages/mcp tool-profiles.ts, #1177). The server owns the list; this is its name. */
export const MCP_RUN_PROFILE = 'agent-run';
const MCP_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The MCP address for a run: the configured URL plus the profile, and the role's extra tools. The profile is what keeps ~120 tool
 * definitions out of every request (measured ~31k tokens each). An older MCP server ignores the query and offers its full set: more
 * tokens, never fewer tools than before. A name that is not a tool name is dropped here, loudly, not sent.
 */
export function withRunProfile(url: URL, extraTools: readonly string[] = []): { url: URL; dropped: string[] } {
  const out = new URL(url.toString());
  out.searchParams.set('profile', MCP_RUN_PROFILE);
  const dropped: string[] = [];
  const keep: string[] = [];
  for (const raw of extraTools) {
    const name = raw.trim();
    if (MCP_TOOL_NAME.test(name)) keep.push(name);
    else dropped.push(name);
  }
  if (keep.length) out.searchParams.set('tools', [...new Set(keep)].join(','));
  else out.searchParams.delete('tools');
  return { url: out, dropped };
}
