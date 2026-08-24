import { describe, expect, it } from 'vitest';
import {
  MCP_SERVER_VERSION,
  SCHEMA_VERSION_NOTICE,
  TOOL_SCHEMA_VERSION,
} from './schema-version.js';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

/**
 * #365 — a client negotiates tool schemas once, at connect. After a deploy that
 * changes an argument shape it is silently behind, and the failure surfaces as a
 * type error about the caller's own arguments. `59d9633` made the server tolerate
 * the old ENCODING, which dissolved the reported incident; what tolerance cannot
 * absorb is a removed argument or one whose meaning changed. For those a client
 * has to be able to notice it is behind — these assertions guard the mechanism
 * that lets it.
 */
describe('tool-argument schema version (#365)', () => {
  it('advertises the schema version inside serverInfo.version', () => {
    // The point of the suffix is that it rides on a field every MCP client
    // already displays, so no new capability is needed to see it.
    expect(MCP_SERVER_VERSION).toContain(`+tools.${TOOL_SCHEMA_VERSION}`);
  });

  it('keeps serverInfo.version parseable as semver with build metadata', () => {
    // `+tools.N` is semver build metadata: inert to anything that parses the
    // version, so advertising the schema version cannot break a client that only
    // wanted the package version.
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+\+tools\.\d+$/);
  });

  it('is a positive integer — an ordering a client can actually compare', () => {
    expect(Number.isInteger(TOOL_SCHEMA_VERSION)).toBe(true);
    expect(TOOL_SCHEMA_VERSION).toBeGreaterThan(0);
  });

  /**
   * The whole failure mode was a message that described the symptom and not the
   * cause, so the reader doubted their own arguments and retried variations. The
   * notice has to name the remedy in the words someone would recognise.
   */
  it('tells a stale client to reconnect rather than retry argument shapes', () => {
    expect(SCHEMA_VERSION_NOTICE).toMatch(/reconnect/i);
    expect(SCHEMA_VERSION_NOTICE).toMatch(/stale/i);
    // Names the symptom too — that is what the reader has in front of them.
    expect(SCHEMA_VERSION_NOTICE).toMatch(/rejected/i);
    expect(SCHEMA_VERSION_NOTICE).toContain(String(TOOL_SCHEMA_VERSION));
  });
});

/**
 * The constants above being right is worth nothing if nothing prints them. This
 * runs the REAL `get_started` handler through a fake server — the same harness
 * the tool tests use — so the wiring is asserted, not assumed. A notice defined
 * and never rendered is exactly the "declared then ignored" failure this
 * codebase keeps paying for.
 */
describe('get_started actually prints the schema version (#365)', () => {
  it('includes the reconnect notice in its orientation text', async () => {
    const handlers = new Map<string, (args: unknown) => Promise<{ content: Array<{ text: string }> }>>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: never) => {
        handlers.set(name, handler as never);
      },
    };
    // get_started with no `workspace` returns the intro alone and never calls the
    // API, so a ctx that would throw if used is the right stand-in.
    const ctx = { client: {} } as unknown as Ctx;
    registerTools(server as never, ctx);

    const result = await handlers.get('get_started')!({});
    const intro = result.content[0]!.text;
    expect(intro).toContain(SCHEMA_VERSION_NOTICE);
    expect(intro).toMatch(/reconnect/i);
  });
});
