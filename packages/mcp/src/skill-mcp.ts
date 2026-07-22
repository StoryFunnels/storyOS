import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, EffectiveScope } from './client.js';
import { listSkills, listWorkspaces, type SkillRef, type WorkspaceRef } from './resolve.js';

/**
 * #41 — skills as native MCP primitives (resources + prompts), on top of the
 * list_skills/run_skill TOOLS registered in tools.ts. Tools work with any MCP
 * client already; resources/prompts are for clients that understand those spec
 * primitives specifically, so they can browse a workspace's skills and paste one
 * in as instructions without calling a tool first — the ticket's "portable
 * resources" half.
 *
 * Both primitives are read-only views over the exact same skills a token can
 * already see via list_skills: SkillsService.list (behind GET
 * /workspaces/:ws/skills) enforces personal-vs-shared visibility server-side,
 * and this module only ever calls through that same endpoint (via
 * resolve.ts's listSkills) — nothing here reimplements the rule.
 */

const SCHEME = 'storyos-skill';

/** Cap on how many (workspace, skill) pairs get turned into resources/prompts —
 * generous for the realistic case (one PAT is minted for one workspace; a
 * session/OAuth login spans however many the user belongs to) while bounding
 * the worst case instead of registering an unbounded number of prompts. */
const MAX_SKILL_PRIMITIVES = 300;

interface SkillEntry {
  workspace: WorkspaceRef;
  skill: SkillRef;
}

function skillUri(workspaceId: string, skillId: string): string {
  return `${SCHEME}://${workspaceId}/${skillId}`;
}

/** Every (workspace, skill) pair visible to this token, best-effort per
 * workspace — one workspace's skills failing to load (a transient error, a
 * workspace the token can list but not read skills in) must never blank out
 * every other workspace's catalog. */
async function collectSkillEntries(ctx: Ctx): Promise<SkillEntry[]> {
  const out: SkillEntry[] = [];
  const workspaces: WorkspaceRef[] = await listWorkspaces(ctx.client).catch(() => []);
  for (const workspace of workspaces) {
    if (out.length >= MAX_SKILL_PRIMITIVES) break;
    try {
      const skills = await listSkills(ctx.client, workspace.id);
      for (const skill of skills) out.push({ workspace, skill });
    } catch {
      // Best-effort: skip this workspace, keep the rest.
    }
  }
  return out.slice(0, MAX_SKILL_PRIMITIVES);
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'skill';
}

/** A stable, unique prompt name for one skill: `skill_<name>`, disambiguated
 * with the workspace name (then a numeric suffix) only when two entries collide. */
function skillPromptName(entry: SkillEntry, seen: Set<string>): string {
  const base = `skill_${slug(entry.skill.name)}`;
  const withWorkspace = `skill_${slug(entry.workspace.name)}_${slug(entry.skill.name)}`;
  let candidate = seen.has(base) ? withWorkspace : base;
  let n = 2;
  while (seen.has(candidate)) candidate = `${withWorkspace}_${n++}`;
  seen.add(candidate);
  return candidate;
}

/** Render a skill as the same portable Markdown shape skill-export.ts's
 * `markdown` format produces (apps/api/src/skills/skill-export.ts) — duplicated
 * rather than imported: this package doesn't depend on apps/api, and the export
 * renderer is a pure function of plain fields this module already has. */
function renderSkillMarkdown(skill: SkillRef): string {
  const parts = [
    `# ${skill.name}`,
    '',
    skill.description,
    '',
    '## When to use',
    '',
    skill.when_to_use,
    '',
    '## Instructions',
    '',
    skill.instructions,
  ];
  if (skill.examples.length) {
    parts.push(
      '',
      '## Examples',
      '',
      skill.examples.map((e, i) => `**Example ${i + 1}**\n\nInput: ${e.input}\n\nOutput: ${e.output}`).join('\n\n'),
    );
  }
  if (skill.allowed_tools.length) {
    parts.push('', '## Allowed tools', '', ...skill.allowed_tools.map((t) => `- ${t}`));
  }
  return parts.join('\n') + '\n';
}

/**
 * Register skills as MCP resources (a browsable, read-only catalog under a
 * `storyos-skill://{workspace}/{skill}` template) and prompts (one named,
 * pasteable prompt per visible skill) — the spec primitives a compatible
 * client lists natively, in addition to the list_skills/run_skill tools every
 * client gets regardless of whether it understands resources/prompts.
 *
 * No scope gating beyond `effective` already being resolved: list_skills (the
 * tool) requires only `read`, the lowest scope that exists, so any connected
 * token that gets this far can already see every skill these primitives would
 * show — there's no narrower floor to enforce here.
 */
export async function registerSkillPrimitives(server: McpServer, ctx: Ctx, _effective: EffectiveScope): Promise<void> {
  const entries = await collectSkillEntries(ctx);

  server.registerResource(
    'skills',
    new ResourceTemplate(`${SCHEME}://{workspace}/{skill}`, {
      list: async () => ({
        resources: entries.map(({ workspace, skill }) => ({
          uri: skillUri(workspace.id, skill.id),
          name: skill.name,
          title: skill.name,
          description: `[${workspace.name}] ${skill.description} — ${skill.when_to_use}`,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'StoryOS skill',
      description:
        "A workspace's saved skill, rendered as portable Markdown instructions — the same document " +
        'run_skill and GET /skills/:id/export?format=markdown produce.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const wsId = Array.isArray(variables.workspace) ? variables.workspace[0] : variables.workspace;
      const skillId = Array.isArray(variables.skill) ? variables.skill[0] : variables.skill;
      const entry = entries.find((e) => e.workspace.id === wsId && e.skill.id === skillId);
      if (!entry) throw new Error(`Unknown skill resource: ${uri.toString()}`);
      return {
        contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: renderSkillMarkdown(entry.skill) }],
      };
    },
  );

  const seen = new Set<string>();
  for (const entry of entries) {
    const name = skillPromptName(entry, seen);
    server.registerPrompt(
      name,
      {
        title: entry.skill.name,
        description: `[${entry.workspace.name}] ${entry.skill.description}`,
      },
      async () => ({
        description: entry.skill.description,
        messages: [
          {
            role: 'user' as const,
            content: { type: 'text' as const, text: renderSkillMarkdown(entry.skill) },
          },
        ],
      }),
    );
  }
}
