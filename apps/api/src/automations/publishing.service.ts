import { ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  DisablePublishingInput,
  EnablePublishingInput,
  PublishTarget,
  PublishingChannel,
  PublishingDisableResult,
  PublishingEnableResult,
  PublishingRule,
  PublishingSetup,
  PublishingUnmet,
} from '@storyos/schemas';
import { codedException } from '../common/coded-exception';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { env } from '../config/env';
import { activityEvents, automations, connections, fields, packInstallItems, packInstalls, selectOptions } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import { recordPublishingEvent } from '../activity/structural-events';
import { DatabasesService } from '../databases/databases.service';
import { DeploymentService } from '../deployment/deployment.service';
import { availabilityFor } from '../connections/providers/availability';
import { PROVIDER_REGISTRY } from '../connections/providers';
import { SocialAccountsService } from '../connections/social-accounts.service';
import type { SocialAccount } from '../connections/social-accounts.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { AutomationsService } from './automations.service';

/** The pack this flow belongs to. The slug is the pack's identity; its Posts database is found through the install, never by name alone. */
const PACK_SLUG = 'social-command-center';
const POSTS_DATABASE = 'Posts';

const TARGET_PROVIDER: Record<PublishTarget, 'linkedin' | 'x'> = { linkedin_org: 'linkedin', linkedin_member: 'linkedin', x: 'x' };
const TARGET_LABEL: Record<PublishTarget, string> = { linkedin_org: 'LinkedIn page', linkedin_member: 'LinkedIn profile', x: 'X' };

/** The pack's fields, found by their stable api name AND type, so a renamed label still resolves and a field retyped into something else does not. */
const REQUIRED_FIELDS = {
  status: { apiName: 'status', types: ['workflow', 'select'], label: 'Status' },
  text: { apiName: 'text', types: ['rich_text', 'text'], label: 'Text' },
  media: { apiName: 'media', types: ['attachment'], label: 'Media' },
  post_url: { apiName: 'post_url', types: ['url'], label: 'Post URL' },
} as const;

interface ResolvedFields {
  statusFieldId: string;
  scheduledOptionId: string;
  textFieldId: string;
  textDisplayName: string;
  mediaFieldId: string;
  postUrlFieldId: string;
}

interface StoredPostAction {
  type: string;
  connection_id?: string;
  target?: PublishTarget;
  account_id?: string;
  require_approval?: boolean;
}

/**
 * Ticket #456 - the API behind the guided "Turn on publishing" card on the Social Command Center's Posts database.
 *
 * What it adds over the generic automation calls the card could have used, and why it exists: the pack cannot pre-wire a publish rule (a
 * `post_social` action names a connection a manifest cannot know), so the step from "pack installed" to "my Scheduled column publishes" was
 * building the rule by hand. That step needs three things the generic endpoints do not give a client: the pack's field and option ids
 * (otherwise every client matches fields by their label, and a rename silently breaks it), whether LinkedIn posting is switched on for this
 * deployment (nowhere exposed), and ONE place that refuses with every unmet prerequisite at once instead of the first 422 of several.
 *
 * It creates a rule through AutomationsService.create/update, the same path the automation editor uses, so every rule the engine already
 * enforces still applies (a named connection, the matching provider, the LinkedIn gate, a named page, approval-off being an admin's call).
 * It adds, on top: the named account is checked against the accounts the connection can really post as (never a made-up URN), the call is
 * idempotent, one publish rule per network, and enabling/pausing is audited with the actor.
 *
 * NOTHING HERE POSTS. Enabling saves a rule; the rule can only fire on a later Status change, and by default only after a person approves.
 */
@Injectable()
export class PublishingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly databases: DatabasesService,
    private readonly rules: AutomationsService,
    private readonly social: SocialAccountsService,
    private readonly deployment: DeploymentService,
  ) {}

  // ── read ───────────────────────────────────────────────────────────

  async setup(membership: Membership, databaseId: string, isHumanSession: boolean): Promise<PublishingSetup> {
    await this.databases.assertAccess(membership, databaseId, 'viewer');
    const canManage = await this.databases
      .assertAccess(membership, databaseId, 'creator')
      .then(() => true)
      .catch(() => false);
    const applicable = (await this.findInstall(membership.workspaceId, databaseId)) !== null;
    const canSkipApproval = canManage && membership.role === 'admin' && isHumanSession;
    const empty: PublishingSetup = {
      applicable,
      state: 'not_set_up',
      can_manage: canManage,
      can_skip_approval: canSkipApproval,
      rules: [],
      channels: [],
      unmet: applicable ? [] : [{ code: 'not_applicable', message: 'This database is not the Posts database of the Social Command Center.' }],
      fields: null,
      draft: null,
    };
    // Someone who cannot turn publishing on is told only that, never which connections or accounts exist.
    if (!applicable || !canManage) return empty;

    const rules = await this.presentRules(membership.workspaceId, databaseId);
    const resolved = await this.resolveFields(databaseId);
    return {
      ...empty,
      state: rules.some((r) => r.enabled) ? 'on' : rules.length ? 'paused' : 'not_set_up',
      rules,
      channels: await this.channels(membership.workspaceId),
      unmet: resolved.unmet,
      fields: resolved.fields
        ? {
            status_field_id: resolved.fields.statusFieldId,
            scheduled_option_id: resolved.fields.scheduledOptionId,
            text_field_id: resolved.fields.textFieldId,
            media_field_id: resolved.fields.mediaFieldId,
            post_url_field_id: resolved.fields.postUrlFieldId,
          }
        : null,
      draft: resolved.fields
        ? {
            name: 'Post scheduled posts',
            trigger: { type: 'record_updated', field_id: resolved.fields.statusFieldId },
            condition: { field: REQUIRED_FIELDS.status.apiName, op: 'eq', value: resolved.fields.scheduledOptionId },
            action: {
              type: 'post_social',
              text: `{${resolved.fields.textDisplayName}}`,
              media_field_id: resolved.fields.mediaFieldId,
              result_field_id: resolved.fields.postUrlFieldId,
              require_approval: true,
            },
          }
        : null,
    };
  }

  // ── enable ─────────────────────────────────────────────────────────

  async enable(membership: Membership, userId: string, databaseId: string, input: EnablePublishingInput, source: ChangeSource): Promise<PublishingEnableResult> {
    await this.databases.assertAccess(membership, databaseId, 'creator');
    const workspaceId = membership.workspaceId;
    if (!(await this.findInstall(workspaceId, databaseId))) {
      this.refuse([{ code: 'not_applicable', message: 'This database is not the Posts database of the Social Command Center.' }]);
    }

    const unmet: PublishingUnmet[] = [];
    const resolved = await this.resolveFields(databaseId);
    unmet.push(...resolved.unmet);
    const requireApproval = input.require_approval ?? true;
    if (!requireApproval && membership.role !== 'admin') {
      unmet.push({ code: 'approval_off_needs_admin', message: 'Only a workspace admin can switch approval off.', target: input.target });
    }

    // The connection, in THIS workspace: another workspace's id is "missing", never a hint that it exists.
    const conn = await this.db.query.connections.findFirst({
      where: and(eq(connections.id, input.connection_id), eq(connections.workspaceId, workspaceId)),
      columns: { id: true, provider: true, createdBy: true },
    });
    let account: SocialAccount | null = null;
    if (!conn) {
      unmet.push({ code: 'connection_missing', message: 'That connection does not exist in this workspace.', target: input.target });
    } else if (conn.provider !== TARGET_PROVIDER[input.target]) {
      unmet.push({
        code: 'connection_wrong_provider',
        message: `A ${TARGET_LABEL[input.target]} needs a ${TARGET_PROVIDER[input.target] === 'x' ? 'X' : 'LinkedIn'} connection.`,
        target: input.target,
      });
    } else if (conn.provider === 'linkedin' && !env().LINKEDIN_ACTIONS_ENABLED) {
      unmet.push({
        code: 'provider_not_switched_on',
        message: "LinkedIn posting isn't switched on for this workspace yet: it waits on LinkedIn's review of our app.",
        target: input.target,
      });
    } else if (input.target === 'linkedin_org' && !input.account_id) {
      unmet.push({ code: 'account_required', message: 'Choose which LinkedIn page this posts as.', target: input.target });
    } else {
      account = await this.nameAccount(membership, userId, conn.id, input, unmet);
    }
    if (unmet.length || !resolved.fields || !conn || !account) this.refuse(unmet);

    const fieldsOk = resolved.fields!;
    const accountId = this.storedAccountId(input.target, account!);
    const existing = (await this.postRules(databaseId)).filter((r) => r.action.target === input.target);
    const same = existing.find(
      (r) => r.action.connection_id === conn!.id && (r.action.account_id ?? null) === accountId && (r.action.require_approval ?? true) === requireApproval,
    );
    const other = existing.find((r) => r !== same);
    if (!same && other) {
      this.refuse(
        [{ code: 'already_configured', message: `A ${TARGET_LABEL[input.target]} publish rule already exists with a different connection, account or approval setting. Pause it first, or edit it in the automation editor.`, target: input.target }],
      );
    }

    if (same) {
      if (same.row.enabled) return { changed: false, rule: (await this.presentRules(workspaceId, databaseId)).find((r) => r.id === same.row.id)! };
      await this.rules.update(workspaceId, databaseId, same.row.id, { enabled: true }, userId, membership.role, source);
      await this.audit(workspaceId, databaseId, 'enabled', same.row.id, same.row.name, same.action);
      return { changed: true, rule: (await this.presentRules(workspaceId, databaseId)).find((r) => r.id === same.row.id)! };
    }

    const name = `Post scheduled posts to ${TARGET_LABEL[input.target]}: ${account!.name}`.slice(0, 100);
    const action = {
      type: 'post_social' as const,
      connection_id: conn!.id,
      target: input.target,
      ...(accountId ? { account_id: accountId } : {}),
      text: `{${fieldsOk.textDisplayName}}`,
      media_field_id: fieldsOk.mediaFieldId,
      result_field_id: fieldsOk.postUrlFieldId,
      require_approval: requireApproval,
    };
    const created = (await this.rules.create(
      workspaceId,
      databaseId,
      {
        name,
        trigger: { type: 'record_updated', field_id: fieldsOk.statusFieldId },
        condition: { field: REQUIRED_FIELDS.status.apiName, op: 'eq', value: fieldsOk.scheduledOptionId },
        actions: [action],
        enabled: true,
      },
      userId,
      membership.role,
      source,
    )) as { id: string };
    try {
      await this.audit(workspaceId, databaseId, 'enabled', created.id, name, action);
    } catch (e) {
      // An unaudited publish rule is worse than none: take it back rather than leave it live without a record of who allowed it.
      await this.rules.remove(databaseId, created.id);
      throw e;
    }
    return { changed: true, rule: (await this.presentRules(workspaceId, databaseId)).find((r) => r.id === created.id)! };
  }

  // ── disable ────────────────────────────────────────────────────────

  async disable(membership: Membership, userId: string, databaseId: string, input: DisablePublishingInput, source: ChangeSource): Promise<PublishingDisableResult> {
    await this.databases.assertAccess(membership, databaseId, 'creator');
    const workspaceId = membership.workspaceId;
    if (!(await this.findInstall(workspaceId, databaseId))) {
      this.refuse([{ code: 'not_applicable', message: 'This database is not the Posts database of the Social Command Center.' }]);
    }
    const live = (await this.postRules(databaseId)).filter((r) => r.row.enabled && (!input.target || r.action.target === input.target));
    const changedIds: string[] = [];
    for (const r of live) {
      await this.rules.update(workspaceId, databaseId, r.row.id, { enabled: false }, userId, membership.role, source);
      await this.audit(workspaceId, databaseId, 'disabled', r.row.id, r.row.name, r.action);
      changedIds.push(r.row.id);
    }
    const rules = await this.presentRules(workspaceId, databaseId);
    return { changed: rules.filter((r) => changedIds.includes(r.id)), rules };
  }

  // ── helpers ────────────────────────────────────────────────────────

  /** 422 `publishing_prerequisites_unmet`, with every unmet prerequisite in `error.meta.unmet` (the envelope's structured-facts slot). */
  private refuse(unmet: PublishingUnmet[]): never {
    throw codedException(422, 'publishing_prerequisites_unmet', unmet.map((u) => u.message).join(' '), { unmet });
  }

  /** The tracked Social Command Center install whose Posts database this is, or null. A database merely NAMED Posts is not it. */
  private async findInstall(workspaceId: string, databaseId: string) {
    const rows = await this.db
      .select({ id: packInstalls.id })
      .from(packInstalls)
      .innerJoin(packInstallItems, eq(packInstallItems.packInstallId, packInstalls.id))
      .where(
        and(
          eq(packInstalls.workspaceId, workspaceId),
          eq(packInstalls.slug, PACK_SLUG),
          isNull(packInstalls.uninstalledAt),
          eq(packInstallItems.kind, 'database'),
          eq(packInstallItems.entityId, databaseId),
          eq(packInstallItems.name, POSTS_DATABASE),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async resolveFields(databaseId: string): Promise<{ fields: ResolvedFields | null; unmet: PublishingUnmet[] }> {
    const live = await this.db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)) });
    const unmet: PublishingUnmet[] = [];
    const found: Record<string, (typeof live)[number]> = {};
    for (const [key, want] of Object.entries(REQUIRED_FIELDS)) {
      const f = live.find((x) => x.apiName === want.apiName && (want.types as readonly string[]).includes(x.type));
      if (f) found[key] = f;
      else unmet.push({ code: 'field_missing', message: `The ${want.label} field is missing from Posts or is no longer the right kind of field.`, field: key });
    }
    let scheduled: { id: string } | undefined;
    if (found.status) {
      const opts = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, found.status.id) });
      scheduled = opts.find((o) => o.label.trim().toLowerCase() === 'scheduled');
      if (!scheduled) unmet.push({ code: 'scheduled_option_missing', message: 'Status has no "Scheduled" option, so there is nothing to publish on.', field: 'status' });
    }
    if (unmet.length) return { fields: null, unmet };
    return {
      unmet,
      fields: {
        statusFieldId: found.status!.id,
        scheduledOptionId: scheduled!.id,
        textFieldId: found.text!.id,
        textDisplayName: found.text!.displayName,
        mediaFieldId: found.media!.id,
        postUrlFieldId: found.post_url!.id,
      },
    };
  }

  /** The named account for a connection and target, verified against what the network says the connection can post as. Fails closed. */
  private async nameAccount(
    membership: Membership,
    userId: string,
    connectionId: string,
    input: EnablePublishingInput,
    unmet: PublishingUnmet[],
  ): Promise<SocialAccount | null> {
    let list: SocialAccount[];
    try {
      list = (await this.social.list(membership, userId, connectionId)).data;
    } catch (e) {
      // 403 (not the connector or an admin) must stay a 403; every other failure to ask is "could not list", never a guess.
      if (e instanceof ForbiddenException) throw e;
      const message = e instanceof HttpException && e.getStatus() === 422 ? this.safeMessage(e) : 'The network could not be asked which accounts this connection can post as. Try again, or reconnect the account.';
      unmet.push({ code: 'accounts_unavailable', message, target: input.target });
      return null;
    }
    let want: SocialAccount | undefined;
    if (input.target === 'x') want = list.find((a) => a.type === 'x_account');
    else if (input.target === 'linkedin_org') want = list.find((a) => a.type === 'organization' && a.id === input.account_id);
    else want = list.find((a) => a.type === 'member' && (!input.account_id || a.id === input.account_id));
    if (input.target === 'x' && input.account_id) want = undefined;
    if (!want) {
      unmet.push({
        code: 'account_not_found',
        message:
          input.target === 'x'
            ? input.account_id
              ? 'An X connection posts as its own account; there is no other account to choose.'
              : 'The X connection did not name an account to post as.'
            : 'That account is not one this connection can post as.',
        target: input.target,
      });
      return null;
    }
    return want;
  }

  private safeMessage(e: HttpException): string {
    const r = e.getResponse();
    const m = typeof r === 'string' ? r : (r as { message?: unknown }).message;
    return typeof m === 'string' ? m : 'The connection needs to be reconnected.';
  }

  /** What goes in the rule's `account_id`: the page or member URN; never for X, whose account is the connection's own. */
  private storedAccountId(target: PublishTarget, account: SocialAccount): string | null {
    return target === 'x' ? null : account.id;
  }

  private async postRules(databaseId: string) {
    const rows = await this.db.query.automations.findMany({ where: eq(automations.databaseId, databaseId), orderBy: [desc(automations.createdAt)] });
    const out: { row: (typeof rows)[number]; action: StoredPostAction }[] = [];
    for (const row of rows) {
      const actions = (Array.isArray(row.actions) ? row.actions : []) as StoredPostAction[];
      const post = actions.find((a) => a?.type === 'post_social' && a.target && a.connection_id);
      if (post) out.push({ row, action: post });
    }
    return out;
  }

  private async presentRules(workspaceId: string, databaseId: string): Promise<PublishingRule[]> {
    const rules = await this.postRules(databaseId);
    if (!rules.length) return [];
    const events = await this.db
      .select({ type: activityEvents.type, actorId: activityEvents.actorId, createdAt: activityEvents.createdAt, ruleId: sql<string>`${activityEvents.payload}->'object'->>'id'` })
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, workspaceId),
          eq(activityEvents.type, 'publishing.enabled'),
          inArray(
            sql`${activityEvents.payload}->'object'->>'id'`,
            rules.map((r) => r.row.id),
          ),
        ),
      )
      .orderBy(desc(activityEvents.createdAt));
    return rules.map(({ row, action }) => {
      const last = events.find((e) => e.ruleId === row.id);
      return {
        id: row.id,
        enabled: row.enabled,
        name: row.name,
        target: action.target!,
        connection_id: action.connection_id!,
        account_id: action.account_id ?? null,
        require_approval: action.require_approval ?? true,
        created_by: row.createdBy ?? null,
        created_at: row.createdAt.toISOString(),
        enabled_by: last?.actorId ?? null,
        enabled_at: last ? last.createdAt.toISOString() : null,
      };
    });
  }

  private async channels(workspaceId: string): Promise<PublishingChannel[]> {
    const rows = await this.db.query.connections.findMany({
      where: and(eq(connections.workspaceId, workspaceId), inArray(connections.provider, ['linkedin', 'x'])),
      columns: { id: true, provider: true, name: true, status: true, createdBy: true },
      orderBy: [desc(connections.createdAt)],
    });
    const isHosted = this.deployment.isHosted;
    return (['linkedin', 'x'] as const).map((provider) => {
      const descriptor = PROVIDER_REGISTRY.get(provider);
      return {
        provider,
        availability: descriptor ? availabilityFor(descriptor, { isHosted }) : 'cloud_only',
        posting_enabled: provider === 'x' ? true : env().LINKEDIN_ACTIONS_ENABLED,
        targets: provider === 'x' ? (['x'] as PublishTarget[]) : (['linkedin_org', 'linkedin_member'] as PublishTarget[]),
        connections: rows.filter((c) => c.provider === provider).map((c) => ({ id: c.id, name: c.name, status: c.status, created_by: c.createdBy ?? null })),
      };
    });
  }

  private async audit(workspaceId: string, databaseId: string, action: 'enabled' | 'disabled', ruleId: string, ruleName: string, a: StoredPostAction) {
    await recordPublishingEvent(this.db, {
      workspaceId,
      action,
      ruleId,
      ruleName,
      databaseId,
      target: a.target!,
      connectionId: a.connection_id!,
      accountId: a.account_id ?? null,
      requireApproval: a.require_approval ?? true,
    });
  }
}
