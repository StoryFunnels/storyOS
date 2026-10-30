// SPDX-License-Identifier: Apache-2.0
/**
 * What this adapter's behaviour was VERIFIED against, in one place.
 *
 * `claude` is not ours and some of what the adapter relies on is undocumented. The versions below are the ones it was observed on;
 * anything else is unverified until someone re-runs the MCP-connection check (see `claude-code-version-pin.test.ts` and the smoke
 * script's preflight, which both read this list) and adds the version here.
 */
export const VERIFIED_CLI_VERSIONS: readonly string[] = ['2.1.104'];

/**
 * `MCP_CONNECTION_NONBLOCKING=0`: UNDOCUMENTED, verified on 2.1.104 only.
 *
 * WHY: real claude 2.1.104 run with a restricted `--setting-sources` sends its first request while the StoryOS MCP server is still
 * "pending", so the model gets NO StoryOS tools and writes its tool calls as plain text. With this variable the CLI connects first
 * (observed: pending without it, connected with it, same flags otherwise).
 *
 * IF IT BREAKS (a CLI release renames or ignores it): the session has no StoryOS tools, cannot comment, the run ends without a
 * comment, StoryOS re-runs it once (must_comment backstop, ADR-0021 s6) and then fails it visibly and tells the owner. Nothing
 * unsafe happens; the agent just does no work. The version-pin test and the smoke preflight exist so an upgrade is noticed before that.
 */
export const MCP_BLOCKING_ENV = { MCP_CONNECTION_NONBLOCKING: '0' } as const;

export interface VersionVerdict {
  verified: boolean;
  message: string;
}

/** Is this `claude --version` output one of the verified versions? The message says what to do when it is not. */
export function judgeCliVersion(versionOutput: string): VersionVerdict {
  const v = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/.exec(versionOutput)?.[0];
  if (v && VERIFIED_CLI_VERSIONS.includes(v)) return { verified: true, message: `claude ${v} is a verified version.` };
  return {
    verified: false,
    message:
      `The installed claude is ${v ?? `unreadable (${JSON.stringify(versionOutput.trim().slice(0, 60))})`}, but the Claude Code adapter was only verified on ${VERIFIED_CLI_VERSIONS.join(', ')}. ` +
      'It relies on MCP_CONNECTION_NONBLOCKING=0, which is undocumented: re-verify that a headless run with --strict-mcp-config and --setting-sources "" reports the StoryOS MCP server as connected (not pending) at init and that the model can call its tools, ' +
      'then add this version to VERIFIED_CLI_VERSIONS in packages/runner/src/adapters/claude-code/pins.ts.',
  };
}
