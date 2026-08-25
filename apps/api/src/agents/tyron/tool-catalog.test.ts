import { describe, expect, it } from 'vitest';
import { TYRON_READ_ONLY_SCOPE, ToolsUnreachableError } from './tool-catalog';
import { TOKEN_SCOPE_RANK } from '@storyos/schemas';

/**
 * #357 / ADR-0016 §1.
 *
 * `McpToolCatalog` is a thin adapter over the MCP SDK, and the parts worth
 * testing without a live server are the ones carrying a DECISION rather than
 * plumbing: how the read-only phase is enforced, and what happens when the MCP
 * service cannot be reached.
 *
 * The wire behaviour is covered end to end once the turn loop lands, against the
 * real MCP server — a hand-mocked transport would only prove the mock matches my
 * assumptions about a protocol I deliberately took an SDK for.
 */

describe('read-only enforcement (#357a)', () => {
  /**
   * The load-bearing claim in the ADR: #357a is read-only because the token is
   * minted with `read` scope, and the MCP server already gates tool
   * REGISTRATION on scope — so a write tool is never advertised in the first
   * place.
   *
   * This asserts the mechanism is the scope, not a client-side allowlist. An
   * allowlist would need updating whenever a tool was added; a prompt
   * instruction would be advisory. Only the scope is enforced by the server, in
   * the same code path that gates every other MCP client.
   */
  it('mints with the read scope, the lowest rung', () => {
    expect(TYRON_READ_ONLY_SCOPE).toBe('read');
    // Verify 'read' really is the floor, so "read-only" is not a nickname for
    // something that can still write.
    expect(TOKEN_SCOPE_RANK[TYRON_READ_ONLY_SCOPE]).toBe(
      Math.min(...Object.values(TOKEN_SCOPE_RANK)),
    );
  });

  it('is below write and admin, so #357b is a scope change and nothing else', () => {
    expect(TOKEN_SCOPE_RANK[TYRON_READ_ONLY_SCOPE]).toBeLessThan(TOKEN_SCOPE_RANK.write);
    expect(TOKEN_SCOPE_RANK[TYRON_READ_ONLY_SCOPE]).toBeLessThan(TOKEN_SCOPE_RANK.admin);
  });
});

describe('ToolsUnreachableError', () => {
  /**
   * ADR-0016 §1 accepts an availability edge (api → mcp) on the condition that a
   * break is REPORTED, not degraded around. The message is the whole feature
   * here: a chat box that answers confidently while its tools are down is worse
   * than one that admits it, because the user believes it.
   */
  it('says nothing happened to the workspace', () => {
    const err = new ToolsUnreachableError(new Error('ECONNREFUSED'));
    expect(err.message).toMatch(/haven't done anything/i);
  });

  it("says it is our fault, not the user's request", () => {
    // Without this, the natural reaction is to rephrase the question — which
    // cannot work, and wastes the user's time on a problem they cannot fix.
    const err = new ToolsUnreachableError(new Error('ECONNREFUSED'));
    expect(err.message).toMatch(/our side/i);
  });

  it('keeps the underlying cause for our logs', () => {
    const cause = new Error('ECONNREFUSED');
    expect(new ToolsUnreachableError(cause).cause).toBe(cause);
  });

  it('is distinguishable from an ordinary tool failure', () => {
    // The turn loop treats a tool that declined (permission denied, bad
    // argument) as a normal outcome to hand back to the model, and an
    // unreachable service as a stop. Conflating them would either abort turns
    // over a recoverable denial, or let the model "retry" against nothing.
    const err = new ToolsUnreachableError(new Error('boom'));
    expect(err).toBeInstanceOf(ToolsUnreachableError);
    expect(err.name).toBe('ToolsUnreachableError');
  });
});
