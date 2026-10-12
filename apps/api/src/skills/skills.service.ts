import { ForbiddenException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, desc, eq, exists, inArray, or, sql, type SQL } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
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
import { memberships, skillMembers, skills, workspaces } from '../db/schema';
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

/**
 * #867 AC3 — how an AI's request to make a skill PUBLIC becomes a person's decision. Registered by
 * the automations module at boot (it owns approvals; importing it here would be a module cycle).
 * No gate registered means NO path to `public` for a non-human author: fail closed, a 403 exactly
 * as before #867. That is the one ordering rule that must never break (ticket #867 AC10).
 */
export interface PublicPublishGate {
  propose(input: {
    workspaceId: string;
    skillId: string;
    skillName: string;
    ownerId: string;
    requesterSource: ChangeSource;
  }): Promise<{ approvalId: string }>;
}

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

  /**
   * THE ONE PLACE "who can see this skill" is decided (#841, Otto's ruling on AC3).
   *
   * The `members` tier is backed by `skill_members`, a plain `(skill_id, user_id)` join, and
   * NOT by a fourth scope on `access_grants`: that table encodes a containment hierarchy
   * (space > database > record) and carries the roles that are the billing boundary, and a
   * skill is outside both. The price of "who can see this" having two homes is this rule:
   * NO grant consumer ever reads `skill_members`, and THIS function never reads
   * `access_grants`. Both list() and findVisible() go through it, so there is no second copy.
   *
   *   admin   — every skill in the workspace, including other people's `personal` ones
   *   others  — their own, every `shared` and `public` one, and a `members` one they are named on
   */
  private visibleTo(membership: Membership, userId: string): SQL | undefined {
    if (membership.role === 'admin') return undefined;
    return or(
      eq(skills.ownerId, userId),
      inArray(skills.visibility, ['shared', 'public']),
      and(
        eq(skills.visibility, 'members'),
        exists(
          this.db
            .select({ one: sql`1` })
            .from(skillMembers)
            .where(and(eq(skillMembers.skillId, skills.id), eq(skillMembers.userId, userId))),
        ),
      ),
    );
  }

  /** Mint the credential for a `public` skill: server-side only, never client-supplied. */
  private mintPublicToken(): string {
    return randomBytes(24).toString('base64url');
  }

  /** The people named on `members` skills, for the OWNER and workspace admins only. */
  private async memberIdsFor(rows: SkillRow[], membership: Membership, userId: string): Promise<Map<string, string[]>> {
    const wanted = rows
      .filter((r) => r.visibility === 'members' && (r.ownerId === userId || membership.role === 'admin'))
      .map((r) => r.id);
    const out = new Map<string, string[]>();
    if (wanted.length === 0) return out;
    const shares = await this.db.select().from(skillMembers).where(inArray(skillMembers.skillId, wanted));
    for (const s of shares) out.set(s.skillId, [...(out.get(s.skillId) ?? []), s.userId]);
    return out;
  }

  /** Every named user must be an ACTIVE member of THIS workspace: a share is not a way to
   *  reach someone outside it. Unknown ids are a 422 naming them, never silently dropped. */
  private async assertWorkspaceMembers(workspaceId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active'), inArray(memberships.userId, ids)));
    const have = new Set(found.map((f) => f.userId));
    const unknown = ids.filter((id) => !have.has(id));
    if (unknown.length) {
      throw new UnprocessableEntityException({
        message: 'member_ids must be active members of this workspace.',
        details: unknown.map((id) => ({ path: 'member_ids', message: `${id} is not an active member of this workspace` })),
      });
    }
  }

  private present(row: SkillRow, callerUserId: string, extras: { memberIds?: string[]; canSeeToken?: boolean } = {}): SkillView {
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
      version: row.version,
      ...(extras.memberIds ? { member_ids: extras.memberIds } : {}),
      ...(extras.canSeeToken ? { public_token: row.publicToken } : {}),
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
      where: and(eq(skills.workspaceId, membership.workspaceId), this.visibleTo(membership, userId)),
      orderBy: [desc(skills.createdAt)],
    });
    return { data: await this.presentAll(rows, membership, userId) };
  }

  /** present() for a batch, adding the owner/admin-only fields (member ids, public token). */
  private async presentAll(rows: SkillRow[], membership: Membership, userId: string): Promise<SkillView[]> {
    const members = await this.memberIdsFor(rows, membership, userId);
    return rows.map((r) =>
      this.present(r, userId, {
        memberIds: members.get(r.id) ?? (r.visibility === 'members' && (r.ownerId === userId || membership.role === 'admin') ? [] : undefined),
        canSeeToken: r.visibility === 'public' && (r.ownerId === userId || membership.role === 'admin'),
      }),
    );
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
      where: and(eq(skills.id, id), eq(skills.workspaceId, membership.workspaceId), this.visibleTo(membership, userId)),
    });
    if (!row) throw new NotFoundException('Skill not found');
    return row;
  }

  async get(membership: Membership, userId: string, id: string): Promise<SkillView> {
    const row = await this.findVisible(membership, userId, id);
    return (await this.presentAll([row], membership, userId))[0]!;
  }

  private publicGate: PublicPublishGate | null = null;

  registerPublicGate(gate: PublicPublishGate | null): void {
    this.publicGate = gate;
  }

  /** Called ONLY by an approved `skill_publish_public` job: a person said yes to this one skill. */
  async applyApprovedPublic(workspaceId: string, skillId: string): Promise<void> {
    const row = await this.db.query.skills.findFirst({
      where: and(eq(skills.id, skillId), eq(skills.workspaceId, workspaceId)),
    });
    if (!row) return; // deleted while the approval was pending: nothing to publish
    await this.db.transaction(async (tx) => {
      await tx
        .update(skills)
        .set({ visibility: 'public', publicToken: row.publicToken ?? this.mintPublicToken() })
        .where(eq(skills.id, skillId));
      await tx.delete(skillMembers).where(eq(skillMembers.skillId, skillId));
    });
  }

  /**
   * Who may publish a skill at which tier, for a non-human author (a token or a connected AI).
   *
   * #442 first made this "personal only", and #867 (the founder's ruling, ADR-0010 amendment of
   * 2026-10-09) changed it: an agent may publish at `shared` by DEFAULT in every workspace, unless an
   * admin switched that off. `members` and `public` are still refused here: a public link or naming
   * people is a decision a person makes. The risk of the default is accepted and recorded in the ADR;
   * the mitigation is attribution (`skills.source`, derived from the request's auth), not prevention.
   *
   * Enforced HERE rather than in the MCP tool, because a rule that lives in the client is a
   * suggestion: any PAT holder could otherwise POST `visibility: "public"` directly.
   */
  private async assertMayPublish(
    workspaceId: string,
    source: ChangeSource,
    visibility: SkillVisibility,
  ): Promise<'ok' | 'needs_approval'> {
    if (visibility === 'personal' || source === 'human') return 'ok';
    // #867 AC3 — `public` from a non-human author is NOT refused and NOT granted: it becomes a
    // proposal a person approves. Only when the approval path exists; otherwise it falls through
    // to the 403 below (the safe state).
    // Switched OFF means OFF (#867 AC4: exactly #1011's behaviour): no proposal either.
    if (visibility === 'public' && this.publicGate && (await this.agentsMayPublish(workspaceId))) return 'needs_approval';
    // #848/#867/#868 — the exceptions, all gated by the SAME switch (`agents_may_publish_skills`,
    // settable only from a human-sourced request): a non-human author may publish at `shared`, and
    // at `members` (named colleagues who are already in the workspace and could have been given
    // `shared`; narrower than a tier an AI may already set alone, so it needs no approval of its own:
    // ticket #868 AC4). Written as equalities, not "anything up to shared", so a tier added later is
    // gated by default. `public` (an unauthenticated URL) is only ever a PROPOSAL a person approves
    // (above): it leaves the workspace and reaches an unknown audience.
    if ((visibility === 'shared' || visibility === 'members') && (await this.agentsMayPublish(workspaceId))) return 'ok';
    // The refusal is an instruction a MODEL reads and acts on, so it must not send it into a second
    // guaranteed failure: it only offers an alternative that would actually work.
    const switchedOff = !(await this.agentsMayPublish(workspaceId));
    throw new ForbiddenException(
      visibility === 'public'
        ? `A skill authored over the API cannot be made public by an AI acting alone: a public link is a decision a person makes (ADR-0010).${
            switchedOff ? ' An admin has switched off AI publishing, so this skill stays `personal`.' : ' Share it with the workspace instead.'
          } A person can make it public in the Skills library.`
        : 'An admin has switched off AI publishing to the workspace, so a skill authored over the API stays ' +
            '`personal`. They can switch it back on in Settings > General; a person can also share it in the Skills library.',
    );
  }

  /** #867 — may an agent publish to this workspace? YES BY DEFAULT, in every workspace (the founder's
   * ruling, ADR-0010 amendment): the user's AI is their hands. An admin can switch it OFF, and only a
   * person can (the controller refuses the key from any non-human source). Only an EXPLICIT `false`
   * turns it off, so absence, `true` and any workspace that never touched it all mean "allowed".
   * Read fresh each call (one small query, only on the non-human path): switching it off must apply
   * to the very next request. */
  private async agentsMayPublish(workspaceId: string): Promise<boolean> {
    const ws = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    return (ws?.settings as Record<string, unknown> | null | undefined)?.['agents_may_publish_skills'] !== false;
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
    // #867: an agent's omitted visibility follows the same default a person gets (`shared`) unless
    // an admin switched agent publishing OFF for the workspace, in which case it is `personal`
    // (#848). Demanding the flag on every call would re-impose the friction the founder's ruling
    // removes. Still the single place an omitted visibility is decided; do not add a second resolver.
    const requested: SkillVisibility =
      input.visibility ??
      (source === 'human' || (await this.agentsMayPublish(membership.workspaceId)) ? 'shared' : 'personal');
    const outcome = await this.assertMayPublish(membership.workspaceId, source, requested);
    // #867 AC3: an AI that asked for `public` gets a PERSONAL skill now and a proposal a person
    // approves; it is never public, and never workspace-visible meanwhile, until that decision.
    const needsApproval = outcome === 'needs_approval';
    const visibility: SkillVisibility = needsApproval ? 'personal' : requested;
    // Naming people to share with is itself a publication (see assertMayPublish).
    if (input.member_ids?.length) await this.assertMayPublish(membership.workspaceId, source, 'members');
    if (input.member_ids !== undefined && visibility !== 'members') {
      throw new UnprocessableEntityException({
        message: '`member_ids` only applies to a skill whose visibility is `members`.',
        details: [{ path: 'member_ids', message: `visibility is \`${visibility}\`` }],
      });
    }
    const memberIds = [...new Set((input.member_ids ?? []).filter((id) => id !== userId))];
    await this.assertWorkspaceMembers(membership.workspaceId, memberIds);
    const [row] = await this.db.transaction(async (tx) => {
      const inserted = await tx
      .insert(skills)
      .values({
        workspaceId: membership.workspaceId,
        ownerId: userId,
        visibility,
        ...(input.version ? { version: input.version } : {}),
        publicToken: visibility === 'public' ? this.mintPublicToken() : null,
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
      if (memberIds.length) {
        await tx.insert(skillMembers).values(memberIds.map((id) => ({ skillId: inserted[0]!.id, userId: id })));
      }
      return inserted;
    });
    const view = (await this.presentAll([row!], membership, userId))[0]!;
    return needsApproval ? this.withProposal(view, membership.workspaceId, row!, userId, source) : view;
  }

  /** Raises the person-approved `public` proposal and returns the view with its id attached. */
  private async withProposal(
    view: SkillView,
    workspaceId: string,
    row: SkillRow,
    ownerId: string,
    source: ChangeSource,
  ): Promise<SkillView> {
    const { approvalId } = await this.publicGate!.propose({
      workspaceId,
      skillId: row.id,
      skillName: row.name,
      ownerId,
      requesterSource: source,
    });
    return { ...view, pending_approval: { id: approvalId } };
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
    const existing = await this.requireOwner(membership, userId, id);
    // Promoting an existing skill to `shared` is the same decision as creating
    // one shared, so it meets the same gate — otherwise the create-side rule is
    // one PATCH away from being decorative.
    const outcome =
      input.visibility !== undefined
        ? await this.assertMayPublish(membership.workspaceId, source, input.visibility)
        : 'ok';
    if (input.member_ids !== undefined) await this.assertMayPublish(membership.workspaceId, source, 'members');
    // #867 AC3: a non-human `public` request changes NOTHING about visibility now; it raises the
    // proposal (unless the skill is already public) and the rest of the edit still applies.
    const proposePublic = outcome === 'needs_approval' && existing.visibility !== 'public';
    const effectiveVisibility = outcome === 'needs_approval' ? undefined : input.visibility;
    const nextVisibility = effectiveVisibility ?? existing.visibility;
    if (input.member_ids !== undefined && nextVisibility !== 'members') {
      throw new UnprocessableEntityException({
        message: '`member_ids` only applies to a skill whose visibility is `members`.',
        details: [{ path: 'member_ids', message: `visibility is \`${nextVisibility}\`` }],
      });
    }
    const memberIds = input.member_ids ? [...new Set(input.member_ids.filter((m) => m !== userId))] : undefined;
    if (memberIds) await this.assertWorkspaceMembers(membership.workspaceId, memberIds);
    const patch: Partial<typeof skills.$inferInsert> = {};
    if (input.version !== undefined) patch.version = input.version;
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.when_to_use !== undefined) patch.whenToUse = input.when_to_use;
    if (input.instructions !== undefined) patch.instructions = input.instructions;
    if (input.examples !== undefined) patch.examples = input.examples;
    if (effectiveVisibility !== undefined) patch.visibility = effectiveVisibility;
    // The public link is a credential: minted when a skill BECOMES public, and cleared the
    // instant it stops being public, so revoking is effective immediately (a link that
    // outlived `public` and silently worked again on a re-share would be a standing leak).
    if (nextVisibility === 'public' && !existing.publicToken) patch.publicToken = this.mintPublicToken();
    if (nextVisibility !== 'public') patch.publicToken = null;

    const [row] = await this.db.transaction(async (tx) => {
      const updated = await tx.update(skills).set(patch).where(eq(skills.id, id)).returning();
      // Leaving `members` drops the named list, so switching back later cannot silently
      // revive people someone no longer remembers sharing with.
      if (nextVisibility !== 'members') await tx.delete(skillMembers).where(eq(skillMembers.skillId, id));
      else if (memberIds) {
        await tx.delete(skillMembers).where(eq(skillMembers.skillId, id));
        if (memberIds.length) await tx.insert(skillMembers).values(memberIds.map((m) => ({ skillId: id, userId: m })));
      }
      return updated;
    });
    const view = (await this.presentAll([row!], membership, userId))[0]!;
    return proposePublic ? this.withProposal(view, membership.workspaceId, row!, userId, source) : view;
  }

  /**
   * #841 — the unauthenticated read behind a `public` skill's link, mirroring a form's
   * `public_token`. The token is the only credential. A skill that is not `public` (or has no
   * token) is a plain 404, the same answer as an unknown token, so the response never says
   * which. Returns the portable fields only: no owner, workspace or source ids.
   */
  async getPublic(token: string) {
    const row = await this.db.query.skills.findFirst({
      where: and(eq(skills.publicToken, token), eq(skills.visibility, 'public')),
    });
    if (!row) throw new NotFoundException('Skill not found');
    return {
      name: row.name,
      description: row.description,
      when_to_use: row.whenToUse,
      instructions: row.instructions,
      examples: (row.examples ?? []) as SkillSummary['examples'],
      version: row.version,
      updated_at: row.updatedAt.toISOString(),
    };
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
          'principal + instructions, not a model call. Drive these instructions with your ' +
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
