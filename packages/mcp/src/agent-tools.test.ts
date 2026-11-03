import { describe, expect, it } from 'vitest';
import { AGENT_RUN_PRESET_TOOLS, AGENT_TOOLS_ALWAYS_ON, MCP_TOOL_NAMES, parseAgentTools, validateAgentSettings } from '@storyos/schemas';
import { registerTools } from './tools.js';
import { AGENT_RUN_BASE_TOOLS, AGENT_SELECTED_FLOOR, AGENT_SELECTED_PROFILE, resolveToolProfile } from './tool-profiles.js';
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

describe('the settings screen\'s constants are the server\'s', () => {
  it('the always-on floor and the short preset in @storyos/schemas equal the profile constants here, and every name is a live tool', () => {
    expect([...AGENT_TOOLS_ALWAYS_ON]).toEqual([...AGENT_SELECTED_FLOOR]);
    expect([...AGENT_RUN_PRESET_TOOLS]).toEqual([...AGENT_RUN_BASE_TOOLS]);
    for (const n of [...AGENT_TOOLS_ALWAYS_ON, ...AGENT_RUN_PRESET_TOOLS]) expect(MCP_TOOL_NAMES).toContain(n);
  });
});

describe('#1180: the default is every tool the credential may call; a saved list narrows it', () => {
  const offeredFor = (qs: string, eff: EffectiveScope = RUN_CRED) => {
    const r = resolveToolProfile(new URLSearchParams(qs));
    if (!r.ok) throw new Error(r.error);
    return advertised(r.allow ? { ...eff, onlyTools: r.allow } : eff);
  };
  const saved = (tools: string) => {
    const names = parseAgentTools(tools);
    return `profile=${AGENT_SELECTED_PROFILE}${names.length ? `&tools=${names.join(',')}` : ''}`;
  };

  it('NO saved list = no profile = the whole role-allowed set (what the adapter sends: no query at all)', () => {
    const all = offeredFor('');
    expect(all.size).toBeGreaterThan(100);
    expect(all.size).toBe(advertised(RUN_CRED).size);
    expect(all.has('create_record')).toBe(true);
    expect(all.has('list_audit_log')).toBe(false); // admin-only: the role still decides
  });

  it('a saved list offers exactly its names plus the floor, and the same credential WITHOUT the name is not offered it', () => {
    const offered = offeredFor(saved('link_records, unlink_records'));
    expect([...offered].sort()).toEqual([...new Set([...AGENT_SELECTED_FLOOR, 'link_records', 'unlink_records'])].sort());
    expect(offeredFor(saved('unlink_records')).has('link_records')).toBe(false);
  });

  it('the floor cannot be unticked: a saved list that names nothing useful still offers get_record and add_comment', () => {
    expect([...offeredFor(saved(''))].sort()).toEqual([...AGENT_SELECTED_FLOOR].sort());
    expect(offeredFor(saved('count_records')).has('add_comment')).toBe(true);
  });

  it('a role cannot add beyond what the credential may call: an admin-only tool in the list is not offered to a member credential, a write tool not to a read credential', () => {
    expect(MCP_TOOL_NAMES).toContain('list_audit_log');
    expect(validateAgentSettings({ tools: 'list_audit_log' })).toEqual([]);
    expect(offeredFor(saved('list_audit_log')).has('list_audit_log')).toBe(false);
    expect(offeredFor(saved('list_audit_log'), FULL).has('list_audit_log')).toBe(true); // same list, an admin credential: offered
    expect(offeredFor(saved('create_record'), { scope: 'read', allowRunButton: false, role: 'member' }).has('create_record')).toBe(false);
  });

  it('the short preset is still a named choice: a saved list equal to it offers exactly the 8', () => {
    expect(offeredFor(saved(AGENT_RUN_PRESET_TOOLS.join(','))).size).toBe(AGENT_RUN_PRESET_TOOLS.length);
  });
});

describe('validateAgentSettings', () => {
  it('accepts nothing set, real tool names (commas, spaces, new lines) and ordinary model names', () => {
    expect(validateAgentSettings({})).toEqual([]);
    expect(validateAgentSettings({ tools: null, model: null })).toEqual([]);
    expect(validateAgentSettings({ tools: '', model: '' })).toEqual([]);
    expect(validateAgentSettings({ tools: 'link_records,\nunlink_records  delete_record' })).toEqual([]);
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
