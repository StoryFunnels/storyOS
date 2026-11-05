import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_RUN_PRESET_TOOLS, MCP_TOOL_NAMES } from '@storyos/schemas';
import { describe, expect, it } from 'vitest';
import {
  agentModelView,
  canEditAgentSettings,
  canEditWorkspaceModel,
  ESSENTIAL_TOOLS,
  EXTRA_TOOLS,
  FOLLOW_WORKSPACE,
  leaveAll,
  modelControllable,
  modelLabel,
  modelProblem,
  modelToStore,
  plainProblem,
  readOnlyLine,
  serializeTools,
  toggleTool,
  toolsProblem,
  toolsView,
  TOOL_DEFAULT_LABEL,
  WORKSPACE_MODEL_OPTIONS,
  workspaceModelSelected,
  workspaceModelToStore,
} from './agent-settings';

/**
 * Ticket #1180 (web). Each block names the rule it holds; the first four read the REAL contract (`@storyos/schemas`) and the
 * REAL generated role gate, so the screen cannot drift from the server without a test going red.
 */

/** The names the MCP role gate marks admin-only, read from the generated file the server uses (the web cannot import @storyos/mcp). */
function adminOnlyTools(): string[] {
  const text = readFileSync(fileURLToPath(new URL('../../../../../packages/mcp/src/role-gates.generated.ts', import.meta.url)), 'utf8');
  return [...text.matchAll(/^\s+([a-z_]+): 'admin',$/gm)].map((m) => m[1]!);
}

describe('the essentials are the contract’s 8, ticked and fixed', () => {
  it('lists exactly the API’s AGENT_RUN_PRESET_TOOLS (a different set means the screen lies about what every run is offered)', () => {
    expect(new Set(ESSENTIAL_TOOLS.map((t) => t.name))).toEqual(new Set(AGENT_RUN_PRESET_TOOLS));
    expect(ESSENTIAL_TOOLS).toHaveLength(8);
  });
  it('an empty or unset `tools` has nothing ticked beyond the essentials and nothing to remove', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const v = toolsView(raw);
      expect([...v.ticked]).toEqual([]);
      expect(v.other).toEqual([]);
      expect(v.all).toBe(false);
    }
  });
  it('an essential written into the saved text is shown as an essential, never as an extra, and is not written back', () => {
    const v = toolsView('get_record,link_records');
    expect([...v.ticked]).toEqual(['link_records']);
    expect(v.other).toEqual([]);
    expect(toggleTool('get_record,link_records', 'search', true)).toBe('link_records,search');
    expect(serializeTools(['get_record', 'add_comment'])).toBeNull();
  });
});

describe('the extras: which tools are offered', () => {
  it('every offered extra is a real registry tool and not an essential', () => {
    for (const t of EXTRA_TOOLS) {
      expect(MCP_TOOL_NAMES, t.name).toContain(t.name);
      expect(AGENT_RUN_PRESET_TOOLS, t.name).not.toContain(t.name);
      expect(t.why.length, t.name).toBeGreaterThan(8);
    }
    expect(new Set(EXTRA_TOOLS.map((t) => t.name)).size).toBe(EXTRA_TOOLS.length);
  });
  it('delete_record, and no delete_* tool, is ever offered (deletion has its own approval policy, ticket #1178)', () => {
    expect(EXTRA_TOOLS.map((t) => t.name)).not.toContain('delete_record');
    expect(EXTRA_TOOLS.filter((t) => t.name.startsWith('delete_'))).toEqual([]);
  });
  it('no admin-only tool is offered: the list is checked against the generated role gate, and the check can see the gate', () => {
    const admin = adminOnlyTools();
    expect(admin.length).toBeGreaterThan(15); // the parse must find the gate, or "none offered" proves nothing
    expect(admin).toContain('get_credential');
    for (const t of EXTRA_TOOLS) expect(admin, `${t.name} is admin-only on the server`).not.toContain(t.name);
  });
});

describe('tools: serialize to comma-separated text and back', () => {
  it('a click on an extra stores the names comma-separated, once each, extras only', () => {
    expect(toggleTool(null, 'link_records', true)).toBe('link_records');
    expect(toggleTool('link_records', 'search', true)).toBe('link_records,search');
    expect(toggleTool('link_records,search', 'search', true)).toBe('link_records,search');
    expect(toggleTool('link_records,search', 'link_records', false)).toBe('search');
  });
  it('unticking the last extra stores nothing: not set means the essentials', () => {
    expect(toggleTool('search', 'search', false)).toBeNull();
  });
  it('round-trips: what is stored is what the screen reads back, in saved order', () => {
    const stored = serializeTools(['search', 'link_records', 'get_document'])!;
    expect(stored).toBe('search,link_records,get_document');
    expect([...toolsView(stored).ticked]).toEqual(['search', 'link_records', 'get_document']);
  });
  it('reads the API’s own separators (commas, spaces, new lines)', () => {
    expect([...toolsView('search, link_records\nget_document').ticked]).toEqual(['search', 'link_records', 'get_document']);
  });
});

describe('tools: a saved name the list does not offer is KEPT, shown, and droppable (unconfigured is not invalid)', () => {
  it('delete_record saved through the API is shown under "also saved", survives another click, and Remove drops only it', () => {
    const raw = 'link_records,delete_record';
    expect(toolsView(raw).other).toEqual([{ name: 'delete_record', known: true }]);
    expect(toggleTool(raw, 'search', true)).toBe('link_records,delete_record,search');
    expect(toggleTool(raw, 'delete_record', false)).toBe('link_records');
  });
  it('a name the registry no longer has is shown as gone, does not throw, and can be dropped', () => {
    const raw = 'search,old_tool_name';
    expect(toolsView(raw).other).toEqual([{ name: 'old_tool_name', known: false }]);
    expect(toggleTool(raw, 'old_tool_name', false)).toBe('search');
  });
  it('the server’s own sentence is available before the round trip, and names the unknown tool', () => {
    expect(toolsProblem('search')).toBeNull();
    expect(toolsProblem(null)).toBeNull();
    expect(toolsProblem('search,not_a_tool')).toMatch(/Unknown tool name.*not_a_tool/);
  });
  it('a person reads the first sentence, not the roll-call of ~190 valid names the API appends', () => {
    const full = toolsProblem('search,not_a_tool')!;
    expect(full).toContain('Valid names:');
    expect(plainProblem(full)).toBe('Unknown tool name: "not_a_tool".');
    expect(plainProblem('Could not save. Try again.')).toBe('Could not save. Try again.');
  });
});

describe('tools: the opt-in `all`', () => {
  it('is read as "every tool its role allows", never as a tool name, and keeps the extras beneath it', () => {
    const v = toolsView('all,search');
    expect(v.all).toBe(true);
    expect(v.other).toEqual([]);
    expect([...v.ticked]).toEqual(['search']);
  });
  it('a click while `all` is saved keeps `all`; going back to the essentials removes only it', () => {
    expect(toggleTool('all,search', 'link_records', true)).toBe('all,search,link_records');
    expect(leaveAll('all,search')).toBe('search');
    expect(leaveAll('all')).toBeNull();
    expect(toolsProblem('all')).toBeNull();
  });
});

describe('model: the menu, the note, and the reset', () => {
  it('no model: the first option follows the workspace, naming what it is, and the note says so; no reset link', () => {
    const v = agentModelView(null, 'sonnet');
    expect(v.selected).toBe(FOLLOW_WORKSPACE);
    expect(v.options.map((o) => o.label)).toEqual(['Workspace default (Sonnet)', 'Opus', 'Sonnet', 'Haiku']);
    expect(v.note).toBe('Uses the workspace default (Sonnet). Change it for this agent only.');
    expect(v.reset).toBe(false);
  });
  it('a chosen model says only this agent uses it and offers the reset', () => {
    const v = agentModelView('haiku', 'sonnet');
    expect(v.selected).toBe('haiku');
    expect(v.note).toBe('Only this agent uses Haiku.');
    expect(v.reset).toBe(true);
  });
  it('the three carry a short tradeoff each; the workspace row carries none', () => {
    const v = agentModelView(null, null);
    expect(v.options[0]!.tradeoff).toBeUndefined();
    expect(v.options.slice(1).every((o) => (o.tradeoff ?? '').length > 5)).toBe(true);
  });
  it('a workspace with no default says so in words: the tool’s own default, because the API passes no --model then', () => {
    expect(agentModelView(null, null).options[0]!.label).toBe(`Workspace default (${TOOL_DEFAULT_LABEL})`);
    expect(modelLabel(null)).toBe(TOOL_DEFAULT_LABEL);
    expect(modelLabel('')).toBe(TOOL_DEFAULT_LABEL);
  });
  it('a model saved outside this page (a full model name) is kept, shown as chosen and still resettable', () => {
    const v = agentModelView('claude-opus-4-1', 'sonnet');
    expect(v.selected).toBe('claude-opus-4-1');
    expect(v.options.map((o) => o.value)).toContain('claude-opus-4-1');
    expect(v.note).toBe('Only this agent uses claude-opus-4-1.');
    expect(v.reset).toBe(true);
  });
  it('reset stores null (the API reads null as "follow the workspace"); a pick stores the text itself', () => {
    expect(modelToStore(FOLLOW_WORKSPACE)).toBeNull();
    expect(modelToStore('opus')).toBe('opus');
  });
  it('every value the menu can store passes the API’s own validator', () => {
    for (const o of agentModelView(null, null).options.slice(1)) expect(modelProblem(o.value), o.value).toBeNull();
    expect(modelProblem(null)).toBeNull();
    expect(modelProblem('--dangerously-skip-permissions')).toMatch(/must be a model name/);
  });
  it('Cursor chooses its own model: the menu is not controllable when it is the tool; unknown tool is controllable', () => {
    expect(modelControllable('cursor')).toBe(false);
    expect(modelControllable('claude-code')).toBe(true);
    expect(modelControllable(undefined)).toBe(true);
  });
});

describe('the workspace default (Agent rules)', () => {
  it('offers Sonnet, Opus, Haiku, then the tool’s own default, in that order', () => {
    expect(WORKSPACE_MODEL_OPTIONS.map((o) => o.label)).toEqual(['Sonnet', 'Opus', 'Haiku', 'Claude Code’s own default']);
  });
  it('"Claude Code’s own default" is stored as null, and null reads back as that option; the three store their alias', () => {
    expect(workspaceModelToStore('tool')).toBeNull();
    expect(workspaceModelSelected(null)).toBe('tool');
    expect(workspaceModelSelected(undefined)).toBe('tool');
    expect(workspaceModelToStore('opus')).toBe('opus');
    expect(workspaceModelSelected('haiku')).toBe('haiku');
    for (const o of WORKSPACE_MODEL_OPTIONS) expect(modelProblem(workspaceModelToStore(o.value)), o.value).toBeNull();
  });
  it('only an admin may change it (the API refuses everyone else); members, guests and a role not yet loaded may not', () => {
    expect(canEditWorkspaceModel('admin')).toBe(true);
    for (const r of ['member', 'guest', undefined, '']) expect(canEditWorkspaceModel(r as string | undefined)).toBe(false);
  });
});

describe('who may change an agent’s tools and model', () => {
  it('whoever may update records in the Agents database, the server’s own bar: contributor and up', () => {
    for (const a of ['contributor', 'editor', 'creator', 'admin'] as const) expect(canEditAgentSettings(a), a).toBe(true);
  });
  it('a viewer, a commenter and an access level not yet known may not (read-only, never "allowed until told otherwise")', () => {
    for (const a of ['viewer', 'commenter', undefined, null] as const) expect(canEditAgentSettings(a), String(a)).toBe(false);
  });
  it('the read-only line names who manages the agent, or "its owner" when that person is not known', () => {
    expect(readOnlyLine('Ievgen Krasovytskyi')).toBe('Only Ievgen Krasovytskyi, who manages this agent, can change these.');
    expect(readOnlyLine(null)).toBe('Only its owner, who manages this agent, can change these.');
  });
});
