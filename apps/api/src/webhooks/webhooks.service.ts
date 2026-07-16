import { randomBytes } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { WebhookEvent } from '@storyos/schemas';
import { env } from '../config/env';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import {
  activityEvents,
  databases,
  records,
  webhookDeliveries,
  webhookSubscriptions,
  workspaces,
} from '../db/schema';
import {
  MAX_ATTEMPTS,
  defaultWebhookFetcher,
  deliverWebhook,
  nextAttemptDelayMs,
  type WebhookFetcher,
} from './webhook-sender';

/**
 * MN-032: outgoing webhooks, built the way ADR-0004 planned them — a
 * subscriptions table plus a dispatcher over the `activity_events` outbox.
 *
 * Two passes, 30s apart:
 *   scan()  — turn new activity events into pending deliveries, advance cursors
 *   flush() — send what's due, retry with backoff, settle after MAX_ATTEMPTS
 *
 * Splitting them means a slow/dead receiver can never stall event capture: the
 * delivery row is durable the moment the event is seen, so nothing is lost if the
 * process dies mid-send.
 */
@Injectable()
export class WebhooksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhooksService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Swappable so tests never touch the network. */
  fetcher: WebhookFetcher = defaultWebhookFetcher;

  constructor(@Inject(DB) private readonly db: Db) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.tick(), 30_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // --- CRUD ---

  /** snake_case is the public contract here, as everywhere else in the API. */
  private toPublic(row: typeof webhookSubscriptions.$inferSelect) {
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      database_id: row.databaseId,
      url: row.url,
      events: row.events as string[],
      enabled: row.enabled,
      last_status: row.lastStatus,
      last_status_code: row.lastStatusCode,
      last_error: row.lastError,
      last_delivered_at: row.lastDeliveredAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  /** The secret is write-only: it's shown once at create, never listed. */
  async list(workspaceId: string) {
    const rows = await this.db.query.webhookSubscriptions.findMany({
      where: eq(webhookSubscriptions.workspaceId, workspaceId),
      orderBy: [desc(webhookSubscriptions.createdAt)],
    });
    return rows.map((row) => this.toPublic(row));
  }

  async create(
    workspaceId: string,
    input: { url: string; database_id?: string; events: WebhookEvent[]; enabled: boolean },
    createdBy: string,
  ) {
    if (input.database_id) {
      const db = await this.db.query.databases.findFirst({
        where: eq(databases.id, input.database_id),
      });
      if (!db) throw new NotFoundException('database not found');
    }
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    const [row] = await this.db
      .insert(webhookSubscriptions)
      .values({
        workspaceId,
        databaseId: input.database_id ?? null,
        url: input.url,
        events: input.events,
        secret,
        enabled: input.enabled,
        createdBy,
      })
      .returning();
    // Shown once, like a PAT — after this the plaintext is never returned.
    return { ...this.toPublic(row!), secret };
  }

  async update(
    workspaceId: string,
    id: string,
    input: { url?: string; events?: WebhookEvent[]; enabled?: boolean },
  ) {
    const [row] = await this.db
      .update(webhookSubscriptions)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.workspaceId, workspaceId)),
      )
      .returning();
    if (!row) throw new NotFoundException('webhook not found');
    return this.toPublic(row);
  }

  async remove(workspaceId: string, id: string) {
    const [row] = await this.db
      .delete(webhookSubscriptions)
      .where(
        and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.workspaceId, workspaceId)),
      )
      .returning({ id: webhookSubscriptions.id });
    if (!row) throw new NotFoundException('webhook not found');
    return { ok: true };
  }

  /** Recent attempts for one subscription — the "why isn't it working" view. */
  async deliveries(workspaceId: string, id: string, limit = 20) {
    const sub = await this.db.query.webhookSubscriptions.findFirst({
      where: and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.workspaceId, workspaceId)),
    });
    if (!sub) throw new NotFoundException('webhook not found');
    const rows = await this.db.query.webhookDeliveries.findMany({
      where: eq(webhookDeliveries.subscriptionId, id),
      orderBy: [desc(webhookDeliveries.createdAt)],
      limit,
    });
    return rows.map((d) => ({
      id: d.id,
      event_id: d.eventId,
      event_type: d.eventType,
      status: d.status,
      attempts: d.attempts,
      status_code: d.statusCode,
      error: d.error,
      next_attempt_at: d.nextAttemptAt,
      delivered_at: d.deliveredAt,
      created_at: d.createdAt,
    }));
  }

  // --- dispatch ---

  /** One full pass. Public so tests drive it directly instead of waiting on a timer. */
  async tick(): Promise<void> {
    try {
      await this.scan();
      await this.flush();
    } catch (err) {
      this.logger.error(`webhook tick failed: ${String(err)}`);
    }
  }

  /**
   * Turn activity events into pending deliveries. The cursor advances to the last
   * event actually seen (not "now"), so an event written while this pass runs is
   * picked up next time rather than skipped.
   */
  async scan(): Promise<number> {
    const subs = await this.db.query.webhookSubscriptions.findMany({
      where: eq(webhookSubscriptions.enabled, true),
      limit: 100,
    });
    let queued = 0;

    for (const sub of subs) {
      const types = (sub.events as string[]) ?? [];
      if (types.length === 0) continue;

      // record_id -> database_id, so a per-database subscription can filter.
      const rows = await this.db
        .select({
          id: activityEvents.id,
          type: activityEvents.type,
          recordId: activityEvents.recordId,
          actorId: activityEvents.actorId,
          payload: activityEvents.payload,
          createdAt: activityEvents.createdAt,
          databaseId: records.databaseId,
          databaseName: databases.name,
          spaceId: databases.spaceId,
          recordTitle: records.title,
          recordValues: records.values,
        })
        .from(activityEvents)
        .leftJoin(records, eq(records.id, activityEvents.recordId))
        .leftJoin(databases, eq(databases.id, records.databaseId))
        .where(
          and(
            eq(activityEvents.workspaceId, sub.workspaceId),
            // Compared in SQL against the stored column: created_at is microsecond
            // precision and a JS Date is milliseconds, so a round-tripped cursor
            // lands before the event it already saw and rescans it forever.
            gt(
              activityEvents.createdAt,
              sql`(SELECT cursor_at FROM webhook_subscriptions WHERE id = ${sub.id})`,
            ),
            inArray(activityEvents.type, types),
            sub.databaseId ? eq(records.databaseId, sub.databaseId) : sql`true`,
          ),
        )
        .orderBy(asc(activityEvents.createdAt))
        .limit(200);

      if (rows.length === 0) continue;

      await this.db
        .insert(webhookDeliveries)
        .values(
        rows.map((e) => ({
          subscriptionId: sub.id,
          workspaceId: sub.workspaceId,
          url: sub.url,
          eventId: e.id,
          eventType: e.type,
          payload: {
            event: e.type,
            delivered_for: sub.id,
            occurred_at: e.createdAt.toISOString(),
            actor_id: e.actorId,
            workspace: { id: sub.workspaceId },
            space: e.spaceId ? { id: e.spaceId } : null,
            database: e.databaseId ? { id: e.databaseId, name: e.databaseName } : null,
            record: e.recordId
              ? { id: e.recordId, title: e.recordTitle, values: e.recordValues }
              : null,
            changes: e.payload,
          },
          status: 'pending',
          nextAttemptAt: new Date(),
        })),
        )
        // Belt to the unique index's braces: a rescan re-queues nothing.
        .onConflictDoNothing({
          target: [webhookDeliveries.subscriptionId, webhookDeliveries.eventId],
        });
      queued += rows.length;

      // Advance the cursor in SQL, not from the JS Date: Postgres keeps
      // created_at at microsecond precision and the driver hands back a
      // millisecond Date, so writing that value back lands *before* the event and
      // rescans it forever.
      const lastId = rows[rows.length - 1]!.id;
      await this.db.execute(sql`
        UPDATE webhook_subscriptions
        SET cursor_at = (SELECT created_at FROM activity_events WHERE id = ${lastId})
        WHERE id = ${sub.id}
      `);
    }
    return queued;
  }

  /** Send every due delivery, then reschedule or settle it. */
  async flush(): Promise<number> {
    const due = await this.db.query.webhookDeliveries.findMany({
      where: and(
        eq(webhookDeliveries.status, 'pending'),
        or(isNull(webhookDeliveries.nextAttemptAt), lte(webhookDeliveries.nextAttemptAt, new Date())),
      ),
      orderBy: [asc(webhookDeliveries.createdAt)],
      limit: 50,
    });

    let sent = 0;
    for (const delivery of due) {
      // Advisory lock: two replicas ticking at once must not double-send.
      const locked = (await this.db.execute(
        sql`SELECT pg_try_advisory_lock(hashtext(${delivery.id})) AS locked`,
      )) as unknown as { rows?: Array<{ locked: boolean }> };
      if (!locked.rows?.[0]?.locked) continue;

      try {
        const secret = await this.secretFor(delivery);
        if (!secret) {
          await this.settle(delivery.id, 'failed', undefined, 'no signing secret');
          continue;
        }
        const attempts = delivery.attempts + 1;
        const result = await deliverWebhook(this.fetcher, {
          url: delivery.url,
          secret,
          body: delivery.payload,
          eventType: delivery.eventType,
          deliveryId: delivery.id,
        });
        sent += 1;

        if (result.ok) {
          await this.settle(delivery.id, 'ok', result.statusCode, null, attempts);
        } else {
          const delay = nextAttemptDelayMs(attempts);
          if (delay === null) {
            await this.settle(delivery.id, 'failed', result.statusCode, result.error, attempts);
          } else {
            await this.db
              .update(webhookDeliveries)
              .set({
                attempts,
                statusCode: result.statusCode ?? null,
                error: result.error ?? null,
                nextAttemptAt: new Date(Date.now() + delay),
              })
              .where(eq(webhookDeliveries.id, delivery.id));
            await this.markSubscription(delivery.subscriptionId, 'failed', result);
          }
        }
      } finally {
        await this.db.execute(sql`SELECT pg_advisory_unlock(hashtext(${delivery.id}))`);
      }
    }
    return sent;
  }

  private async settle(
    id: string,
    status: 'ok' | 'failed',
    statusCode?: number,
    error?: string | null,
    attempts?: number,
  ) {
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({
        status,
        statusCode: statusCode ?? null,
        error: error ?? null,
        nextAttemptAt: null,
        deliveredAt: status === 'ok' ? new Date() : null,
        ...(attempts !== undefined ? { attempts } : {}),
      })
      .where(eq(webhookDeliveries.id, id))
      .returning({ subscriptionId: webhookDeliveries.subscriptionId });
    await this.markSubscription(row?.subscriptionId ?? null, status, {
      ok: status === 'ok',
      statusCode,
      error: error ?? undefined,
    });
  }

  /** Denormalized last-delivery status for the settings list. */
  private async markSubscription(
    subscriptionId: string | null,
    status: 'ok' | 'failed',
    result: { ok: boolean; statusCode?: number; error?: string },
  ) {
    if (!subscriptionId) return;
    await this.db
      .update(webhookSubscriptions)
      .set({
        lastStatus: status,
        lastStatusCode: result.statusCode ?? null,
        lastError: result.error ?? null,
        lastDeliveredAt: new Date(),
      })
      .where(eq(webhookSubscriptions.id, subscriptionId));
  }

  /** A subscription signs with its own secret; a button webhook with the workspace's. */
  private async secretFor(delivery: { subscriptionId: string | null; workspaceId: string }) {
    if (delivery.subscriptionId) {
      const sub = await this.db.query.webhookSubscriptions.findFirst({
        where: eq(webhookSubscriptions.id, delivery.subscriptionId),
        columns: { secret: true },
      });
      return sub?.secret ?? null;
    }
    return this.workspaceSigningSecret(delivery.workspaceId);
  }

  /**
   * MN-088: button webhooks have no subscription, so they sign with a
   * workspace-wide secret, minted on first use. Redacted out of settings reads by
   * redact-secrets (`webhooksigningsecret`).
   */
  async workspaceSigningSecret(workspaceId: string): Promise<string | null> {
    const ws = await this.db.query.workspaces.findFirst({
      where: eq(workspaces.id, workspaceId),
      columns: { settings: true },
    });
    if (!ws) return null;
    const settings = (ws.settings ?? {}) as Record<string, unknown>;
    const existing = settings['webhook_signing_secret'];
    if (typeof existing === 'string' && existing.length > 0) return existing;

    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    await this.db
      .update(workspaces)
      .set({ settings: { ...settings, webhook_signing_secret: secret } })
      .where(eq(workspaces.id, workspaceId));
    return secret;
  }

  /**
   * Queue a one-off webhook (MN-088's button action). Returns the delivery row so
   * the caller can report the outcome; the retry path is the shared one.
   */
  async enqueueDirect(input: {
    workspaceId: string;
    url: string;
    eventType: string;
    payload: unknown;
    headers?: Record<string, string>;
  }) {
    const [row] = await this.db
      .insert(webhookDeliveries)
      .values({
        subscriptionId: null,
        workspaceId: input.workspaceId,
        url: input.url,
        eventType: input.eventType,
        payload: input.payload as object,
        status: 'pending',
        nextAttemptAt: new Date(),
      })
      .returning();
    return row!;
  }

  /**
   * Send one delivery immediately and report the result, so a button press can
   * show a real status code instead of "queued". A failure still leaves the row
   * pending, so the shared backoff retries it.
   */
  async sendNow(
    deliveryId: string,
    headers?: Record<string, string>,
  ): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
    const delivery = await this.db.query.webhookDeliveries.findFirst({
      where: eq(webhookDeliveries.id, deliveryId),
    });
    if (!delivery) return { ok: false, error: 'delivery not found' };
    const secret = await this.secretFor(delivery);
    if (!secret) return { ok: false, error: 'no signing secret' };

    const attempts = delivery.attempts + 1;
    const result = await deliverWebhook(this.fetcher, {
      url: delivery.url,
      secret,
      body: delivery.payload,
      eventType: delivery.eventType,
      deliveryId: delivery.id,
      headers,
    });
    if (result.ok) {
      await this.settle(delivery.id, 'ok', result.statusCode, null, attempts);
    } else {
      const delay = nextAttemptDelayMs(attempts);
      await this.db
        .update(webhookDeliveries)
        .set({
          attempts,
          statusCode: result.statusCode ?? null,
          error: result.error ?? null,
          ...(delay === null ? { status: 'failed', nextAttemptAt: null } : { nextAttemptAt: new Date(Date.now() + delay) }),
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    }
    return result;
  }
}

export { MAX_ATTEMPTS };
