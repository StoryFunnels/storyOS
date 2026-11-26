import { ForbiddenException, HttpException, Inject, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { codedException } from '../common/coded-exception';
import { DatabasesService } from '../databases/databases.service';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, user } from '../db/schema';
import type { EffectiveRole } from '../access/access.service';
import type { ProjectedRecord } from '../records/records.service';
import { RecordsService } from '../records/records.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { JobRunnerService } from './job-runner.service';

/** The two codes a refusal carries. Stable: a client may branch on them, and the run row's text starts with one. */
export const OWNER_MISSING_CODE = 'automation_owner_missing';
export const OWNER_NO_ACCESS_CODE = 'automation_owner_no_access';

/**
 * Ticket #1353 — the actions that leave through the job queue's door later (a retried email, an approved post). Their access is
 * re-read AGAIN when the job is claimed, because a job can wait through backoff for hours after the run that queued it.
 */
const QUEUED_KINDS: ReadonlySet<string> = new Set(['send_email', 'http_request', 'post_social', 'run_agent', 'send_webhook', 'send_slack_message']);

/** Actions that send something out of the workspace (or start an agent): the rule's owner must still be able to BUILD such a rule. */
const OUTWARD: ReadonlySet<string> = QUEUED_KINDS;

/** What the guard needs to know about the run. `ruleId` set = a rule's run (the actor is the rule's OWNER); absent = a person pressed a button, or an agent applied a staged action. */
export interface ActionGuardContext {
  workspaceId: string;
  databaseId: string;
  record: ProjectedRecord | null;
  actorId: string;
  ruleId?: string | null;
}

/** For update_linked only: the records the action is about to write, as the executor resolves them. */
export type LinkedResolver = () => Promise<{ targetDbId: string; linkedIds: string[] } | null>;

/**
 * Ticket #1353 — ONE run-time access guard for every automation action, used by the executor BEFORE each action runs. It is
 * the attach_pdf model (ticket #877) generalised: the actor is re-read from `memberships` NOW, and the specific rung each kind of
 * action needs is asked through the SAME checks the HTTP routes use (`RecordsService.assertRecordAccess`,
 * `DatabasesService.assertAccess`). Before this, every action but attach_pdf checked its actor when the rule was SAVED and never
 * again, so a rule kept writing with its creator's access after that person was demoted, lost the database, or left.
 *
 * WHOSE ACCESS. The rule's owner (`automations.created_by`) for a rule run; the presser for a button; the agent's owner for an
 * agent-applied staged action. A button's presser is held to what the press route already asks of them (editor on the database),
 * NOT to the rule-builder rung: pressing a button never needed it.
 *
 * WHAT A REFUSAL SAYS. The run row is read by people who may not be able to read the thing refused, so a refusal names the person
 * and the KIND of resource ("this record", "the database this action writes into"), never a title, a name or a value.
 *
 * REFUSAL IS TERMINAL. It throws, so the run fails and the actions after it do not run; the rule's failure streak counts it, and the
 * rule switches itself off after MAX_FAILURES, so a rule that can never succeed stops being fired rather than retried forever. A
 * queued job refused at claim time is finalized without a retry (job-runner's non-retryable path).
 *
 * Callers must pass a real USER ID as the actor: the lookup is by membership, so an email address or a made-up string is refused as "not a member".
 *
 * attach_pdf is NOT checked here: it carries its own, stricter check (it also needs the source readable), and was the model.
 */
@Injectable()
export class ActionAccessGuardService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly databases: DatabasesService,
    private readonly jobs: JobRunnerService,
  ) {}

  onModuleInit(): void {
    this.jobs.setPreflight(async (job) => {
      if (!QUEUED_KINDS.has(job.kind)) return;
      const payload = job.payload as { action?: AutomationAction; ctx?: { workspaceId?: string; databaseId?: string | null; actorId?: string } } | null;
      const ctx = payload?.ctx;
      if (!payload?.action || !ctx?.workspaceId || !ctx.databaseId || typeof ctx.actorId !== 'string') return;
      try {
        await this.check(payload.action, { workspaceId: ctx.workspaceId, databaseId: ctx.databaseId, record: null, actorId: ctx.actorId, ruleId: job.ruleId });
      } catch (error) {
        // The same "<code>: <sentence>" the run row shows, so the job's last error reads like the run's.
        if (error instanceof HttpException) {
          const body = error.getResponse() as { code?: string };
          throw new Error(`${body.code ?? 'automation_owner_no_access'}: ${error.message}`, { cause: error });
        }
        throw error;
      }
    });
  }

  /** Throws a coded 403 (never returns a verdict): the caller lets it propagate so the run records it and stops. */
  async check(action: AutomationAction, ctx: ActionGuardContext, resolveLinked?: LinkedResolver): Promise<void> {
    if (action.type === 'attach_pdf') return;
    const isRule = Boolean(ctx.ruleId);
    const membership = await this.activeMembership(ctx, isRule, action.type);
    const name = await this.personName(ctx.actorId, isRule);
    const refuse = (message: string) => codedException(403, OWNER_NO_ACCESS_CODE, message, { action_type: action.type });

    if (OUTWARD.has(action.type)) {
      // A rule's owner must still be able to build automations on this database (the rung that saved it); a presser, what the press asked.
      const rung: EffectiveRole = isRule ? 'creator' : 'editor';
      await this.databaseRung(membership, ctx.databaseId, rung, () =>
        refuse(
          isRule
            ? `${name} can no longer manage automations on this database, so ${action.type} did not run. An admin needs to take this rule over.`
            : `${name} can no longer edit records on this database, so ${action.type} did not run.`,
        ),
      );
      return;
    }

    switch (action.type) {
      case 'set_values':
        await this.recordRung(membership, ctx, 'contributor', () => refuse(`${name} can no longer edit this record, so set_values did not run.`));
        return;
      case 'add_comment':
        await this.recordRung(membership, ctx, 'commenter', () => refuse(`${name} can no longer comment on this record, so add_comment did not run.`));
        return;
      case 'notify_user':
        // The message is built from the record, so the actor must still be able to read it.
        if (ctx.record) await this.recordRung(membership, ctx, 'viewer', () => refuse(`${name} can no longer read this record, so notify_user did not run.`));
        return;
      case 'create_record':
      case 'create_records':
        await this.databaseRung(membership, action.database_id, 'contributor', () =>
          refuse(`${name} can no longer add records to the database this action writes into, so ${action.type} did not run.`),
        );
        return;
      case 'update_linked': {
        const linked = resolveLinked ? await resolveLinked() : null;
        if (!linked) return;
        for (const id of linked.linkedIds) {
          await this.linkedRecordRung(membership, linked.targetDbId, id, () => refuse(`${name} can no longer edit the linked records, so update_linked did not run.`));
        }
        return;
      }
      default:
        return;
    }
  }

  /** The actor as an ACTIVE member, read now. A removed member's row is gone; a rule with no owner has no id to look up at all. */
  private async activeMembership(ctx: ActionGuardContext, isRule: boolean, actionType: string): Promise<Membership> {
    const row = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, ctx.workspaceId), eq(memberships.userId, ctx.actorId), eq(memberships.status, 'active')),
    });
    if (row) return row;
    const known = await this.db.query.user.findFirst({ where: eq(user.id, ctx.actorId), columns: { name: true } });
    const who = known?.name?.trim();
    throw codedException(
      403,
      OWNER_MISSING_CODE,
      isRule
        ? who
          ? `${who} is no longer a member of this workspace, so ${actionType} did not run. An admin needs to take this rule over.`
          : `This rule has no owner who is a member of this workspace, so ${actionType} did not run. An admin needs to take it over.`
        : `${who ?? 'The person who ran this'} is no longer a member of this workspace, so ${actionType} did not run.`,
      { action_type: actionType },
    );
  }

  private async personName(userId: string, isRule: boolean): Promise<string> {
    const row = await this.db.query.user.findFirst({ where: eq(user.id, userId), columns: { name: true } });
    return row?.name?.trim() || (isRule ? 'The rule owner' : 'The person who ran this');
  }

  private async databaseRung(membership: Membership, databaseId: string, min: EffectiveRole, refusal: () => Error): Promise<void> {
    try {
      await this.databases.assertAccess(membership, databaseId, min);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) throw refusal();
      throw error;
    }
  }

  private async recordRung(membership: Membership, ctx: ActionGuardContext, min: EffectiveRole, refusal: () => Error): Promise<void> {
    try {
      if (ctx.record) await this.recordsService.assertRecordAccess(membership, ctx.databaseId, ctx.record.id, min);
      else await this.databases.assertAccess(membership, ctx.databaseId, min);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) throw refusal();
      throw error;
    }
  }

  private async linkedRecordRung(membership: Membership, databaseId: string, recordId: string, refusal: () => Error): Promise<void> {
    try {
      await this.recordsService.assertRecordAccess(membership, databaseId, recordId, 'contributor');
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ForbiddenException) throw refusal();
      throw error;
    }
  }
}
