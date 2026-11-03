// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findOnPath } from '../src/adapters/detect.js';
import { judgeCliVersion, MCP_BLOCKING_ENV, VERIFIED_CLI_VERSIONS } from '../src/adapters/claude-code/pins.js';

/**
 * The adapter relies on MCP_CONNECTION_NONBLOCKING=0, which is UNDOCUMENTED and was verified on the versions in
 * VERIFIED_CLI_VERSIONS only (pins.ts). A CLI upgrade that changes this must fail loudly, not silently leave agents with no tools.
 *
 *  - Where `claude` is not installed (CI): the installed-version test is SKIPPED, and says so. CI therefore does NOT guard this.
 *  - Where it is installed (a developer's Mac, the smoke script's preflight which uses the same list): a version outside the list
 *    FAILS this test, with the instruction to re-verify and update the one constant.
 */
const claude = findOnPath('claude');
const installedVersion = (): string => execFileSync(claude!, ['--version'], { encoding: 'utf8', timeout: 10_000 });

describe('the claude CLI version this adapter was verified on', () => {
  it('has a known-good list, with the variable pinned to 0 (blocking)', () => {
    expect(VERIFIED_CLI_VERSIONS.length).toBeGreaterThan(0);
    expect(MCP_BLOCKING_ENV).toEqual({ MCP_CONNECTION_NONBLOCKING: '0' });
  });

  it('judges versions: a verified one passes, anything else is unverified with instructions', () => {
    const known = VERIFIED_CLI_VERSIONS[0]!;
    expect(judgeCliVersion(`${known} (Claude Code)`).verified).toBe(true);
    const next = judgeCliVersion('99.0.0 (Claude Code)');
    expect(next.verified).toBe(false);
    expect(next.message).toContain('99.0.0');
    expect(next.message).toContain('re-verify');
    expect(next.message).toContain('VERIFIED_CLI_VERSIONS');
    expect(judgeCliVersion('garbage').verified).toBe(false);
  });

  it.skipIf(!claude)('the INSTALLED claude is a verified version (skipped where claude is not installed, e.g. CI)', () => {
    const verdict = judgeCliVersion(installedVersion());
    expect(verdict.verified, `UNVERIFIED CLAUDE CLI. ${verdict.message}`).toBe(true);
  });
});
