import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1183 — what `create_agent_trigger` tells an agent about `human_gate`. The wording is pinned against the live registry so it cannot
 * silently regress: a gated trigger NEVER starts a run by itself, and a person starts each run (nothing confirms one: the trigger
 * subscriber creates no pending confirmation for a gated trigger).
 */
function describeTool(name: string): { description: string; inputSchema: Record<string, { description?: string }> } {
  let found: { description: string; inputSchema: Record<string, { description?: string }> } | undefined;
  const effective: EffectiveScope = { scope: 'admin', allowRunButton: true };
  registerTools(
    {
      registerTool: (n: string, cfg: { description: string; inputSchema: Record<string, { description?: string }> }) => {
        if (n === name) found = cfg;
      },
    } as never,
    { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx,
    effective,
  );
  if (!found) throw new Error(`tool ${name} is not registered`);
  return found;
}

describe('create_agent_trigger wording about human_gate (#1183)', () => {
  const tool = describeTool('create_agent_trigger');

  it('says a gated trigger never fires by itself and a person starts each run', () => {
    expect(tool.description).toContain('human_gate:true');
    expect(tool.description).toMatch(/NEVER fires by itself/);
    expect(tool.description).toMatch(/a person has to start each run/);
  });

  it('does not claim anything confirms a gated run, nor that it stages an approval', () => {
    expect(tool.description).not.toMatch(/or confirm/i);
    expect(tool.description).not.toMatch(/stages the action for approval/i);
  });

  it('keeps the human_gate input description pointing at a person starting the run', () => {
    // The zod shape is opaque at runtime, so pin the source text of the input description next to the tool.
    const src = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/true = this trigger never starts a run by itself; a person starts each run/);
  });
});
