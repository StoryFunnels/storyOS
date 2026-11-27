import { ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, memberships, records, selectOptions, slackSubscriptions, spaces, user } from '../db/schema';
import { env } from '../config/env';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import type { EventOrigin } from '../common/credential-context';
import { currentEventOrigin } from '../common/credential-context';
import { logAgentOriginOutward } from '../activity/agent-origin-log';
import { SlackService } from './slack.service';
import { renderCoalescedMessage, renderSubscriptionMessage } from './slack-subscription-message';
import type { SubscriptionEventKind, ViaKind } from './slack-subscription-message';

/** Stable machine-readable code (error.code) of the 422 for a restricted target created without `acknowledge_restricted`. */
export const RESTRICTED_ACK_CODE = 'restricted_acknowledgement_required';

export const SUBSCRIPTION_EVENTS: readonly SubscriptionEventKind[] = ['created', 'status_changed', 'commented'];

type Row = typeof slackSubscriptions.$inferSelect;

/**
 * #1377 - a public channel's NAME (lowercase letters, digits, hyphen, underscore) or its ID (`C...`). A leading `#` is dropped.
 * Refused on purpose: a legacy private-channel id (`G...`), a direct-message id (`D...`) and a user id (`U...`/`W...`). What this does
 * NOT do: tell public from private. Slack gives a private channel a `C` id too, so a private channel the bot was invited to passes. The
 * only promise is "a channel the bot can post to" (Slack enforces that, not us); we never list private channels and never ask for the scope.
 */
export function slackChannelProblem(raw: string): { channel: string } | { problem: string } {
  const channel = raw.trim().replace(/^#/, '');
  if (/^[GDUW][A-Z0-9]{6,}$/.test(channel)) return { problem: 'A subscription posts to a channel the bot can post to. Direct messages, people and legacy private-channel ids are not supported.' };
  if (/^C[A-Z0-9]{6,}$/.test(channel) || /^[a-z0-9][a-z0-9_-]{0,79}$/.test(channel)) return { channel };
  return { problem: 'Not a Slack channel: use a channel name such as "engineering" or a channel id such as "C0123ABCDEF".' };
}

/** How many messages one channel may have waiting before the rest are folded into one line. */
const COALESCE_AFTER = 8;
/** Slack allows about one message per second per channel. */
const SEND_INTERVAL_MS = 1100;
/** Waits before the 2nd, 3rd and 4th attempt at one message. */
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];
const DEDUPE_TTL_MS = 10 * 60_000;

interface Outgoing {
  workspaceId: string;
  channel: string | null;
  text: string;
  subscriptionIds: string[];
  origin: EventOrigin | null;
  recordId: string;
  recordTitle: string;
}

interface Target {
  workspaceId: string;
  databaseId: string;
  databaseName: string;
  databaseRestricted: boolean;
  /** A system database (Members, Agents, Agent Triggers, Runs) belongs to a service and is never posted to Slack. */
  databaseIsSystem: boolean;
  identifierPrefix: string | null;
  spaceId: string;
  spaceRestricted: boolean;
}

/**
 * Ticket #1377 - Slack channel subscriptions: "post into this channel when a record of this space or database is created, has its
 * status changed or is commented on", as ONE setting instead of an automation per event.
 *
 * It is a small emitter beside the other consumers of the domain-event bus, not a copy of the automations engine, and it sends through
 * the existing `SlackService` (bot token or incoming webhook, the SSRF-guarded transport, `escapeSlackText`): no Slack app and no OAuth.
 *
 * EVERY rule about who may be told is applied when the event is EMITTED, never when something is read (ADR-0018 section 5):
 *   - management (list, create, change, delete) is admin-only, like the Slack connection it posts through;
 *   - the admin who made a subscription is re-checked on every event (still an active admin of the workspace?), and one whose
 *     creator is not is SKIPPED and FLAGGED (`needs_attention`), neither kept alive nor dropped silently;
 *   - a database inside a personal space, a deleted database or space, and a trashed record post nothing;
 *   - a space subscription does not cover a database that is itself restricted: that one needs a subscription of its own, named;
 *   - creating a subscription on a closed (restricted) space or database needs `acknowledge_restricted`, because its titles go to a
 *     Slack channel whose membership StoryOS does not control (ADR-0018 section 9);
 *   - a message carries the title (the version a narrowed reader sees), identifier, state, actor and link, never a field value.
 *
 * Delivery is in-process and best effort, like the bus it listens to: a failed post is retried with backoff and counted on the
 * subscription, and never blocks or fails the record write. KNOWN LIMIT: the queue lives in memory, so a restart drops what was
 * waiting (the counters and `last_error` only know about attempts that were made).
 */
@Injectable()
export class SlackSubscriptionsService implements OnModuleInit {
  private readonly logger = new Logger(SlackSubscriptionsService.name);

  /** Tunables, instance properties so a test can run in milliseconds. */
  sendIntervalMs = SEND_INTERVAL_MS;
  retryDelaysMs: number[] = RETRY_DELAYS_MS;
  coalesceAfter = COALESCE_AFTER;
  /** Test seam: delivery waits for this before sending, so a test can pile up a burst deterministically. Always resolved in production. */
  deliveryGate: Promise<void> = Promise.resolve();

  private readonly queues = new Map<string, { items: Outgoing[]; lastSentAt: number; running: boolean }>();
  private readonly draining = new Set<Promise<void>>();
  /** Event handlers still running, so `settle()` can wait for the ones a test just caused. */
  private readonly handling = new Set<Promise<unknown>>();
  private readonly seen = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    readonly slack: SlackService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => {
      void this.track(this.onRecordEvent(event)).catch((error) => this.logger.warn(`slack subscription dispatch failed: ${String(error)}`));
    });
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.handling.add(work);
    const done = () => this.handling.delete(work);
    work.then(done, done);
    return work;
  }

  /** Test hook: resolves when every event handler has finished and everything queued has been sent, retried to the end, or counted as failed. */
  async settle(): Promise<void> {
    while (this.handling.size > 0 || this.draining.size > 0) await Promise.allSettled([...this.handling, ...this.draining]);
  }

  // ---------------------------------------------------------------- management (admin-only; the controller says so)

  async list(workspaceId: string) {
    const rows = await this.db
      .select({
        sub: slackSubscriptions,
        databaseName: databases.name,
        databaseRestricted: databases.restricted,
        databaseSpaceId: databases.spaceId,
        spaceName: spaces.name,
        spaceRestricted: spaces.restricted,
        creatorName: user.name,
      })
      .from(slackSubscriptions)
      .leftJoin(databases, eq(databases.id, slackSubscriptions.databaseId))
      .leftJoin(spaces, eq(spaces.id, sql`coalesce(${slackSubscriptions.spaceId}, ${databases.spaceId})`))
      .leftJoin(user, eq(user.id, slackSubscriptions.createdBy))
      .where(eq(slackSubscriptions.workspaceId, workspaceId))
      .orderBy(asc(slackSubscriptions.createdAt));
    return {
      data: rows.map((r) => ({
        ...this.present(r.sub),
        scope: r.sub.databaseId
          ? { kind: 'database' as const, id: r.sub.databaseId, name: r.databaseName ?? '', space_id: r.databaseSpaceId }
          : { kind: 'space' as const, id: r.sub.spaceId!, name: r.spaceName ?? '' },
        /** true when this target is closed to some members: its titles go to a channel whose membership we do not control. */
        closed: Boolean(r.spaceRestricted || r.databaseRestricted),
        created_by_name: r.creatorName ?? null,
      })),
    };
  }

  async create(
    workspaceId: string,
    actorId: string,
    input: { space_id?: string; database_id?: string; channel?: string; events: SubscriptionEventKind[]; acknowledge_restricted?: boolean },
  ) {
    if ((input.space_id == null) === (input.database_id == null)) {
      throw new UnprocessableEntityException('A subscription is on exactly one of a space or a database: send space_id or database_id, not both and not neither');
    }
    const events = normaliseEvents(input.events);
    const channel = await this.validatedChannel(workspaceId, input.channel);
    const target = await this.resolveManagedTarget(workspaceId, actorId, input.space_id, input.database_id);
    this.assertClosedAcknowledged(target.closed, input.acknowledge_restricted);
    try {
      const [row] = await this.db
        .insert(slackSubscriptions)
        .values({ workspaceId, spaceId: input.space_id ?? null, databaseId: input.database_id ?? null, channel, events, createdBy: actorId })
        .returning();
      return this.presentWithScope(row!, target);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('That channel already has a subscription on this space or database. Change the existing one instead.');
      throw error;
    }
  }

  /** Change events or channel, and TAKE OVER: the admin who does this becomes the creator and a `needs_attention` flag clears. */
  async update(workspaceId: string, id: string, actorId: string, patch: { channel?: string | null; events?: SubscriptionEventKind[]; acknowledge_restricted?: boolean }) {
    const existing = await this.getRow(workspaceId, id);
    const set: Partial<typeof slackSubscriptions.$inferInsert> = { createdBy: actorId, needsAttention: null, updatedAt: new Date() };
    if (patch.events !== undefined) set.events = normaliseEvents(patch.events);
    if (patch.channel !== undefined) set.channel = await this.validatedChannel(workspaceId, patch.channel ?? undefined);
    const target = await this.resolveManagedTarget(workspaceId, actorId, existing.spaceId ?? undefined, existing.databaseId ?? undefined);
    this.assertClosedAcknowledged(target.closed, patch.acknowledge_restricted);
    try {
      const [row] = await this.db.update(slackSubscriptions).set(set).where(and(eq(slackSubscriptions.id, id), eq(slackSubscriptions.workspaceId, workspaceId))).returning();
      return this.presentWithScope(row!, target);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('That channel already has a subscription on this space or database.');
      throw error;
    }
  }

  async remove(workspaceId: string, id: string): Promise<{ deleted: true }> {
    await this.getRow(workspaceId, id);
    await this.db.delete(slackSubscriptions).where(and(eq(slackSubscriptions.id, id), eq(slackSubscriptions.workspaceId, workspaceId)));
    return { deleted: true };
  }

  private async getRow(workspaceId: string, id: string): Promise<Row> {
    const row = await this.db.query.slackSubscriptions.findFirst({ where: and(eq(slackSubscriptions.id, id), eq(slackSubscriptions.workspaceId, workspaceId)) });
    if (!row) throw new NotFoundException('Subscription not found');
    return row;
  }

  /**
   * What the workspace's Slack connection can actually do, so a subscription is never saved into a place it cannot post:
   * a bot token posts to the named channel; an incoming webhook fixes the channel, so naming one would be a lie.
   */
  private async validatedChannel(workspaceId: string, raw: string | undefined): Promise<string | null> {
    const config = await this.slack.getConfig(workspaceId);
    if (!config.has_token && !config.has_webhook) throw new UnprocessableEntityException('Connect Slack first (a bot token or an incoming webhook) in the workspace Slack settings');
    if (raw === undefined || raw.trim() === '') {
      if (config.has_token && !config.default_channel) throw new UnprocessableEntityException('Name a channel: this workspace posts through a bot token and has no default channel');
      return null;
    }
    if (!config.has_token) {
      throw new UnprocessableEntityException('This workspace posts through an incoming webhook, which fixes the channel. Leave the channel empty, or save a bot token to choose one.');
    }
    const checked = slackChannelProblem(raw);
    if ('problem' in checked) throw new UnprocessableEntityException(checked.problem);
    return checked.channel;
  }

  /** The target must exist in THIS workspace, be live, and not be someone's personal space (an admin has no bypass there: 404). */
  private async resolveManagedTarget(workspaceId: string, actorId: string, spaceId?: string, databaseId?: string): Promise<{ closed: boolean; databaseName?: string; spaceName: string; spaceId: string }> {
    const notFound = () => new NotFoundException(databaseId ? 'Database not found' : 'Space not found');
    let sid = spaceId;
    let databaseName: string | undefined;
    let databaseRestricted = false;
    if (databaseId) {
      const db = await this.db.query.databases.findFirst({ where: and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId), isNull(databases.deletedAt)) });
      if (!db) throw notFound();
      if (db.isSystem) throw new UnprocessableEntityException('System databases (the member directory and the agent runtime) are never posted to Slack');
      sid = db.spaceId;
      databaseName = db.name;
      databaseRestricted = db.restricted;
    }
    const space = await this.db.query.spaces.findFirst({ where: and(eq(spaces.id, sid!), eq(spaces.workspaceId, workspaceId), isNull(spaces.deletedAt)) });
    if (!space) throw notFound();
    if (space.personal) {
      if (space.ownerUserId !== actorId) throw notFound();
      throw new UnprocessableEntityException('Personal space content is private and is never posted to Slack');
    }
    return { closed: space.restricted || databaseRestricted, databaseName, spaceName: space.name, spaceId: space.id };
  }

  private assertClosedAcknowledged(closed: boolean, acknowledged: boolean | undefined) {
    if (closed && !acknowledged) {
      throw new UnprocessableEntityException({
        code: RESTRICTED_ACK_CODE,
        message:
        'This space or database is restricted. Subscribing it posts the titles of its records to a Slack channel whose members StoryOS does not control. Send acknowledge_restricted: true to confirm that is intended.',
      });
    }
  }

  private present(row: Row) {
    return {
      id: row.id,
      channel: row.channel,
      events: row.events as SubscriptionEventKind[],
      created_by: row.createdBy,
      /** Why it is not posting right now (`creator_left` | `creator_not_admin`), or null. */
      needs_attention: row.needsAttention,
      sent_count: row.sentCount,
      failed_count: row.failedCount,
      last_error: row.lastError,
      last_error_at: row.lastErrorAt,
      last_sent_at: row.lastSentAt,
      created_at: row.createdAt,
    };
  }

  private presentWithScope(row: Row, target: { closed: boolean; databaseName?: string; spaceName: string; spaceId: string }) {
    return {
      ...this.present(row),
      scope: row.databaseId
        ? { kind: 'database' as const, id: row.databaseId, name: target.databaseName ?? '', space_id: target.spaceId }
        : { kind: 'space' as const, id: row.spaceId!, name: target.spaceName },
      closed: target.closed,
    };
  }

  // ---------------------------------------------------------------- emit time

  /** The bus listener: `record_created`, and `record_updated` when the status field is among what changed. */
  async onRecordEvent(event: DomainEvent): Promise<void> {
    if (event.type !== 'record_created' && event.type !== 'record_updated') return;
    const kind: SubscriptionEventKind = event.type === 'record_created' ? 'created' : 'status_changed';
    // An import is not news. A created record from an import posts nothing; a status change posts only when it came from an INCREMENTAL
    // read (what the source changed since its cursor), never from a full read or a first import, which touch every record.
    if (event.importRun && (kind === 'created' || event.importRun === 'full')) return;
    const subs = await this.candidates(event.workspaceId, event.databaseId);
    if (!subs.some((s) => (s.events as string[]).includes(kind))) return; // none of them wants this kind: the common answer, and the cheap one
    try {
      await this.processEvent(event, kind, subs);
    } catch (error) {
      await this.recordFailure(subs, error); // a failure BEFORE any attempt is counted and shown too, never only logged
    }
  }

  private async processEvent(event: DomainEvent, kind: SubscriptionEventKind, subs: Row[]): Promise<void> {
    const target = await this.loadTarget(event.workspaceId, event.databaseId);
    if (!target) return;

    let previousState: string | null = null;
    const status = await this.statusOf(event.databaseId);
    if (kind === 'status_changed') {
      if (!status || !event.changedFieldIds?.includes(status.fieldId)) return;
      const from = event.changedValues?.[status.fieldId]?.from;
      previousState = typeof from === 'string' ? (status.labels.get(from) ?? null) : null;
    }
    await this.deliverEvent({
      kind,
      eventId: event.eventId ?? `${event.recordId}:${kind}`,
      workspaceId: event.workspaceId,
      recordId: event.recordId,
      actorId: event.actorId,
      source: event.source ?? null,
      imported: Boolean(event.importRun),
      origin: event.origin ?? null,
      previousState,
      subs,
      target,
      status,
    });
  }

  /** Called by CommentsService after a comment is written through the API (an importer writes comments another way and never gets here). */
  onCommented(input: { workspaceId: string; recordId: string; commentId: string; authorId: string; source: string | null }): Promise<void> {
    return this.track(this.handleCommented(input));
  }

  private async handleCommented(input: { workspaceId: string; recordId: string; commentId: string; authorId: string; source: string | null }): Promise<void> {
    const rec = await this.db.query.records.findFirst({ where: eq(records.id, input.recordId), columns: { databaseId: true } });
    if (!rec) return;
    const subs = await this.candidates(input.workspaceId, rec.databaseId);
    if (!subs.some((s) => (s.events as string[]).includes('commented'))) return;
    try {
      await this.processComment(input, rec.databaseId, subs);
    } catch (error) {
      await this.recordFailure(subs, error);
    }
  }

  private async processComment(input: { workspaceId: string; recordId: string; commentId: string; authorId: string; source: string | null }, databaseId: string, subs: Row[]): Promise<void> {
    const target = await this.loadTarget(input.workspaceId, databaseId);
    if (!target) return;
    await this.deliverEvent({
      kind: 'commented',
      eventId: input.commentId,
      workspaceId: input.workspaceId,
      recordId: input.recordId,
      actorId: input.authorId,
      source: input.source,
      imported: false,
      origin: currentEventOrigin(),
      previousState: null,
      subs,
      target,
      status: await this.statusOf(databaseId),
    });
  }

  /** Every subscription that could cover this database: its own, and its space's. Cheap and indexed: the common answer is none. */
  private async candidates(workspaceId: string, databaseId: string): Promise<Row[]> {
    return this.db
      .select({ s: slackSubscriptions })
      .from(slackSubscriptions)
      .where(
        and(
          eq(slackSubscriptions.workspaceId, workspaceId),
          sql`(${slackSubscriptions.databaseId} = ${databaseId} OR ${slackSubscriptions.spaceId} = (SELECT space_id FROM databases WHERE id = ${databaseId}))`,
        ),
      )
      .then((rows) => rows.map((r) => r.s));
  }

  /** The database and its space, or null when either is deleted or the space is personal: those post nothing, ever. */
  private async loadTarget(workspaceId: string, databaseId: string): Promise<Target | null> {
    const [row] = await this.db
      .select({
        databaseName: databases.name,
        databaseRestricted: databases.restricted,
        databaseIsSystem: databases.isSystem,
        identifierPrefix: databases.identifierPrefix,
        databaseDeleted: databases.deletedAt,
        spaceId: spaces.id,
        spaceRestricted: spaces.restricted,
        spacePersonal: spaces.personal,
        spaceDeleted: spaces.deletedAt,
      })
      .from(databases)
      .innerJoin(spaces, eq(spaces.id, databases.spaceId))
      .where(and(eq(databases.id, databaseId), eq(databases.workspaceId, workspaceId)))
      .limit(1);
    if (!row || row.databaseDeleted || row.spaceDeleted || row.spacePersonal) return null;
    return {
      workspaceId,
      databaseId,
      databaseName: row.databaseName,
      databaseRestricted: row.databaseRestricted,
      databaseIsSystem: row.databaseIsSystem,
      identifierPrefix: row.identifierPrefix,
      spaceId: row.spaceId,
      spaceRestricted: row.spaceRestricted,
    };
  }

  /**
   * The database's STATUS field: its workflow field, else the single-select `state`/`status` field (the Linear mirror's State is a
   * plain select, built before workflow fields existed). Null when it has neither, and then `status_changed` never fires for it.
   */
  private async statusOf(databaseId: string): Promise<{ fieldId: string; labels: Map<string, string> } | null> {
    const defs = await this.db.query.fields.findMany({ where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)) });
    const field = defs.find((f) => f.type === 'workflow') ?? defs.find((f) => f.type === 'select' && ['state', 'status'].includes(f.apiName.toLowerCase()));
    if (!field) return null;
    const options = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, field.id) });
    return { fieldId: field.id, labels: new Map(options.map((o) => [o.id, o.label])) };
  }

  /** A failure before any send was attempted: counted on the subscriptions it concerned and shown, like a failed post. */
  private async recordFailure(subs: Row[], error: unknown): Promise<void> {
    this.logger.warn(`slack subscription event failed before sending: ${String(error)}`);
    await this.db
      .update(slackSubscriptions)
      .set({ failedCount: sql`${slackSubscriptions.failedCount} + 1`, lastError: redactError(`Not sent: ${error instanceof Error ? error.message : String(error)}`), lastErrorAt: new Date() })
      .where(inArray(slackSubscriptions.id, subs.map((x) => x.id)))
      .catch(() => undefined);
  }

  private async deliverEvent(e: {
    kind: SubscriptionEventKind;
    eventId: string;
    workspaceId: string;
    recordId: string;
    actorId: string | null;
    source: string | null;
    imported: boolean;
    origin: EventOrigin | null;
    previousState: string | null;
    subs: Row[];
    target: Target;
    status: { fieldId: string; labels: Map<string, string> } | null;
  }): Promise<void> {
    // The Members directory (names and e-mails) and the agent runtime's own databases belong to services, not to the people reading a channel.
    if (e.target.databaseIsSystem) return;
    const record = await this.db.query.records.findFirst({ where: eq(records.id, e.recordId) });
    if (!record || record.deletedAt) return; // a trashed record posts nothing

    // A space subscription does not reach into a database that is itself restricted: that needs a subscription of its own.
    let usable = e.subs.filter((s) => s.databaseId != null || !e.target.databaseRestricted);
    usable = await this.liveCreators(e.workspaceId, usable);
    if (usable.length === 0) return;

    // One post per channel: a database-level subscription governs over the space's for the same channel.
    const byChannel = new Map<string, Row>();
    for (const s of usable) {
      const key = s.channel ?? '';
      const held = byChannel.get(key);
      if (!held || (held.databaseId == null && s.databaseId != null)) byChannel.set(key, s);
    }
    const winners = [...byChannel.values()].filter((s) => (s.events as string[]).includes(e.kind));
    if (winners.length === 0) return;

    const stateId = e.status ? (record.values as Record<string, unknown>)[e.status.fieldId] : undefined;
    const state = typeof stateId === 'string' ? (e.status?.labels.get(stateId) ?? null) : null;
    let actorName: string | null = null;
    if (e.actorId) {
      const [u] = await this.db.select({ name: user.name }).from(user).where(eq(user.id, e.actorId)).limit(1);
      actorName = u?.name ?? null;
    }
    const via: ViaKind = e.imported ? 'sync' : e.source === 'agent' ? 'agent' : e.source === 'automation' ? 'automation' : e.source === 'mcp' ? 'mcp' : null;
    const text = renderSubscriptionMessage({
      kind: e.kind,
      title: record.titleLocal ?? record.title,
      identifier: e.target.identifierPrefix && record.number != null ? `${e.target.identifierPrefix}-${record.number}` : null,
      state,
      previousState: e.previousState,
      actorName,
      via,
      url: `${env().WEB_URL.replace(/\/$/, '')}/r/${record.id}`,
    });
    for (const s of winners) {
      this.enqueue(
        { workspaceId: e.workspaceId, channel: s.channel, text, subscriptionIds: [s.id], origin: e.origin, recordId: record.id, recordTitle: record.titleLocal ?? record.title },
        `${e.workspaceId}:${s.channel ?? ''}:${e.eventId}:${e.kind}`,
      );
    }
  }

  /**
   * The creator is re-checked on EVERY event, never trusted from the row: a subscription whose admin has left or been demoted stops
   * posting and says so. One that is fine again (re-promoted) clears its own flag.
   */
  private async liveCreators(workspaceId: string, subs: Row[]): Promise<Row[]> {
    const ids = [...new Set(subs.map((s) => s.createdBy))];
    const rows = await this.db.query.memberships.findMany({ where: and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, ids)) });
    const byUser = new Map(rows.map((m) => [m.userId, m]));
    const ok: Row[] = [];
    for (const s of subs) {
      const m = byUser.get(s.createdBy);
      const reason = !m || m.status !== 'active' ? 'creator_left' : m.role !== 'admin' ? 'creator_not_admin' : null;
      if (reason === null) {
        if (s.needsAttention) await this.db.update(slackSubscriptions).set({ needsAttention: null }).where(eq(slackSubscriptions.id, s.id));
        ok.push(s);
      } else if (s.needsAttention !== reason) {
        await this.db.update(slackSubscriptions).set({ needsAttention: reason }).where(eq(slackSubscriptions.id, s.id));
      }
    }
    return ok;
  }

  // ---------------------------------------------------------------- delivery: paced, coalesced, retried, counted

  private enqueue(message: Outgoing, dedupeKey: string): void {
    const now = Date.now();
    for (const [k, expires] of this.seen) if (expires < now) this.seen.delete(k);
    if (this.seen.has(dedupeKey)) return; // the same event to the same channel is posted once
    this.seen.set(dedupeKey, now + DEDUPE_TTL_MS);
    const key = `${message.workspaceId}|${message.channel ?? ''}`;
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { items: [], lastSentAt: 0, running: false };
      this.queues.set(key, queue);
    }
    queue.items.push(message);
    if (!queue.running) {
      queue.running = true;
      const run: Promise<void> = this.drain(key).finally(() => this.draining.delete(run));
      this.draining.add(run);
    }
  }

  private async drain(key: string): Promise<void> {
    const queue = this.queues.get(key)!;
    await this.deliveryGate;
    while (queue.items.length > 0) {
      const wait = queue.lastSentAt + this.sendIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      // A burst: everything waiting beyond the threshold becomes ONE line saying how many, never dropped without a word.
      let next: Outgoing;
      if (queue.items.length > this.coalesceAfter) {
        const all = queue.items.splice(0, queue.items.length);
        next = { ...all[0]!, text: renderCoalescedMessage(all.length), subscriptionIds: [...new Set(all.flatMap((m) => m.subscriptionIds))], origin: null, recordId: '', recordTitle: '' };
      } else {
        next = queue.items.shift()!;
      }
      await this.sendWithRetry(next);
      queue.lastSentAt = Date.now();
    }
    this.queues.delete(key);
  }

  private async sendWithRetry(m: Outgoing): Promise<void> {
    let lastError = '';
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]!);
      try {
        await this.slack.sendMessage(m.workspaceId, { channel: m.channel ?? undefined, text: m.text });
        await this.db
          .update(slackSubscriptions)
          .set({ sentCount: sql`${slackSubscriptions.sentCount} + 1`, lastSentAt: new Date() })
          .where(inArray(slackSubscriptions.id, m.subscriptionIds));
        // #1174: an agent's write that caused an outward post is logged with the agent and the run (the destination is the admin's).
        if (m.origin && m.recordId) {
          await logAgentOriginOutward(this.db, { workspaceId: m.workspaceId, recordId: m.recordId, recordTitle: m.recordTitle, channel: 'slack_subscription', summary: 'record change posted to a Slack channel subscription', origin: m.origin }).catch(() => undefined);
        }
        return;
      } catch (error) {
        // Slack's own error code or an HTTP status, from SlackService: never a token and never a remote body.
        lastError = redactError(error instanceof Error ? error.message : String(error));
        // Shown NOW, not after the last retry: with the backoff below a dead destination takes ~36 s to give up, and until then the
        // list used to read sent 0 / failed 0 / no error, which looks exactly like "nothing happened". failed_count still counts the message once.
        await this.db
          .update(slackSubscriptions)
          .set({ lastError, lastErrorAt: new Date() })
          .where(inArray(slackSubscriptions.id, m.subscriptionIds))
          .catch(() => undefined);
      }
    }
    await this.db
      .update(slackSubscriptions)
      .set({ failedCount: sql`${slackSubscriptions.failedCount} + 1`, lastError, lastErrorAt: new Date() })
      .where(inArray(slackSubscriptions.id, m.subscriptionIds))
      .catch(() => undefined);
  }
}

/**
 * What may be stored in `last_error` and shown to an admin: SlackService already answers with Slack's error code or an HTTP status, but
 * an error from the transport can carry the webhook URL (itself a secret) or a token. Every URL and anything token-shaped is replaced.
 */
export function redactError(message: string): string {
  return message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[host]') // a bare host name (a resolver error names it): the webhook's host is part of the secret
    .replace(/\b(?:xox[a-z]-|xapp-|mn_pat_)[\w-]+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    .slice(0, 200);
}

function normaliseEvents(events: SubscriptionEventKind[]): SubscriptionEventKind[] {
  const set = new Set(events);
  const out = SUBSCRIPTION_EVENTS.filter((e) => set.has(e));
  if (out.length === 0) throw new UnprocessableEntityException(`Choose at least one event: ${SUBSCRIPTION_EVENTS.join(', ')}`);
  return [...out];
}

function isUniqueViolation(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 4 && e; i += 1) {
    if ((e as { code?: string }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
