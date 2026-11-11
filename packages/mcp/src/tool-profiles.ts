/**
 * #1177 — tool PROFILES: the short list of tools an agent run is offered, instead of every tool its credential could call.
 *
 * Why this exists: a write-scoped agent credential is offered ~120 tools, and a model is billed for every tool definition (name,
 * description, JSON schema) on EVERY request of a run. Measured on a one-comment wake: ~31k of the ~37k tokens per request were tool
 * definitions, 3 requests per wake. `--allowedTools` on the CLI does not help (permission only; the schemas are still sent), so
 * the cut has to be on the server's `tools/list`.
 *
 * This is ADVERTISING, exactly like the scope and role gates in tools.ts `reg()`: a tool outside the profile is never registered, so a
 * call to it by name is "tool not found", and the API guard still enforces the credential's real scope on everything that IS offered.
 * It is not a permission system and must never be read as one.
 *
 * A profile is chosen by the CALLER (`?profile=agent-run` on the MCP URL, which the Runner adapter sets). With no profile the server
 * behaves as it always did: a person's Claude Desktop, ChatGPT or claude.ai connection sees its full scope- and role-limited set. An
 * unknown profile name is an ERROR, never "the full set": a typo must not silently turn the diet off.
 *
 * DEFAULT FOR A NEW TOOL: not offered to a profile. A profile is an allowlist; adding a tool to the registry changes nothing a run sees
 * until someone adds its name here, and tool-profiles.test.ts fails if a name here is not in the live registry.
 */
export const AGENT_RUN_PROFILE = 'agent-run';

/**
 * ticket #1262: the INTERNAL profile (`?profile=internal`, or STORYOS_MCP_PROFILE=internal for a stdio server) is the full tool set PLUS the
 * tools below. It is for the people building StoryOS, never for a customer's connection.
 */
export const INTERNAL_PROFILE = 'internal';

/**
 * ticket #1262: tools that are not part of any CUSTOMER surface, because a customer's AI can do nothing useful with them and each costs
 * every session its description:
 *  - get_branch_name: the git lane prefixes (docs/mcp/api/web/fix) of THIS repo's own workflow;
 *  - get_pinned_tabs / set_pinned_tabs / get_dismissed_hints / set_dismissed_hints: a person's own UI state (tab strip, one-time hint
 *    cards), which an AI has no business reading or rewriting;
 *  - list_icon_set: a picker catalogue (an icon NAME is what a call needs, and get_started now carries that list).
 * list_youtube_channels is deliberately NOT here: the web app's sources dialog calls the same endpoint (apps/web sources-dialog.tsx) and
 * create_source for a youtube.* provider needs its channel_id, so it is a customer feature.
 * Not registered unless the profile is internal, whatever the scope, role or `tools=` extras say.
 * tool-description-budget.test.ts fails if a customer profile lists one.
 */
export const INTERNAL_TOOLS: ReadonlySet<string> = new Set([
  'get_branch_name',
  'get_pinned_tabs',
  'set_pinned_tabs',
  'get_dismissed_hints',
  'set_dismissed_hints',
  'list_icon_set',
]);

/**
 * Record work: read the record and its comments, find related records, check a count, change a field, comment, file a new record. `describe_database` is
 * here because `update_record` needs the field names and select-option ids; `count_records` because an agent must never state a count it
 * did not get from a tool (CLAUDE.md, Tyron rules). Everything else (delete/link/schema/skills/webhooks/...) is a role EXTRA.
 */
export const AGENT_RUN_BASE_TOOLS = [
  'get_record',
  'list_comments',
  'query_records',
  'count_records',
  'describe_database',
  'update_record',
  'add_comment',
  // #1180: agents routinely file a task or a note. A role EXTRA used to be needed for this; it is the one write that is almost always wanted.
  'create_record',
] as const;

const PROFILES: Record<string, readonly string[]> = { [AGENT_RUN_PROFILE]: AGENT_RUN_BASE_TOOLS };

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export type ProfileResult =
  | { ok: true; allow: ReadonlySet<string> | undefined; internal: boolean }
  | { ok: false; error: string };

/**
 * THE one place a run's tool list is derived: the profile's base set plus the role's extras (`tools=a,b`). No profile = no filter
 * (`allow: undefined`). Pure: query in, set out. A name that does not look like a tool name is refused rather than ignored.
 */
export function resolveToolProfile(query: URLSearchParams): ProfileResult {
  const profile = query.get('profile');
  const extras = query.get('tools');
  if (profile === null) {
    return extras === null ? { ok: true, allow: undefined, internal: false } : { ok: false, error: 'tools= needs a profile= (it adds tools to a profile)' };
  }
  if (profile === INTERNAL_PROFILE) {
    return extras === null ? { ok: true, allow: undefined, internal: true } : { ok: false, error: 'tools= does not apply to profile=internal (it already offers every tool)' };
  }
  const base = PROFILES[profile];
  if (!base) return { ok: false, error: `unknown tool profile "${profile.slice(0, 40)}"; known: ${[...Object.keys(PROFILES), INTERNAL_PROFILE].join(', ')}` };
  const allow = new Set<string>(base);
  if (extras) {
    for (const raw of extras.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (!TOOL_NAME.test(name)) return { ok: false, error: `tools= contains something that is not a tool name: "${name.slice(0, 40)}"` };
      allow.add(name);
    }
  }
  return { ok: true, allow, internal: false };
}
