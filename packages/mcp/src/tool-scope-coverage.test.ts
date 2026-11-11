import { describe, expect, it } from 'vitest';
import { MCP_TOOL_NAMES } from '@storyos/schemas';
import { TOOL_SCOPE, registerTools } from './tools.js';
import { INTERNAL_TOOLS } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1261 — a tool with no TOOL_SCOPE entry defaults to ADMIN (reg() fails closed), so a member's read/write token silently never
 * sees it: count_records_grouped, get_bulk_record_job and list_agent_catch_up shipped that way. Both sets are derived from the
 * LIVE registry (registerTools at admin scope, against a recording server) and from MCP_TOOL_NAMES, never a hand-copied list.
 */
const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
const offered = (effective: EffectiveScope): string[] => {
  const names: string[] = [];
  registerTools({ registerTool: (n: string) => names.push(n) } as never, ctx, effective);
  return names;
};

describe('every MCP tool has a scope, and every scope names a tool', () => {
  // ticket #1262: the customer surface leaves out INTERNAL_TOOLS, but every tool that EXISTS needs a scope, so the sweeps run on the
  // internal-inclusive registry (a tool nobody offers a customer can still be offered to a maintainer, and defaults to admin the same way).
  const live = offered({ scope: 'admin', allowRunButton: true, internal: true });
  const customer = offered({ scope: 'admin', allowRunButton: true });

  it('the live registry is exactly the name list (so the sweep below is not a prefix of reality)', () => {
    expect([...customer].sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(live.filter((n) => !customer.includes(n)).sort()).toEqual([...INTERNAL_TOOLS].sort());
  });

  it('every registered tool has a TOOL_SCOPE entry', () => {
    const missing = live.filter((n) => !(n in TOOL_SCOPE)).sort();
    expect(missing, `tools with no TOOL_SCOPE entry (they default to admin, so a member token never sees them): ${missing.join(', ')}`).toEqual([]);
  });

  it('no TOOL_SCOPE entry names a tool that does not exist (no dead entries)', () => {
    const dead = Object.keys(TOOL_SCOPE).filter((n) => !live.includes(n)).sort();
    expect(dead, `TOOL_SCOPE entries with no registered tool: ${dead.join(', ')}`).toEqual([]);
  });

  it('a read token is offered the three read tools and no write tool; admin-only tools stay admin', () => {
    const read = new Set(offered({ scope: 'read', allowRunButton: false }));
    for (const n of ['count_records_grouped', 'get_bulk_record_job', 'list_agent_catch_up']) expect(read.has(n), n).toBe(true);
    expect(read.has('create_record')).toBe(false);
    expect(read.has('enqueue_bulk_record_job')).toBe(false);
    expect(offered({ scope: 'write', allowRunButton: false }).includes('create_database')).toBe(false);
    expect(offered({ scope: 'admin', allowRunButton: true }).includes('create_database')).toBe(true);
  });
});
