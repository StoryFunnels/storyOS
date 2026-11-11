import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1183 / #1212 — what `create_agent_trigger` tells an agent about `human_gate`. The wording is pinned against the live registry so it
 * cannot silently regress: a gated trigger NEVER starts a run by itself, and a person starts each run (nothing confirms one: the
 * trigger subscriber creates no pending confirmation for a gated trigger).
 *
 * #1212 REWROTE two assertions here. #1183 pinned "a person has to start each run" as the pack default and the description called
 * human_gate "the right choice for anything that writes to something a customer sees". Ievgen reversed that: an agent wakes by itself
 * once switched on, human_gate is the opt-in "ask me before each run", and what holds outward writes is the approvals queue. The
 * old assertions would have kept steering a connected model back to the gate the product no longer defaults to.
 */
function describeTool(name: string): { description: string; inputSchema: Record<string, { description?: string }> } {
  let found: { description: string; inputSchema: Record<string, { description?: string }> } | undefined;
  const effective: EffectiveScope = { scope: 'admin', allowRunButton: true };
  const notes = registerTools(
    {
      registerTool: (n: string, cfg: { description: string; inputSchema: Record<string, { description?: string }> }) => {
        if (n === name) found = cfg;
      },
    } as never,
    { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx,
    effective,
  );
  if (!found) throw new Error(`tool ${name} is not registered`);
  // ticket #1262: the listed description is a short lead; the wording pinned here is in the full text get_started returns (the short
  // lead's own essentials are pinned in tool-description-budget.test.ts).
  return { ...found, description: notes.get(name) ?? found.description };
}

describe('create_agent_trigger wording about human_gate (#1183, #1212)', () => {
  const tool = describeTool('create_agent_trigger');

  it('says a gated trigger never fires by itself and a person starts each run (KEPT from #1183)', () => {
    expect(tool.description).toContain('human_gate:true');
    expect(tool.description).toMatch(/NEVER fires by itself/);
    expect(tool.description).toMatch(/a person has to start each run/);
  });

  it('says an ordinary trigger starts the agent by itself, and human_gate is the "ask me before each run" opt-in (#1212)', () => {
    expect(tool.description).toMatch(/By default the trigger starts the agent by itself/);
    expect(tool.description).toMatch(/ask me before each run/);
  });

  it('no longer steers a model to human_gate as the safe default for customer-facing writes (the #1183 sentence)', () => {
    expect(tool.description).not.toMatch(/right choice for anything that writes/);
    expect(tool.description).not.toMatch(/leave human_gate off only when/);
  });

  it('says a pack\'s own triggers install OFF until a person switches one on in the review (#1192 kept)', () => {
    expect(tool.description).toMatch(/switched OFF until a person turns one on in the install review/);
  });

  it('does not claim anything confirms a gated run, nor that it stages an approval', () => {
    expect(tool.description).not.toMatch(/or confirm/i);
    expect(tool.description).not.toMatch(/stages the action for approval/i);
  });

  it('keeps the human_gate input description pointing at a person starting the run', () => {
    // The zod shape is opaque at runtime, so pin the source text of the input description next to the tool.
    const src = readFileSync(fileURLToPath(new URL('./tools.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/true = "ask me before each run": this trigger never starts a run by itself; a person starts each run/);
    expect(src).toMatch(/Leave it off \(the default\) for an agent that should wake by itself/);
  });
});
