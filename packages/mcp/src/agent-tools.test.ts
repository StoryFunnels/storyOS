import { describe, expect, it } from 'vitest';
import { AGENT_RUN_PRESET_TOOLS, AGENT_TOOLS_ALL, MCP_TOOL_NAMES, parseAgentTools, validateAgentSettings } from '@storyos/schemas';
import { registerTools } from './tools.js';
import { AGENT_RUN_BASE_TOOLS, AGENT_RUN_PROFILE, resolveToolProfile } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * #1180 - the names a manager may put in an agent's `tools` setting are the names the live registry registers. Enumerates the registry
 * (registerTools against a recording server); a hand-copied list would pass for exactly the names it omits.
 */
function advertised(effective: EffectiveScope): Set<string> {
  const names = new Set<string>();
  registerTools({ registerTool: (n: string) => names.add(n) } as never, { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx, effective);
  return names;
}
const FULL: EffectiveScope = { scope: 'admin', allowRunButton: true };
const RUN_CRED: EffectiveScope = { scope: 'write', allowRunButton: false, role: 'member' };

describe('MCP_TOOL_NAMES (packages/schemas/src/agent-tools.ts) is the live registry', () => {
  it('lists exactly the registered tools: add or remove the name there when a tool is added or removed', () => {
    const live = [...advertised(FULL)].sort();
    expect([...MCP_TOOL_NAMES].sort()).toEqual(live);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
  });
});

describe("the settings screen's constants are the server's", () => {
  it('the essentials preset in @storyos/schemas equals the profile here, includes the two tools a run cannot do without, and every name is a live tool', () => {
    expect([...AGENT_RUN_PRESET_TOOLS]).toEqual([...AGENT_RUN_BASE_TOOLS]);
    expect(AGENT_RUN_PRESET_TOOLS).toEqual(expect.arrayContaining(['get_record', 'add_comment']));
    for (const n of AGENT_RUN_PRESET_TOOLS) expect(MCP_TOOL_NAMES).toContain(n);
    expect(MCP_TOOL_NAMES).not.toContain(AGENT_TOOLS_ALL); // `all` is a value of the setting, never a tool
  });
});

describe('#1180: the default is the 8 essentials; chosen extras are ADDED; `all` is the explicit opt-in', () => {
  /** Exactly what the Runner adapter puts on the URL (runner withRunProfile), then what the server offers a credential for it. */
  const query = (tools: string): string => {
    const names = parseAgentTools(tools);
    if (names.includes(AGENT_TOOLS_ALL)) return '';
    return `profile=${AGENT_RUN_PROFILE}${names.length ? `&tools=${names.join(',')}` : ''}`;
  };
  const offeredFor = (tools: string, eff: EffectiveScope = RUN_CRED) => {
    const r = resolveToolProfile(new URLSearchParams(query(tools)));
    if (!r.ok) throw new Error(r.error);
    return advertised(r.allow ? { ...eff, onlyTools: r.allow } : eff);
  };

  it('NO saved Tools = exactly the 8 essentials (create_record among them), against a registry of 150+', () => {
    const offered = offeredFor('');
    expect([...offered].sort()).toEqual([...AGENT_RUN_PRESET_TOOLS].sort());
    expect(offered.size).toBe(8);
    expect(advertised(FULL).size).toBeGreaterThan(150);
  });

  it('chosen extras are ADDED to the essentials, which are never lost; without the name the same credential is not offered it', () => {
    const offered = offeredFor('link_records, unlink_records');
    for (const base of AGENT_RUN_PRESET_TOOLS) expect(offered.has(base), base).toBe(true);
    expect(offered.size).toBe(AGENT_RUN_PRESET_TOOLS.length + 2);
    expect(offeredFor('unlink_records').has('link_records')).toBe(false);
    expect(offeredFor('').has('link_records')).toBe(false);
  });

  it("`all` is every tool the credential's role and scope allow, and no more", () => {
    const all = offeredFor(AGENT_TOOLS_ALL);
    expect(all.size).toBe(advertised(RUN_CRED).size);
    expect(all.size).toBeGreaterThan(100);
    expect(all.has('list_audit_log')).toBe(false); // admin-only: a member credential never gets it
    expect(offeredFor(AGENT_TOOLS_ALL, FULL).has('list_audit_log')).toBe(true);
    expect(offeredFor(AGENT_TOOLS_ALL, { scope: 'read', allowRunButton: false, role: 'member' }).has('create_record')).toBe(false);
  });

  it('a role cannot add beyond what the credential may call: an admin-only tool chosen as an extra is not offered to a member credential, a write tool not to a read credential', () => {
    expect(MCP_TOOL_NAMES).toContain('list_audit_log');
    expect(validateAgentSettings({ tools: 'list_audit_log' })).toEqual([]);
    expect(offeredFor('list_audit_log').has('list_audit_log')).toBe(false);
    expect(offeredFor('list_audit_log', FULL).has('list_audit_log')).toBe(true);
    expect(offeredFor('link_records', { scope: 'read', allowRunButton: false, role: 'member' }).has('link_records')).toBe(false);
  });
});

describe('validateAgentSettings', () => {
  it('accepts nothing set, real tool names (commas, spaces, new lines) and ordinary model names', () => {
    expect(validateAgentSettings({})).toEqual([]);
    expect(validateAgentSettings({ tools: null, model: null })).toEqual([]);
    expect(validateAgentSettings({ tools: '', model: '' })).toEqual([]);
    expect(validateAgentSettings({ tools: 'link_records,\nunlink_records  delete_record' })).toEqual([]);
    expect(validateAgentSettings({ tools: 'all' })).toEqual([]);
    for (const m of ['opus', 'sonnet[1m]', 'claude-sonnet-4-5', 'claude-opus-4-5-20251101', 'provider/model:tag.1']) expect(validateAgentSettings({ model: m }), m).toEqual([]);
  });

  it('refuses an unknown tool name and lists the valid ones', () => {
    const [p] = validateAgentSettings({ tools: 'link_records, make_coffee' }) as [ReturnType<typeof validateAgentSettings>[number]];
    expect(p.field).toBe('tools');
    expect(p.message).toContain('"make_coffee"');
    expect(p.message).toContain('Valid names:');
    expect(p.message).toContain('get_record');
    expect(p.message).not.toContain('"link_records"');
  });

  it('refuses a model that could be read as a flag or reach a shell', () => {
    for (const m of ['--dangerously-skip-permissions', '-p', 'opus --permission-mode bypassPermissions', 'opus;rm -rf', '$(id)', 'a b', 'opus\n--x', '`id`', 'x|y', 'a'.repeat(101)]) {
      expect(validateAgentSettings({ model: m }).map((x) => x.field), JSON.stringify(m)).toEqual(['model']);
    }
    expect(validateAgentSettings({ model: 5 }).length).toBe(1);
    expect(validateAgentSettings({ tools: 5 }).length).toBe(1);
  });
});
