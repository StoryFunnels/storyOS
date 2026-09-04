import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, sourceRuns, sources } from '../db/schema';
import { env } from '../config/env';
import { RecordsService } from '../records/records.service';
import { ConnectionsService } from '../connections/connections.service';
import { NotificationsService } from '../notifications/notifications.service';
import { defaultConnectionFetcher } from '../connections/providers/types';
import type { ConnectionFetcher } from '../connections/providers/types';
import { DEFAULT_SOURCE_RECURRENCE, sourceConflictPolicySchema } from '@storyos/schemas';
import type { SourceConflictPolicy, SourceFieldMapping, SourceRecurrence } from '@storyos/schemas';
import { SOURCE_PROVIDER_REGISTRY, SourceSyncError, isProviderEnabled } from './providers';
import { listChannels } from './providers/youtube';
import type { SourceProviderDescriptor, SourceSyncContext } from './providers';
import { isRecurrenceDue, scheduleFromRecurrence } from './recurrence';
import { mappedFieldIds, normalizeFieldMapping } from './field-mapping';

type SourceRow = typeof sources.$inferSelect;

/** #239 — YouTube's daily API cap is per-key, not tied to any one call, so
 * every provider here shares the same budget name regardless of which
 * provider actually runs. Widen this map if a later provider (Apify, a
 * different platform) needs its own named budget. */
const QUOTA_BUDGET_BY_CONNECTION_PROVIDER: Record<string, () => number> = {
  google: () => env().YOUTUBE_DAILY_QUOTA_UNITS,
};

/**
 * #279 — the write-back gate. Lives in `config` rather than a real column
 * (the ticket's own lane note: `config` is jsonb, so this needs no drizzle
 * migration, and only one may be in flight across all open PRs at once).
 * A framework-owned key, not a provider one, so it must be split out before
 * `descriptor.configSchema.safeParse()` — a provider's own schema (e.g.
 * shopify's `z.object({})`) knows nothing about it and would otherwise strip
 * it from the validated result on every create.
 */
const WRITE_BACK_CONFIG_KEY = 'write_back';
/** #280 — same reasoning, same reserved-key treatment, as WRITE_BACK_CONFIG_KEY. */
const CONFLICT_POLICY_CONFIG_KEY = 'conflict_policy';
const DEFAULT_CONFLICT_POLICY: SourceConflictPolicy = 'external_wins';

function splitReservedConfig(
  config: Record<string, unknown>,
  fallback: { writeBack?: boolean; conflictPolicy?: SourceConflictPolicy } = {},
): { providerConfig: Record<string, unknown>; writeBack: boolean; conflictPolicy: SourceConflictPolicy } {
  const { [WRITE_BACK_CONFIG_KEY]: rawWriteBack, [CONFLICT_POLICY_CONFIG_KEY]: rawPolicy, ...providerConfig } = config;
  const parsedPolicy = sourceConflictPolicySchema.safeParse(rawPolicy);
  return {
    providerConfig,
    writeBack: rawWriteBack === undefined ? (fallback.writeBack ?? false) : rawWriteBack === true,
    conflictPolicy: parsedPolicy.success ? parsedPolicy.data : (fallback.conflictPolicy ?? DEFAULT_CONFLICT_POLICY),
  };
}

/**
 * #239 — the Sources framework: a source is a scheduled sync that upserts
 * external items into a normal database by an external key. NOT a workflow —
 * once data lands as records, views/automations/MCP just work.
 *
 * Scheduler mirrors AutomationsService's 60s tick + per-row advisory lock
 * (automations.service.ts's tick()); the upsert engine is the correctness-
 * critical piece: it must never write to a field that isn't in the source's
 * fieldMapping, so a human or agent's own edit to an unmapped field survives
 * every future resync untouched.
 */
@Injectable()
export class SourcesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourcesService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Swappable in tests, same seam as ConnectionsService.fetcher. */
  fetcher: ConnectionFetcher = defaultConnectionFetcher;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly recordsService: RecordsService,
    private readonly connectionsService: ConnectionsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    if (env().NODE_ENV !== 'test') {
      this.timer = setInterval(() => void this.tick(), 60_000);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ── provider catalog ─────────────────────────────────────────────────────

  listProviders() {
    return {
      // #111 — an env-disabled provider (e.g. LinkedIn before app review clears)
      // is hidden from the catalog, so the "Sync from…" dialog never offers a
      // source that would always fail at sync.
      data: [...SOURCE_PROVIDER_REGISTRY.values()].filter(isProviderEnabled).map((p) => ({
        id: p.id,
        label: p.label,
        connection_provider: p.connectionProvider,
        description: p.description ?? null,
        // #221: so a caller creating a database for this source can brand it.
        icon: p.icon ?? null,
        supports_discover: Boolean(p.discover),
        // #279 — write-back capability, same Boolean(p.x) shape as supports_discover.
        supports_push: Boolean(p.push),
        // #280 — so the "Sync from…" conflict-policy selector can grey out
        // newest_wins with a reason, rather than a silent omission that
        // reads as a missing feature.
        supports_newest_wins: Boolean(p.supportsNewestWins?.()),
        config_schema: zodShapeToFormSpec(p.configSchema),
      })),
    };
  }

  /** MN-262 — a one-off `discover()` call before any source exists, so the
   * "Sync from…" dialog can offer point-and-click field mapping instead of
   * asking the user to read the provider's docs. Config is parsed loosely
   * (safeParse, ignoring failures) since discovery commonly runs on a
   * still-being-filled-in config — a provider's discover() must cope with
   * defaults the same way a fresh, un-configured source would. */
  async discover(workspaceId: string, input: { connection_id: string; provider_source: string; config: Record<string, unknown> }) {
    const descriptor = this.requireProvider(input.provider_source);
    if (!descriptor.discover) {
      throw new BadRequestException(`"${descriptor.id}" does not support field discovery`);
    }
    await this.requireConnectionForProvider(workspaceId, input.connection_id, descriptor);
    const { auth } = await this.connectionsService.getDecryptedAuth(workspaceId, input.connection_id);
    const parsed = descriptor.configSchema.safeParse(input.config ?? {});
    const config = parsed.success ? parsed.data : (input.config ?? {});
    return descriptor.discover(auth, config, this.fetcher);
  }

  /** #341 — the channels the connected Google account owns, for the dialog's
   * required channel picker. Read-through to the YouTube Data API using the
   * connection's stored `youtube.readonly` token; creates/alters nothing. */
  async listYoutubeChannels(workspaceId: string, connectionId: string) {
    const { provider, auth } = await this.connectionsService.getDecryptedAuth(workspaceId, connectionId).catch(() => {
      throw new NotFoundException('Connection not found');
    });
    if (provider !== 'google') {
      throw new BadRequestException(`Listing YouTube channels needs a "google" connection, not "${provider}"`);
    }
    return { data: await listChannels(this.fetcher, auth) };
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async list(databaseId: string) {
    const rows = await this.db.query.sources.findMany({
      where: eq(sources.targetDatabaseId, databaseId),
      orderBy: [desc(sources.createdAt)],
    });
    return { data: rows.map((r) => this.present(r)) };
  }

  private present(row: SourceRow) {
    return {
      id: row.id,
      name: row.name,
      connection_id: row.connectionId,
      provider_source: row.providerSource,
      config: row.config as Record<string, unknown>,
      target_database_id: row.targetDatabaseId,
      field_mapping: row.fieldMapping as SourceFieldMapping,
      external_key_field_id: row.externalKeyFieldId,
      schedule: row.schedule,
      recurrence: (row.recurrence as SourceRecurrence | null) ?? null,
      status: row.status,
      last_sync_at: row.lastSyncAt ? row.lastSyncAt.toISOString() : null,
      created_at: row.createdAt.toISOString(),
    };
  }

  private requireProvider(id: string): SourceProviderDescriptor {
    const descriptor = SOURCE_PROVIDER_REGISTRY.get(id);
    if (!descriptor) throw new NotFoundException(`Unknown source provider "${id}"`);
    return descriptor;
  }

  /** #111 — reject creating a source for a provider the operator has disabled,
   * defending the API even if a stale client still shows it in the picker. */
  private requireEnabledProvider(id: string): SourceProviderDescriptor {
    const descriptor = this.requireProvider(id);
    if (!isProviderEnabled(descriptor)) {
      throw new UnprocessableEntityException(
        `Source provider "${descriptor.id}" is disabled on this server`,
      );
    }
    return descriptor;
  }

  async create(
    workspaceId: string,
    databaseId: string,
    input: {
      name: string;
      connection_id: string;
      provider_source: string;
      config: Record<string, unknown>;
      field_mapping: SourceFieldMapping;
      external_key_field_id: string;
      schedule?: string;
      recurrence?: SourceRecurrence;
    },
    actorId: string,
  ) {
    const descriptor = this.requireEnabledProvider(input.provider_source);
    const connection = await this.requireConnectionForProvider(workspaceId, input.connection_id, descriptor);
    const { providerConfig, writeBack, conflictPolicy } = splitReservedConfig(input.config ?? {});
    const parsedConfig = descriptor.configSchema.safeParse(providerConfig);
    if (!parsedConfig.success) {
      throw new BadRequestException(`Invalid config for "${descriptor.id}": ${parsedConfig.error.message}`);
    }
    if (!mappedFieldIds(input.field_mapping).includes(input.external_key_field_id)) {
      throw new BadRequestException('external_key_field_id must be one of field_mapping\'s target fields');
    }
    this.assertConflictPolicySupported(descriptor, conflictPolicy);

    // #340 — daily is the default for a NEW source. A recurrence, when given,
    // drives scheduling; `schedule` is stored as its coarse shadow so the
    // not-null column + legacy index stay valid. A caller passing only the
    // legacy `schedule` (pre-#340 clients, existing tests) keeps that path.
    const recurrence: SourceRecurrence | undefined =
      input.recurrence ?? (input.schedule ? undefined : DEFAULT_SOURCE_RECURRENCE);
    const schedule = recurrence ? scheduleFromRecurrence(recurrence) : input.schedule!;

    const [row] = await this.db
      .insert(sources)
      .values({
        workspaceId,
        connectionId: connection.id,
        name: input.name,
        providerSource: descriptor.id,
        config: {
          ...parsedConfig.data,
          [WRITE_BACK_CONFIG_KEY]: writeBack,
          [CONFLICT_POLICY_CONFIG_KEY]: conflictPolicy,
        },
        targetDatabaseId: databaseId,
        fieldMapping: input.field_mapping,
        externalKeyFieldId: input.external_key_field_id,
        schedule,
        recurrence: recurrence ?? null,
        status: 'active',
        cursor: {},
        createdBy: actorId,
      })
      .returning();
    return this.present(row!);
  }

  /** #280 — newest_wins needs a comparable external timestamp; a provider
   * that never declared one must refuse it rather than silently comparing
   * incomparable clocks. */
  private assertConflictPolicySupported(descriptor: SourceProviderDescriptor, policy: SourceConflictPolicy): void {
    if (policy === 'newest_wins' && !descriptor.supportsNewestWins?.()) {
      throw new UnprocessableEntityException(
        `"${descriptor.id}" has no comparable external timestamp — newest_wins is not available for this provider`,
      );
    }
  }

  private async requireConnectionForProvider(
    workspaceId: string,
    connectionId: string,
    descriptor: SourceProviderDescriptor,
  ) {
    const { provider } = await this.connectionsService.getDecryptedAuth(workspaceId, connectionId).catch(() => {
      throw new NotFoundException('Connection not found');
    });
    if (provider !== descriptor.connectionProvider) {
      throw new BadRequestException(
        `"${descriptor.id}" needs a "${descriptor.connectionProvider}" connection, not "${provider}"`,
      );
    }
    return { id: connectionId };
  }

  private async requireRow(databaseId: string, id: string): Promise<SourceRow> {
    const row = await this.db.query.sources.findFirst({
      where: and(eq(sources.id, id), eq(sources.targetDatabaseId, databaseId)),
    });
    if (!row) throw new NotFoundException('Source not found');
    return row;
  }

  async update(
    databaseId: string,
    id: string,
    input: Partial<{
      name: string;
      connection_id: string;
      config: Record<string, unknown>;
      field_mapping: SourceFieldMapping;
      external_key_field_id: string;
      schedule: string;
      recurrence: SourceRecurrence;
      status: string;
    }>,
  ) {
    const row = await this.requireRow(databaseId, id);
    const descriptor = this.requireProvider(row.providerSource);
    // #279/#280 — a caller editing ordinary provider config (the only shape
    // today's UI sends) carries the existing write_back/conflict_policy
    // settings forward untouched, rather than silently resetting them the
    // moment anything else about the config changes — the same "wholesale
    // replace wipes a framework-owned key" trap #264 hit on views.config,
    // applied here before it could repeat. Each key is carried forward
    // independently: the caller may explicitly change one without mentioning
    // the other.
    const existing = row.config as Record<string, unknown>;
    const existingWriteBack = existing?.[WRITE_BACK_CONFIG_KEY] === true;
    const existingPolicyParsed = sourceConflictPolicySchema.safeParse(existing?.[CONFLICT_POLICY_CONFIG_KEY]);
    const existingPolicy = existingPolicyParsed.success ? existingPolicyParsed.data : DEFAULT_CONFLICT_POLICY;
    const nextConfig = input.config
      ? {
          ...input.config,
          [WRITE_BACK_CONFIG_KEY]: Object.prototype.hasOwnProperty.call(input.config, WRITE_BACK_CONFIG_KEY)
            ? input.config[WRITE_BACK_CONFIG_KEY] === true
            : existingWriteBack,
          [CONFLICT_POLICY_CONFIG_KEY]: Object.prototype.hasOwnProperty.call(input.config, CONFLICT_POLICY_CONFIG_KEY)
            ? (sourceConflictPolicySchema.safeParse(input.config[CONFLICT_POLICY_CONFIG_KEY]).success
                ? input.config[CONFLICT_POLICY_CONFIG_KEY]
                : existingPolicy)
            : existingPolicy,
        }
      : existing;
    if (input.config) {
      const { providerConfig, conflictPolicy } = splitReservedConfig(nextConfig);
      const parsed = descriptor.configSchema.safeParse(providerConfig);
      if (!parsed.success) throw new BadRequestException(`Invalid config for "${descriptor.id}": ${parsed.error.message}`);
      this.assertConflictPolicySupported(descriptor, conflictPolicy);
    }
    const nextMapping = input.field_mapping ?? (row.fieldMapping as SourceFieldMapping);
    const nextKeyFieldId = input.external_key_field_id ?? row.externalKeyFieldId;
    if (!mappedFieldIds(nextMapping).includes(nextKeyFieldId)) {
      throw new BadRequestException('external_key_field_id must be one of field_mapping\'s target fields');
    }
    if (input.connection_id) {
      await this.requireConnectionForProvider(row.workspaceId, input.connection_id, descriptor);
    }

    // #340 — a new recurrence also refreshes the coarse `schedule` shadow;
    // switching back to a legacy `schedule` clears the recurrence so scheduling
    // reverts to the interval path.
    const nextRecurrence: SourceRecurrence | null = input.recurrence
      ? input.recurrence
      : input.schedule
        ? null
        : (row.recurrence as SourceRecurrence | null);
    const nextSchedule = input.recurrence
      ? scheduleFromRecurrence(input.recurrence)
      : (input.schedule ?? row.schedule);

    const [updated] = await this.db
      .update(sources)
      .set({
        name: input.name ?? row.name,
        connectionId: input.connection_id ?? row.connectionId,
        config: nextConfig,
        fieldMapping: nextMapping,
        externalKeyFieldId: nextKeyFieldId,
        schedule: nextSchedule,
        recurrence: nextRecurrence,
        status: input.status ?? row.status,
      })
      .where(eq(sources.id, id))
      .returning();
    return this.present(updated!);
  }

  /** Deleting a source stops syncing but leaves every record it created intact. */
  async remove(databaseId: string, id: string) {
    const deleted = await this.db
      .delete(sources)
      .where(and(eq(sources.id, id), eq(sources.targetDatabaseId, databaseId)))
      .returning({ id: sources.id });
    if (deleted.length === 0) throw new NotFoundException('Source not found');
    return { deleted: true };
  }

  async runs(databaseId: string, id: string, limit = 50) {
    await this.requireRow(databaseId, id);
    const rows = await this.db.query.sourceRuns.findMany({
      where: eq(sourceRuns.sourceId, id),
      orderBy: [desc(sourceRuns.startedAt)],
      limit: Math.min(Math.max(limit, 1), 200),
    });
    return { data: rows.map((r) => this.presentRun(r)) };
  }

  private presentRun(row: typeof sourceRuns.$inferSelect) {
    return {
      id: row.id,
      source_id: row.sourceId,
      status: row.status,
      fetched: row.fetched,
      created: row.created,
      updated: row.updated,
      error: row.error,
      started_at: row.startedAt.toISOString(),
      finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
      stats: (row.stats as Record<string, unknown> | null) ?? null,
    };
  }

  /** Manual "Sync now" — runs immediately, ignoring the schedule gate. */
  async syncNow(databaseId: string, id: string) {
    const row = await this.requireRow(databaseId, id);
    const run = await this.runOne(row);
    return this.presentRun(run);
  }

  // ── scheduler ────────────────────────────────────────────────────────────

  /** One scheduler pass — public so tests can invoke it directly. */
  async tick(): Promise<void> {
    const now = new Date();
    const candidates = await this.db.query.sources.findMany({
      where: and(
        eq(sources.status, 'active'),
        or(
          isNull(sources.lastSyncAt),
          // #340 — for a recurrence source this is a cheap SUPERSET filter (a
          // source can never be due before its minimum inter-slot gap has
          // elapsed); `isRecurrenceDue` below makes the exact wall-clock
          // decision in JS. Legacy sources (recurrence NULL) keep the precise
          // interval CASE they always had.
          sql`CASE
            WHEN ${sources.recurrence} IS NOT NULL THEN
              ${sources.lastSyncAt} + (CASE ${sources.recurrence}->>'kind'
                WHEN 'hourly' THEN interval '59 minutes'
                WHEN 'weekly' THEN interval '6 days'
                ELSE interval '23 hours' END) <= now()
            ELSE
              ${sources.lastSyncAt} + (CASE ${sources.schedule}
                WHEN '15m' THEN interval '15 minutes'
                WHEN 'hour' THEN interval '1 hour'
                ELSE interval '1 day' END) <= now()
          END`,
        ),
      ),
      limit: 20,
    });
    // Precise wall-clock gate for recurrence sources; legacy sources are
    // already precisely filtered by the interval CASE above.
    const due = candidates.filter((source) => {
      const recurrence = source.recurrence as SourceRecurrence | null;
      return !recurrence || isRecurrenceDue(recurrence, source.lastSyncAt, now);
    });
    for (const source of due) {
      const lockResult = (await this.db.execute(
        sql`SELECT pg_try_advisory_lock(hashtext(${source.id})) AS locked`,
      )) as unknown as { rows?: Array<{ locked: boolean }> };
      if (!lockResult.rows?.[0]?.locked) continue;
      try {
        await this.runOne(source);
      } catch (error) {
        this.logger.warn(`source ${source.id} tick failed: ${String(error)}`);
      } finally {
        await this.db.execute(sql`SELECT pg_advisory_unlock(hashtext(${source.id}))`);
      }
    }
  }

  /**
   * Flips a source to 'error' and notifies its creator when its connection is
   * gone — reached both when the FK's ON DELETE SET NULL already nulled
   * `connectionId` (the common case — Postgres does this synchronously on
   * ConnectionsService.remove()) and, belt-and-suspenders, if a decrypt/
   * lookup against a still-set id ever fails for some other reason. Same
   * notification shape as ConnectionsService.flagExpired's own recipient.
   */
  private async flagConnectionGone(source: SourceRow, startedAt: Date) {
    await this.db.update(sources).set({ status: 'error' }).where(eq(sources.id, source.id));
    if (source.createdBy) {
      await this.notifications
        .notify({
          workspaceId: source.workspaceId,
          actorId: source.createdBy,
          type: 'connection_error',
          recipients: [source.createdBy],
          snippet: `Source "${source.name}" needs a connection reconnected`,
          allowSelf: true,
        })
        .catch(() => undefined);
    }
    return this.finishRun(source, startedAt, 'error', 'Connection was deleted', { fetched: 0, created: 0, updated: 0 });
  }

  /** Runs one sync cycle for a source, end to end, and returns the run row. */
  private async runOne(source: SourceRow): Promise<typeof sourceRuns.$inferSelect> {
    const startedAt = new Date();

    if (!source.connectionId) {
      return this.flagConnectionGone(source, startedAt);
    }

    let auth: unknown;
    let connectionProvider: string;
    try {
      const decrypted = await this.connectionsService.getDecryptedAuth(source.workspaceId, source.connectionId);
      auth = decrypted.auth;
      connectionProvider = decrypted.provider;
    } catch {
      return this.flagConnectionGone(source, startedAt);
    }

    const descriptor = SOURCE_PROVIDER_REGISTRY.get(source.providerSource);
    if (!descriptor) {
      return this.finishRun(source, startedAt, 'error', `Unknown provider "${source.providerSource}"`, {
        fetched: 0,
        created: 0,
        updated: 0,
      });
    }

    const capSkip = await this.checkMonthlyCap(source, startedAt);
    if (capSkip) return capSkip;

    const budgetFor = QUOTA_BUDGET_BY_CONNECTION_PROVIDER[connectionProvider];
    if (budgetFor) {
      const estimate = descriptor.estimateQuotaUnits?.(source.config as Record<string, unknown>) ?? 1;
      const allowed = await this.connectionsService.checkAndConsumeQuota(source.connectionId, estimate, budgetFor());
      if (!allowed) {
        return this.finishRun(source, startedAt, 'skipped_quota', null, { fetched: 0, created: 0, updated: 0 });
      }
    }

    const defs = await this.recordsService.fieldDefs(source.targetDatabaseId);
    const apiNameByFieldId = new Map(defs.map((d) => [d.id, d.api_name]));
    const fieldMapping = source.fieldMapping as SourceFieldMapping;
    const stats = { fetched: 0, created: 0, updated: 0 };
    const actorId = source.createdBy ?? 'source-sync';

    const ctx: SourceSyncContext = {
      auth,
      config: source.config as Record<string, unknown>,
      cursor: source.cursor as Record<string, unknown>,
      since: source.lastSyncAt ?? undefined,
      fetcher: this.fetcher,
      emit: async (items) => {
        stats.fetched += items.length;
        await this.upsertBatch(
          source.workspaceId,
          source.targetDatabaseId,
          fieldMapping,
          source.externalKeyFieldId,
          apiNameByFieldId,
          actorId,
          items,
          stats,
        );
      },
      lookupSourceKeys: (otherSourceId) => this.lookupSourceKeys(source.workspaceId, otherSourceId),
    };

    try {
      const result = await descriptor.sync(ctx);
      await this.db
        .update(sources)
        .set({ lastSyncAt: new Date(), cursor: result.cursor })
        .where(eq(sources.id, source.id));
      return this.finishRun(source, startedAt, 'ok', null, stats, result.stats);
    } catch (error) {
      const message = (error as Error).message?.slice(0, 500) ?? 'sync failed';
      if (error instanceof SourceSyncError && error.cursor) {
        await this.db.update(sources).set({ cursor: error.cursor }).where(eq(sources.id, source.id));
      }
      return this.finishRun(source, startedAt, 'error', message, stats);
    }
  }

  /**
   * MN-262 — a source-level monthly run cap (e.g. Apify's `monthly_run_cap`
   * config; opt-in per source, absent for every provider that doesn't set
   * one). Counts this calendar month's actually-attempted runs ('ok'/'error'
   * — a quota/cap skip never itself counts against the cap) against the
   * source; once at or over, returns a 'skipped_cap' run instead of letting
   * `runOne` call `descriptor.sync()`. Notifies the source's creator once per
   * month (tracked in `cursor.cap_notified_month`, not a new column) rather
   * than once per scheduler tick.
   */
  private async checkMonthlyCap(
    source: SourceRow,
    startedAt: Date,
  ): Promise<typeof sourceRuns.$inferSelect | null> {
    const cap = (source.config as Record<string, unknown>)['monthly_run_cap'];
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) return null;

    const monthStart = new Date(Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), 1));
    const monthKey = monthStart.toISOString().slice(0, 7);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceRuns)
      .where(
        and(
          eq(sourceRuns.sourceId, source.id),
          gte(sourceRuns.startedAt, monthStart),
          inArray(sourceRuns.status, ['ok', 'error']),
        ),
      );
    if ((row?.count ?? 0) < cap) return null;

    const cursor = (source.cursor as Record<string, unknown>) ?? {};
    if (cursor['cap_notified_month'] !== monthKey) {
      await this.db
        .update(sources)
        .set({ cursor: { ...cursor, cap_notified_month: monthKey } })
        .where(eq(sources.id, source.id));
      if (source.createdBy) {
        await this.notifications
          .notify({
            workspaceId: source.workspaceId,
            actorId: source.createdBy,
            type: 'source_run_cap_reached',
            recipients: [source.createdBy],
            snippet: `Source "${source.name}" hit its monthly run cap (${cap}) — syncing is paused until next month`,
            allowSelf: true,
          })
          .catch(() => undefined);
      }
    }
    return this.finishRun(source, startedAt, 'skipped_cap', null, { fetched: 0, created: 0, updated: 0 });
  }

  private async finishRun(
    source: SourceRow,
    startedAt: Date,
    status: string,
    error: string | null,
    stats: { fetched: number; created: number; updated: number },
    providerStats?: Record<string, unknown>,
  ) {
    const [row] = await this.db
      .insert(sourceRuns)
      .values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt,
        finishedAt: new Date(),
        status,
        fetched: stats.fetched,
        created: stats.created,
        updated: stats.updated,
        error,
        stats: providerStats ?? null,
      })
      .returning();
    return row!;
  }

  /** External-key values already stored by another source's target database
   * (#239 — youtube.metrics pairing with a youtube.videos source). */
  private async lookupSourceKeys(workspaceId: string, otherSourceId: string): Promise<string[]> {
    const other = await this.db.query.sources.findFirst({
      where: and(eq(sources.id, otherSourceId), eq(sources.workspaceId, workspaceId)),
    });
    if (!other) return [];
    const rows = await this.db
      .select({ extVal: sql<string | null>`(${records.values}->>${other.externalKeyFieldId})` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, other.targetDatabaseId),
          isNull(records.deletedAt),
          sql`(${records.values} ? ${other.externalKeyFieldId})`,
        ),
      );
    return rows.map((r) => r.extVal).filter((v): v is string => Boolean(v));
  }

  /**
   * #24 — the webhook ingress reuse point. A verified inbound webhook
   * (integrations/shopify-webhook.controller.ts) upserts through the SAME
   * idempotent, GID-keyed engine the scheduler drives (`upsertBatch`), so a
   * real-time push and a scheduled tick for the same object converge to one
   * record instead of forking a second write path.
   *
   * Routes to the source(s) for `providerSource` attached to `connectionId` in
   * this workspace (a connection's own catalogue — not another store's), and
   * no-ops when none is attached (e.g. a product push carrying variants when no
   * `shopify.variants` source exists). `items` are already in the provider
   * mapper's emit shape. The subscriber that materializes relations fires off
   * the `record_created`/`record_updated` these writes emit, exactly as it does
   * for a scheduled sync. Returns aggregate {matched, created, updated}.
   */
  async ingestExternalItems(
    workspaceId: string,
    connectionId: string,
    providerSource: string,
    items: Array<Record<string, unknown>>,
  ): Promise<{ matched: boolean; created: number; updated: number }> {
    if (items.length === 0) return { matched: false, created: 0, updated: 0 };
    const rows = await this.db.query.sources.findMany({
      where: and(
        eq(sources.workspaceId, workspaceId),
        eq(sources.connectionId, connectionId),
        eq(sources.providerSource, providerSource),
      ),
    });
    if (rows.length === 0) return { matched: false, created: 0, updated: 0 };

    const stats = { created: 0, updated: 0 };
    for (const source of rows) {
      const defs = await this.recordsService.fieldDefs(source.targetDatabaseId);
      const apiNameByFieldId = new Map(defs.map((d) => [d.id, d.api_name]));
      await this.upsertBatch(
        source.workspaceId,
        source.targetDatabaseId,
        source.fieldMapping as SourceFieldMapping,
        source.externalKeyFieldId,
        apiNameByFieldId,
        source.createdBy ?? 'shopify-webhook',
        items,
        stats,
      );
    }
    return { matched: true, ...stats };
  }

  /**
   * The upsert engine (#239's correctness invariant): looks up existing
   * records by the external key, then CREATEs new ones or UPDATEs only the
   * mapped field_ids — never anything else. RecordsService.update() already
   * merges onto the existing `values` object (records.service.ts), so simply
   * never including an unmapped api_name in `input` is sufficient: a field a
   * human or agent wrote that has no counterpart in fieldMapping is never
   * touched, on this sync or any later one.
   *
   * #280 — direction is an ADDITIONAL restriction on top of that guarantee,
   * never a widening: a field mapped `out` is skipped here exactly like an
   * unmapped one, so a pull can never write it. A field mapped `in` or `both`
   * (or a legacy bare-uuid entry, which normalizeFieldMapping treats as `in`)
   * behaves exactly as every field did before this ticket.
   */
  private async upsertBatch(
    workspaceId: string,
    targetDatabaseId: string,
    fieldMapping: SourceFieldMapping,
    externalKeyFieldId: string,
    apiNameByFieldId: Map<string, string>,
    actorId: string,
    items: Array<Record<string, unknown>>,
    stats: { created: number; updated: number },
  ): Promise<void> {
    if (items.length === 0) return;
    const normalized = normalizeFieldMapping(fieldMapping);
    const pullable = Object.fromEntries(
      Object.entries(normalized).filter(([, entry]) => entry.direction === 'in' || entry.direction === 'both'),
    );
    const externalKeyExternalName = Object.entries(normalized).find(([, entry]) => entry.fieldId === externalKeyFieldId)?.[0];
    if (!externalKeyExternalName) return;

    const externalValues = items
      .map((item) => item[externalKeyExternalName])
      .filter((v): v is string | number => v !== undefined && v !== null)
      .map((v) => String(v));
    if (externalValues.length === 0) return;

    // `IN (...)`, not `= ANY($1::text[])` — an array bound through drizzle's
    // `sql` tag expands to one placeholder PER ELEMENT (not a single array
    // parameter), the same reason query-compiler.ts's compileIdSet builds its
    // id lists this way (sql.join + IN) rather than casting a bound array.
    const externalValuesList = sql.join(
      externalValues.map((v) => sql`${v}`),
      sql`, `,
    );
    const existingRows = await this.db
      .select({ id: records.id, extVal: sql<string | null>`(${records.values}->>${externalKeyFieldId})` })
      .from(records)
      .where(
        and(
          eq(records.databaseId, targetDatabaseId),
          isNull(records.deletedAt),
          sql`(${records.values}->>${externalKeyFieldId}) IN (${externalValuesList})`,
        ),
      );
    const existingByExtVal = new Map(existingRows.filter((r) => r.extVal !== null).map((r) => [r.extVal as string, r.id]));

    for (const item of items) {
      const rawExtVal = item[externalKeyExternalName];
      if (rawExtVal === undefined || rawExtVal === null) continue;
      const extVal = String(rawExtVal);

      const input: Record<string, unknown> = {};
      for (const [externalKey, entry] of Object.entries(pullable)) {
        if (item[externalKey] === undefined) continue;
        const apiName = apiNameByFieldId.get(entry.fieldId);
        if (!apiName) continue; // field mapping pointed at a field that no longer exists
        input[apiName] = item[externalKey];
      }
      if (Object.keys(input).length === 0) continue;

      const existingId = existingByExtVal.get(extVal);
      // #481 — an external-source sync run, never a person typing.
      if (existingId) {
        await this.recordsService.update(workspaceId, targetDatabaseId, existingId, input, actorId, 1, 'automation');
        stats.updated += 1;
      } else {
        const created = await this.recordsService.create(workspaceId, targetDatabaseId, input, actorId, 1, 'automation');
        existingByExtVal.set(extVal, created.id);
        stats.created += 1;
      }
    }
  }
}

/** Best-effort ZodObject → plain-JSON form spec, for the web dialog's generic
 * config-form renderer (GET .../sources/providers). Loose by design — every
 * provider's configSchema here is a flat object of optional strings/arrays. */
type ZodIntrospectable = { description?: string; isOptional?: () => boolean; _def?: { type?: string; innerType?: ZodIntrospectable } };

/** Unwraps ZodDefault/ZodOptional wrappers to the underlying base type, e.g.
 * `z.boolean().default(false)` → the `z.boolean()` inside — so `kindOf` sees
 * "boolean", not the wrapper's own def. */
function unwrapZodType(field: ZodIntrospectable): ZodIntrospectable {
  let cur = field;
  while (cur?._def?.innerType) cur = cur._def.innerType;
  return cur;
}

/** Best-effort "what kind of input does this need" for the web dialog's
 * generic config-form renderer — MN-262's `input` (record) and `include_raw`
 * (boolean) are the first fields needing anything other than a plain text
 * box. Loose by design, same spirit as the rest of this function. */
function kindOfZodType(field: ZodIntrospectable): 'string' | 'number' | 'boolean' | 'array' | 'json' {
  const base = unwrapZodType(field)?._def?.type;
  if (base === 'boolean') return 'boolean';
  if (base === 'number') return 'number';
  if (base === 'array') return 'array';
  if (base === 'record' || base === 'object') return 'json';
  return 'string';
}

function zodShapeToFormSpec(schema: { shape?: Record<string, unknown> }): Record<string, unknown> {
  const shape = (schema as { shape: Record<string, ZodIntrospectable> }).shape ?? {};
  const spec: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(shape)) {
    spec[key] = {
      description: field?.description ?? null,
      required: field?.isOptional ? !field.isOptional() : true,
      kind: kindOfZodType(field),
    };
  }
  return spec;
}
