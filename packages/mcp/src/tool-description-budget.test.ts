import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MCP_TOOL_NAMES } from '@storyos/schemas';
import { SHORT_DESCRIPTION_CAP, TOOL_NOTES_HEADING, registerTools, shortenDescription } from './tools.js';
import { AGENT_RUN_BASE_TOOLS, AGENT_RUN_PROFILE, INTERNAL_PROFILE, INTERNAL_TOOLS, resolveToolProfile } from './tool-profiles.js';
import type { Ctx, EffectiveScope } from './client.js';

/**
 * ticket #1262 - MCP is too heavy for capped clients. Every description a client lists is billed on every request of every session
 * (214 tools were ~97.7k characters of descriptions before this ticket), so the budget below is a test, not a convention: a new tool
 * with a long paragraph fails here, and the paragraph belongs in get_started's TOOL NOTES (a get_started RESULT is only loaded when
 * called, so it costs a capped client nothing up front).
 *
 * Everything is derived from the LIVE registry (registerTools against a recording server). A hand-copied list of tool names would pass
 * for exactly the names it omits.
 */
const TOTAL_CAP = 60_000;
const PER_TOOL_CAP = 1_500;

const ctx = { client: {} as never, baseUrl: 'http://t', token: 't' } as Ctx;
const ADMIN: EffectiveScope = { scope: 'admin', allowRunButton: true };

type Registered = { descriptions: Map<string, string>; notes: ReadonlyMap<string, string>; started: () => Promise<string> };
function register(effective: EffectiveScope): Registered {
  const descriptions = new Map<string, string>();
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }> }>>();
  const notes = registerTools(
    {
      registerTool: (n: string, c: { description?: string }, h: never) => {
        descriptions.set(n, c.description ?? '');
        handlers.set(n, h);
      },
    } as never,
    ctx,
    effective,
  );
  return { descriptions, notes, started: async () => (await handlers.get('get_started')!({})).content[0]!.text };
}

const customer = register(ADMIN);
const internal = register({ ...ADMIN, internal: true });

/** The text under `[tool]` in get_started's TOOL NOTES. */
function noteIn(started: string, tool: string): string {
  const at = started.indexOf(`\n[${tool}]\n`);
  if (at < 0) return '';
  const rest = started.slice(at + tool.length + 4);
  const next = rest.search(/\n\[[a-z_0-9]+\]\n|\nICONS /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('ticket #1262 - the description budget', () => {
  it('covers the whole registry (so the caps below are not measuring a prefix of reality)', () => {
    expect(customer.descriptions.size).toBeGreaterThan(150);
  });

  it(`the descriptions total at most ${TOTAL_CAP} characters`, () => {
    const total = [...customer.descriptions.values()].reduce((sum, d) => sum + d.length, 0);
    expect(total, `total description characters (was 97,703 over 214 tools before ticket #1262)`).toBeLessThanOrEqual(TOTAL_CAP);
  });

  it(`no single description is longer than ${PER_TOOL_CAP} characters`, () => {
    const over = [...customer.descriptions].filter(([, d]) => d.length > PER_TOOL_CAP).map(([n, d]) => `${n} (${d.length})`);
    expect(over, 'put the long reference text in the description and let reg() move it to get_started, or hand-write a `short` lead').toEqual([]);
  });

  it('the internal profile is not smaller than the customer surface, and costs more only by the internal tools', () => {
    expect(internal.descriptions.size).toBe(customer.descriptions.size + INTERNAL_TOOLS.size);
  });
});

describe('ticket #1262 - maintainer tools are not on any customer profile', () => {
  // Derived from the live INTERNAL registry by shape of name, so a NEW tool of the same kind fails here instead of slipping in.
  const maintainerShaped = [...internal.descriptions.keys()].filter((n) => /branch_name|pinned_tabs|dismissed_hints|icon_set/.test(n));

  it('finds the six the ticket names (the pattern is not matching nothing)', () => {
    expect(maintainerShaped.sort()).toEqual(
      ['get_branch_name', 'get_dismissed_hints', 'get_pinned_tabs', 'list_icon_set', 'set_dismissed_hints', 'set_pinned_tabs'].sort(),
    );
  });

  it('every one of them is internal-only: not registered for a customer at any scope, absent from the choosable tool names', () => {
    for (const n of maintainerShaped) {
      expect(INTERNAL_TOOLS.has(n), `${n} must be in INTERNAL_TOOLS (tool-profiles.ts)`).toBe(true);
      expect(customer.descriptions.has(n), `${n} is offered to a customer`).toBe(false);
      expect(internal.descriptions.has(n), `${n} must still exist for the internal profile`).toBe(true);
      expect(MCP_TOOL_NAMES, `${n} must not be a choosable agent tool`).not.toContain(n);
      for (const scope of ['read', 'write'] as const) {
        expect(register({ scope, allowRunButton: true }).descriptions.has(n), `${n} at ${scope}`).toBe(false);
      }
    }
  });

  it('the agent-run profile does not list them, and `tools=` cannot add them back', () => {
    for (const n of maintainerShaped) expect(AGENT_RUN_BASE_TOOLS as readonly string[]).not.toContain(n);
    const r = resolveToolProfile(new URLSearchParams(`profile=${AGENT_RUN_PROFILE}&tools=${maintainerShaped.join(',')}`));
    if (!r.ok) throw new Error(r.error);
    const offered = register({ scope: 'admin', allowRunButton: true, role: 'admin', onlyTools: r.allow });
    for (const n of maintainerShaped) expect(offered.descriptions.has(n), `${n} via tools=`).toBe(false);
  });

  it('?profile=internal offers every tool plus the maintainer ones; an unknown profile is still an error', () => {
    const r = resolveToolProfile(new URLSearchParams(`profile=${INTERNAL_PROFILE}`));
    expect(r).toEqual({ ok: true, allow: undefined, internal: true });
    expect(resolveToolProfile(new URLSearchParams('profile=nope')).ok).toBe(false);
    expect(resolveToolProfile(new URLSearchParams(`profile=${INTERNAL_PROFILE}&tools=get_record`)).ok).toBe(false);
  });

  it('list_youtube_channels stays on the customer surface: the web sources dialog and create_source for youtube.* use it', () => {
    expect(customer.descriptions.has('list_youtube_channels')).toBe(true);
    expect(INTERNAL_TOOLS.has('list_youtube_channels')).toBe(false);
  });
});

describe('ticket #1262 - a short description carries its pointer, and the grammar is in get_started', () => {
  it('every shortened tool points at get_started, and every pointer has a note to land on', async () => {
    const started = await customer.started();
    expect(customer.notes.size).toBeGreaterThan(80);
    expect(started).toContain(TOOL_NOTES_HEADING);
    for (const [tool, full] of customer.notes) {
      const listed = customer.descriptions.get(tool)!;
      expect(listed, `${tool}: listed description must point at get_started`).toContain('get_started');
      expect(listed.length, `${tool}: a shortened description is shorter than the full one`).toBeLessThan(full.length);
      expect(noteIn(started, tool).trim(), `${tool}: get_started must carry its full text`).toBe(full.trim());
    }
  });

  it('a tool that was not shortened does not claim notes it does not have', () => {
    for (const [tool, listed] of customer.descriptions) {
      if (!customer.notes.has(tool)) expect(listed, tool).not.toContain('[Full notes: get_started');
    }
  });

  it('the four reference grammars the ticket names point at their own section by name', () => {
    for (const tool of ['create_automation', 'install_pack', 'add_field', 'create_source']) {
      expect(customer.descriptions.get(tool)!, tool).toContain(`call get_started, section TOOL NOTES [${tool}]`);
      expect(customer.descriptions.get(tool)!.length, tool).toBeLessThan(1_000);
    }
  });

  // An AI reading get_started must still be able to BUILD an automation and INSTALL a pack: the moved grammar is asserted, phrase by phrase.
  const GRAMMAR: Record<string, RegExp[]> = {
    create_automation: [
      /TRIGGERS: /,
      /\{type:"record_created"\}/,
      /\{type:"record_updated", field\?:"<name>"\}/,
      /\{type:"record_linked", relation_field:"<name>", direction\?:"link"\|"unlink"\}/,
      /\{type:"schedule", every:"minutes"\|"hour"\|"day"\|"week"/,
      /BELOW 10 is refused/,
      /weekdays\?:\[0-6,\.\.\.\]/,
      /\{type:"webhook_received"\}/,
      /ACTIONS \(array\): set_values\{values\}/,
      /create_record\{database, values, link_via_relation_field\?\}/,
      /create_records\{database, count, values/,
      /notify_user\{user:"@me"\|"@member:<id>"/,
      /send_email\{connection_id, to, subject, body_markdown\}/,
      /http_request\{method, url, headers\?, body_template\?, connection_id\?, capture\?/,
      /run_agent\{agent, prompt\?, target\?:"trigger_record"/,
      /TEMPLATE TOKENS usable in any templated field/,
      /\{changesSummary\}/,
      /TOP-N SET/,
      /Private and internal addresses are refused on http_request/,
      /SCHEDULED and TRIGGERED rules, not only from buttons/,
    ],
    install_pack: [
      /Install a Business Pack by slug \(from list_packs\)/,
      /Set preview to see exactly what it would do WITHOUT changing anything/,
      /`gains`/,
      /update_agents/,
      /existing_elsewhere/,
      /reuse_databases \{"Name": database_id\}/,
      /enable_automations/,
      /enable_agent_triggers/,
      /required_packs \{"agency-os": "also_install"\}/,
      /rolled back/,
      /\$agent:deal-coach/,
    ],
    add_field: [
      /Add a field to a database\. For select\/multi_select\/workflow pass options as labels/,
      /To do \/ In progress \/ Done/,
      /Formula config: \{expression, format\?, currency_code\?, precision\?\}/,
      /currency REQUIRES a 3-letter currency_code/,
      /Rollup config: \{relation_field_id, op\}/,
      /count\|sum\|avg\|min\|max/,
      /first\|last/,
      /AI field config: \{prompt, output\}/,
      /\{kind:"choice", options:\["a","b"\]\}/,
    ],
    create_source: [
      /CREDENTIALS NEVER PASS THROUGH THIS TOOL/,
      /field_mapping maps the provider's external keys to fields in THIS database/,
      /direction is "in"/,
      /external_key_field is the field holding the provider's stable id/,
      /config\.conflict_policy/,
      /"external_wins" \(default/,
      /config\.write_back must ALSO be true/,
      /require_approval_for_push/,
      /Defaults to a daily sync/,
    ],
  };

  for (const [tool, phrases] of Object.entries(GRAMMAR)) {
    it(`get_started carries ${tool}'s whole grammar (${phrases.length} key phrases)`, async () => {
      const note = noteIn(await customer.started(), tool);
      expect(note.length, `${tool} has a note`).toBeGreaterThan(1_000);
      for (const re of phrases) expect(note, `${tool}: ${re}`).toMatch(re);
    });
  }

  it('the long grammars come FIRST in get_started, so a client that cuts a long result cuts the generated tail', async () => {
    const started = await customer.started();
    const at = (t: string) => started.indexOf(`\n[${t}]\n`);
    const generated = [...customer.notes.keys()].find((t) => !/^(create_automation|install_pack|add_field|create_source|create_agent_trigger|create_skill|update_skill|run_skill|get_history|get_my_work|list_agent_wakes|list_runners|list_ai_connections|get_agent_budget|list_agent_write_gates)$/.test(t))!;
    for (const t of ['create_automation', 'install_pack', 'add_field', 'create_source']) expect(at(t), t).toBeGreaterThan(0);
    for (const t of ['create_automation', 'install_pack', 'add_field', 'create_source']) expect(at(t), `${t} before ${generated}`).toBeLessThan(at(generated));
  });

  it('what a shortened description still says at call time (the essentials), so a model that never calls get_started is not misled', () => {
    const d = (t: string) => customer.descriptions.get(t)!;
    expect(d('create_automation')).toContain('a wake queues and runs when an active, online Runner claims it (a wake nobody serves for 7 days is cancelled)');
    expect(d('create_automation')).toMatch(/send real email, call any public HTTP API and post to Slack/);
    expect(d('create_automation')).toContain('below 10 is refused');
    expect(d('install_pack')).toContain('preview:true');
    expect(d('install_pack')).toContain('SWITCHED OFF');
    expect(d('add_field')).toContain('use `workflow` (not `select`)');
    expect(d('create_source')).toContain('CREDENTIALS NEVER PASS THROUGH THIS TOOL');
    expect(d('create_agent_trigger')).toContain("a send_email whose recipients (to and cc) are all active workspace members runs as configured unless the agent's approval_policy lists email");
    expect(d('delete_webhook')).toMatch(/permanently/);
    expect(d('delete_space')).toMatch(/`confirm` must equal the space name/);
  });

  it('the params that used to say "see the tool description" now name where the shapes are', () => {
    const cfgs = new Map<string, { inputSchema?: unknown }>();
    registerTools({ registerTool: (n: string, c: never) => void cfgs.set(n, c) } as never, ctx, ADMIN);
    // What a client actually receives: the JSON schema the SDK derives from the registered zod object.
    const json = z.toJSONSchema(cfgs.get('create_automation')!.inputSchema as never, { io: 'input', unrepresentable: 'any' }) as { properties: Record<string, { description?: string }> };
    expect(json.properties.trigger!.description).toContain('get_started, TOOL NOTES [create_automation]');
    expect(json.properties.actions!.description).toContain('get_started, TOOL NOTES [create_automation]');
  });
});

describe('ticket #1262 - a profile without get_started is never given a pointer to it', () => {
  it('the agent-run profile keeps each description whole (a dangling pointer would be a false instruction)', () => {
    const r = resolveToolProfile(new URLSearchParams(`profile=${AGENT_RUN_PROFILE}`));
    if (!r.ok) throw new Error(r.error);
    const run = register({ scope: 'write', allowRunButton: false, role: 'member', onlyTools: r.allow });
    expect(run.notes.size).toBe(0);
    for (const [tool, d] of run.descriptions) {
      expect(d, tool).not.toContain('[Full notes: get_started');
      // and it is the very text the full registry keeps in get_started
      expect(customer.notes.get(tool) ?? customer.descriptions.get(tool), tool).toBe(d);
    }
  });
});

describe('ticket #1262 - ICONS replaces list_icon_set for a customer', () => {
  it('get_started lists the icon names the icon param takes, so the tool the param used to name is not missed', async () => {
    const started = await customer.started();
    expect(started).toMatch(/ICONS - |ICONS — /);
    expect(started).toContain('set:');
    expect(started).toContain('brand:');
    expect(started).toContain('rocket');
    expect(started).toContain('github');
  });
});

describe('ticket #1262 - shortenDescription', () => {
  it('leaves a short description alone', () => {
    expect(shortenDescription('Short and sweet.')).toBeNull();
  });

  it('cuts at a sentence end inside the cap, never mid-sentence, and never after "e.g."', () => {
    const full = `${'Alpha beta gamma. '.repeat(10)}Use it e.g. when stuff happens and the sentence goes on. ${'Delta epsilon zeta. '.repeat(30)}`;
    const lead = shortenDescription(full)!;
    expect(lead.length).toBeLessThanOrEqual(SHORT_DESCRIPTION_CAP);
    expect(lead.endsWith('.')).toBe(true);
    expect(full.startsWith(lead)).toBe(true);
    expect(lead).not.toMatch(/e\.g\.$/);
  });

  it('carries a late warning about something irreversible or needing confirmation into the lead', () => {
    const full = `Do the thing to a record. ${'It has plenty of detail that goes on and on. '.repeat(12)}THIS CANNOT BE UNDONE. More detail follows here.`;
    const lead = shortenDescription(full)!;
    expect(lead).toContain('THIS CANNOT BE UNDONE.');
    expect(lead).not.toContain('More detail follows');
  });
});
