import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import type { ChangeSource } from '../db/schema';
import type {
  CreateSkillInput,
  SkillExport,
  SkillExportFormat,
  SkillRunResult,
  SkillRunStep,
  SkillSummary,
  SkillTemplate,
  SkillVisibility,
  UpdateSkillInput,
} from '@storyos/schemas';
import { SKILL_TEMPLATES } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { skills } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { scopeForRole } from '../agents/agent-principal';
import { renderSkillExport } from './skill-export';
import { buildSkillImport } from './skill-import';
import type { ImportReport } from './skill-import';

type SkillRow = typeof skills.$inferSelect;

/**
 * #841 — what the service hands to IN-PROCESS callers (packs hash and re-install skills,
 * and a pack's content hash has always included `allowed_tools`, so dropping it there would
 * flip every installed pack to "changed since install"). It is NOT what an API client
 * receives: the controller strips it with `publicSkill` at the boundary.
 */
export type SkillView = SkillSummary & { allowed_tools: string[] };

/** Strip the retired `allowed_tools` from anything that crosses the API boundary. */
export function publicSkill<T extends { allowed_tools?: unknown }>(skill: T): Omit<T, 'allowed_tools'> {
  const { allowed_tools: _retired, ...rest } = skill;
  void _retired;
  return rest;
}

/** `allowed_tools` is rejected at the API (see the schema); packs still carry it internally. */
export type InternalCreateSkillInput = Omit<CreateSkillInput, 'allowed_tools'> & { allowed_tools?: string[] };

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

  private present(row: SkillRow, callerUserId: string): SkillView {
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
      source: row.source,
      last_run_at: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      last_run_status: (row.lastRunStatus as 'ok' | 'error' | null) ?? null,
      editable: row.ownerId === callerUserId,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /**
   * Every skill visible to this caller: their own, plus every shared one — and, for a
   * workspace ADMIN, every skill in the workspace including other people's `personal`
   * ones (#841 AC5, Ievgen's rule). A `personal` skill is "Only me" to everyone ELSE;
   * the API never calls it "private", because personal-space.md uses that word for
   * private-FROM-admins and the two must not collide.
   */
  async list(membership: Membership, userId: string): Promise<{ data: SkillView[] }> {
    const rows = await this.db.query.skills.findMany({
      where: and(
        eq(skills.workspaceId, membership.workspaceId),
        membership.role === 'admin' ? undefined : or(eq(skills.ownerId, userId), eq(skills.visibility, 'shared')),
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
    if (!row || (row.visibility === 'personal' && row.ownerId !== userId && membership.role !== 'admin')) {
      throw new NotFoundException('Skill not found');
    }
    return row;
  }

  async get(membership: Membership, userId: string, id: string): Promise<SkillView> {
    const row = await this.findVisible(membership, userId, id);
    return this.present(row, userId);
  }

  /**
   * #442 — a non-human author may write a PERSONAL skill and may not publish
   * a shared one.
   *
   * The asymmetry is the point. A personal skill is reachable only by the
   * identity that owns the token, i.e. the same person who asked for it, so
   * review would add friction and protect nobody. A SHARED skill is
   * instructions every other member's agent will follow — publishing one is a
   * decision about other people, and ADR-0010's reasoning applies unchanged:
   * an agent may queue work for a human to decide and never decide for one.
   *
   * So an agent-authored skill starts personal, and a human promotes it in-app
   * once they have read it. Enforced HERE rather than in the MCP tool, because
   * a rule that lives in the client is a suggestion — any PAT holder could
   * otherwise POST `visibility: "shared"` directly.
   */
  private assertMayPublish(source: ChangeSource, visibility: SkillVisibility): void {
    // #841: EVERY tier above `personal`, not just `shared`. Sharing with three named people
    // (`members`) is the same breach of ADR-0010 as sharing with the workspace — arguably
    // worse, because it looks deliberate and targeted — and `public` is an unauthenticated
    // URL. Written as "anything but personal" so a tier added later is gated by default.
    if (visibility !== 'personal' && source !== 'human') {
      throw new ForbiddenException(
        `A skill authored over the API cannot be shared (\`${visibility}\`) directly — it is created as \`personal\`. ` +
          "A shared skill is instructions other people's agents follow, so publishing one is a decision a person " +
          'makes, not an agent (ADR-0010).',
      );
    }
  }

  async create(
    membership: Membership,
    userId: string,
    input: InternalCreateSkillInput,
    /** Derived from the request's auth, never from the body (#390's precedent). */
    source: ChangeSource = 'human',
  ): Promise<SkillView> {
    // #832: omitted visibility depends on who is writing. A person's skill is shared with
    // the workspace (so "my skill, your AI" works without a settings step); an agent's stays
    // personal — it may not publish (#442 / ADR-0010), and defaulting an agent to `shared`
    // would turn every omitted field into a 403 instead of a safe personal skill.
    const visibility: SkillVisibility = input.visibility ?? (source === 'human' ? 'shared' : 'personal');
    this.assertMayPublish(source, visibility);
    const [row] = await this.db
      .insert(skills)
      .values({
        workspaceId: membership.workspaceId,
        ownerId: userId,
        visibility,
        name: input.name,
        description: input.description,
        whenToUse: input.when_to_use,
        instructions: input.instructions,
        examples: input.examples,
        allowedTools: input.allowed_tools ?? [],
        sourceTemplate: input.source_template ?? null,
        source,
      })
      .returning();
    return this.present(row!, userId);
  }

  /**
   * #841 — import a SKILL.md. The report is computed BEFORE anything is written and is part
   * of every response; `create` only decides whether the record follows. A file that cannot
   * become a valid skill (missing or over-long fields) is reported, and refuses to create
   * with that report attached rather than writing a guess.
   */
  async importSkill(
    membership: Membership,
    userId: string,
    req: { content: string; create: boolean; overrides?: Parameters<typeof buildSkillImport>[1] },
    source: ChangeSource = 'human',
  ): Promise<{ report: ImportReport; importable: boolean; created: SkillView | null }> {
    const { input, report } = buildSkillImport(req.content, req.overrides);
    if (!req.create) return { report, importable: input !== null, created: null };
    if (!input) {
      // The error envelope carries `details: [{ path, message }]`, so the reasons ride there;
      // the full KEPT/DROPPED report is what a create:false call returns.
      throw new UnprocessableEntityException({
        message:
          'This file cannot be imported as it stands. Nothing was created. Call import without `create` for the full KEPT/DROPPED report.',
        details: [
          ...report.missing.map((path) => ({
            path,
            message: 'The file does not supply this and StoryOS will not invent it — pass it in `overrides`.',
          })),
          ...report.problems.map((message) => ({ message })),
        ],
      });
    }
    const created = await this.create(membership, userId, input, source);
    return { report, importable: true, created };
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
    /** Derived from the request's auth, never from the body (#390's precedent). */
    source: ChangeSource = 'human',
  ): Promise<SkillView> {
    await this.requireOwner(membership, userId, id);
    // Promoting an existing skill to `shared` is the same decision as creating
    // one shared, so it meets the same gate — otherwise the create-side rule is
    // one PATCH away from being decorative.
    if (input.visibility !== undefined) this.assertMayPublish(source, input.visibility);
    const patch: Partial<typeof skills.$inferInsert> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.when_to_use !== undefined) patch.whenToUse = input.when_to_use;
    if (input.instructions !== undefined) patch.instructions = input.instructions;
    if (input.examples !== undefined) patch.examples = input.examples;
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
   * Manual run (AC #3): there is no composer, slash-command or in-app Run surface,
   * so this is invoked directly — the "current
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
