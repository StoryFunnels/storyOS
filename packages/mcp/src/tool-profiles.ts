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
 * Record work: read the record and its comments, find related records, check a count, change a field, comment. `describe_database` is
 * here because `update_record` needs the field names and select-option ids; `count_records` because an agent must never state a count it
 * did not get from a tool (CLAUDE.md, Tyron rules). Everything else (create/delete/link/schema/skills/webhooks/...) is a role EXTRA.
 */
export const AGENT_RUN_BASE_TOOLS = [
  'get_record',
  'list_comments',
  'query_records',
  'count_records',
  'describe_database',
  'update_record',
  'add_comment',
] as const;

const PROFILES: Record<string, readonly string[]> = { [AGENT_RUN_PROFILE]: AGENT_RUN_BASE_TOOLS };

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export type ProfileResult =
  | { ok: true; allow: ReadonlySet<string> | undefined }
  | { ok: false; error: string };

/**
 * THE one place a run's tool list is derived: the profile's base set plus the role's extras (`tools=a,b`). No profile = no filter
 * (`allow: undefined`). Pure: query in, set out. A name that does not look like a tool name is refused rather than ignored.
 */
export function resolveToolProfile(query: URLSearchParams): ProfileResult {
  const profile = query.get('profile');
  const extras = query.get('tools');
  if (profile === null) {
    return extras === null ? { ok: true, allow: undefined } : { ok: false, error: 'tools= needs a profile= (it adds tools to a profile)' };
  }
  const base = PROFILES[profile];
  if (!base) return { ok: false, error: `unknown tool profile "${profile.slice(0, 40)}"; known: ${Object.keys(PROFILES).join(', ')}` };
  const allow = new Set<string>(base);
  if (extras) {
    for (const raw of extras.split(',')) {
      const name = raw.trim();
      if (!name) continue;
      if (!TOOL_NAME.test(name)) return { ok: false, error: `tools= contains something that is not a tool name: "${name.slice(0, 40)}"` };
      allow.add(name);
    }
  }
  return { ok: true, allow };
}
