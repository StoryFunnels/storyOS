import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import type {
  CreateSkillInput,
  SkillExport,
  SkillExportFormat,
  SkillRunResult,
  SkillRunStep,
  SkillSummary,
  SkillTemplate,
  UpdateSkillInput,
} from '@storyos/schemas';
import { SKILL_TEMPLATES } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { skills } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { scopeForRole } from '../agents/agent-principal';
import { renderSkillExport } from './skill-export';

type SkillRow = typeof skills.$inferSelect;

/**
 * #40 — the Skills framework.
 *
 * Storage is a plain table (see schema.ts's note on why this is not a
 * provisioned "pack" database like AgentsService.ensurePack): a skill is
 * portable prose, not a schema of typed fields.
 *
 * Visibility is the whole access model (AC #1's "personal vs team-shared"):
 * a `personal` skill is invisible to everyone but its owner — hidden with a
 * 404, never a 403, the same convention FavoritesService uses for cross-tenant
 * reads — and a `shared` skill is readable/runnable by any workspace member
 * but still owner-only to edit or delete (403, because by the time someone
 * reaches an edit route on a shared skill its existence is not new
 * information to them).
 *
 * `run` (AC #3's "run a skill") rides the exact same manual-run seam the
 * agents engine exposes (ADR-0010 §3): resolve a principal capped at the
 * caller's own role, execute with no model (StoryOS has no managed runtime
 * configured yet — see agent-runtime.ts's ManagedAiRuntime stub), and hand
 * back an inspectable step log. It does NOT go through AgentsService/
 * NonAiRuntime directly — those are written in terms of an *agent record*
 * (targetDatabases, an agent's own declared scopes), and a skill has neither;
 * duplicating the three-step shape here keeps the output honest about what a
 * skill run actually resolved rather than borrowing agent-shaped language for
 * a differently-shaped thing.
 */
@Injectable()
export class SkillsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private present(row: SkillRow, callerUserId: string): SkillSummary {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      owner_id: row.ownerId,
      visibility: row.visibility,
      name: row.name,
      description: row.description,
      when_to_use: row.whenToUse,
      instructions: row.instructions,
      examples: (row.examples ?? []) as SkillSummary['examples'],
      allowed_tools: (row.allowedTools ?? []) as string[],
      source_template: row.sourceTemplate,
      last_run_at: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      last_run_status: (row.lastRunStatus as 'ok' | 'error' | null) ?? null,
      editable: row.ownerId === callerUserId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /** Every skill visible to this caller: their own, plus every shared one. */
  async list(membership: Membership, userId: string): Promise<{ data: SkillSummary[] }> {
    const rows = await this.db.query.skills.findMany({
      where: and(
        eq(skills.workspaceId, membership.workspaceId),
        or(eq(skills.ownerId, userId), eq(skills.visibility, 'shared')),
      ),
      orderBy: [desc(skills.createdAt)],
    });
    return { data: rows.map((r) => this.present(r, userId)) };
  }

  templates(): { data: SkillTemplate[] } {
    return { data: SKILL_TEMPLATES };
  }

  /** Visible-to-caller lookup — 404 (never 403) if it doesn't exist OR is
   * someone else's personal skill, so a personal skill's existence is never
   * confirmed to anyone but its owner. */
  private async findVisible(
    membership: Membership,
    userId: string,
    id: string,
  ): Promise<SkillRow> {
    const row = await this.db.query.skills.findFirst({
      where: and(eq(skills.id, id), eq(skills.workspaceId, membership.workspaceId)),
    });
    if (!row || (row.visibility === 'personal' && row.ownerId !== userId)) {
      throw new NotFoundException('Skill not found');
    }
    return row;
  }

  async get(membership: Membership, userId: string, id: string): Promise<SkillSummary> {
    const row = await this.findVisible(membership, userId, id);
    return this.present(row, userId);
  }

  async create(
    membership: Membership,
    userId: string,
    input: CreateSkillInput,
  ): Promise<SkillSummary> {
    const [row] = await this.db
      .insert(skills)
      .values({
        workspaceId: membership.workspaceId,
        ownerId: userId,
        visibility: input.visibility,
        name: input.name,
        description: input.description,
        whenToUse: input.when_to_use,
        instructions: input.instructions,
        examples: input.examples,
        allowedTools: input.allowed_tools,
        sourceTemplate: input.source_template ?? null,
      })
      .returning();
    return this.present(row!, userId);
  }

  /** Owner-only (visible-but-not-mine is a 403 here — see class doc). */
  private async requireOwner(membership: Membership, userId: string, id: string): Promise<SkillRow> {
    const row = await this.findVisible(membership, userId, id);
    if (row.ownerId !== userId) {
      throw new ForbiddenException('Only the skill\'s owner can change it');
    }
    return row;
  }

  async update(
    membership: Membership,
    userId: string,
    id: string,
    input: UpdateSkillInput,
  ): Promise<SkillSummary> {
    await this.requireOwner(membership, userId, id);
    const patch: Partial<typeof skills.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.when_to_use !== undefined) patch.whenToUse = input.when_to_use;
    if (input.instructions !== undefined) patch.instructions = input.instructions;
    if (input.examples !== undefined) patch.examples = input.examples;
    if (input.allowed_tools !== undefined) patch.allowedTools = input.allowed_tools;
    if (input.visibility !== undefined) patch.visibility = input.visibility;

    const [row] = await this.db
      .update(skills)
      .set(patch)
      .where(eq(skills.id, id))
      .returning();
    return this.present(row!, userId);
  }

  async remove(membership: Membership, userId: string, id: string): Promise<{ deleted: true }> {
    await this.requireOwner(membership, userId, id);
    await this.db.delete(skills).where(eq(skills.id, id));
    return { deleted: true };
  }

  async exportSkill(
    membership: Membership,
    userId: string,
    id: string,
    format: SkillExportFormat,
  ): Promise<SkillExport> {
    const row = await this.findVisible(membership, userId, id);
    return renderSkillExport(this.present(row, userId), format);
  }

  /**
   * Manual run (AC #3): the composer/slash-command surface doesn't exist yet
   * (#39/the chat UI), so this is invoked directly — the "current
   * agent-invocation surface" the ticket asks for in that surface's absence.
   * Visible-to-caller is enough to run (unlike edit): a shared skill is meant
   * to be run by the whole team, not just its author.
   */
  async run(membership: Membership, userId: string, id: string): Promise<SkillRunResult> {
    const row = await this.findVisible(membership, userId, id);
    const principalScope = scopeForRole(membership.role);

    const steps: SkillRunStep[] = [
      {
        tool: 'principal.resolve',
        summary: `Resolved principal — running as you, capped to \`${principalScope}\` scope`,
        detail:
          `A skill has no execution identity of its own (unlike an agent, ADR-0010 §2) — it always ` +
          `runs as the caller, capped by workspace role (admin -> admin, member -> write, guest -> read).`,
      },
      {
        tool: 'skill.instructions',
        summary: row.whenToUse.trim()
          ? `When to use: ${row.whenToUse.trim()}`
          : 'No "when to use" set on this skill',
        detail: row.instructions,
      },
      {
        tool: 'skill.tools',
        summary:
          (row.allowedTools as string[] | null)?.length
            ? `Allowed tools: ${(row.allowedTools as string[]).join(', ')}`
            : 'No tools declared — this skill is advisory only',
        detail:
          'Tool access over MCP is a separate ticket (#41); today this list is read-only metadata ' +
          'carried on the skill for that future allowlist.',
      },
      {
        tool: 'runtime.note',
        summary: 'No model was invoked — StoryOS has no managed runtime configured yet',
        detail:
          'Same as a manual agent run (ADR-0010 §3): this is a real, inspectable resolution of ' +
          'principal + instructions + tools, not a model call. Drive these instructions with your ' +
          'own AI over MCP (BYO-AI, never metered), or apply them by hand.',
      },
    ];

    const result: SkillRunResult = {
      run_class: 'non_ai',
      steps,
      ran_at: new Date().toISOString(),
    };

    await this.db
      .update(skills)
      .set({
        lastRunAt: new Date(result.ran_at),
        lastRunStatus: 'ok',
        lastRunSteps: steps,
      })
      .where(eq(skills.id, id));

    return result;
  }
}
