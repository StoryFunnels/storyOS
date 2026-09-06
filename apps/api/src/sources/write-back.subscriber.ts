import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { SourceFieldMapping } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, sourceRuns, sources } from '../db/schema';
import { ConnectionsService } from '../connections/connections.service';
import { defaultConnectionFetcher } from '../connections/providers/types';
import type { ConnectionFetcher } from '../connections/providers/types';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { RecordsService } from '../records/records.service';
import { ApprovalsService } from '../automations/approvals.service';
import type { WriteBackPushAction } from '../automations/approvals.service';
import { JobRunnerService } from '../automations/job-runner.service';
import type { JobHelpers } from '../automations/job-runner.service';
import { normalizeFieldMapping } from './field-mapping';
import { SOURCE_PROVIDER_REGISTRY } from './providers';

/**
 * #282 — "carry the existing automation depth guard's idea into the sync
 * path and cap it": a push triggered by a pull that was itself triggered by
 * a push must not ping-pong. `sources.service.ts`'s `upsertBatch()` already
 * calls `recordsService.update(..., 1, 'automation')` for every ingested
 * write, so a pull-caused `record_updated` arrives here at depth 1, not 0 —
 * same MAX_DEPTH=2 convention automations.service.ts uses, so one push→pull
 * round trip is still allowed but a second is refused and logged.
 */
const WRITE_BACK_MAX_DEPTH = 2;

/**
 * #279/#281 (write-back) — a record owned by a `write_back`-enabled source
 * got edited. Pushes every `out`/`both`-mapped field that ACTUALLY CHANGED
 * this write back through the provider's `push()`, re-keyed from the
 * record's field ids to the provider's own external-key vocabulary — the
 * mirror image of `upsertBatch()`'s pull-side translation, so a provider's
 * `push()` never needs to know a StoryOS field id or api_name exists.
 *
 * `write_back` defaulting off (#279) plus requiring `descriptor.push` to
 * exist together mean no outbound call is EVER made unless a source opted in
 * AND its provider implements push — #279 shipped this subscriber before any
 * provider did, logging intent only; #281 (Shopify products) is the first to
 * make it real.
 *
 * Mirrors RollupInvalidationSubscriber/ShopifyCatalogueSubscriber's shape:
 * subscribe in onModuleInit, fire-and-forget with its own try/catch so one
 * source's failure never touches the record write that triggered it. Each
 * source's push is ALSO wrapped in its OWN try/catch (not just the outer
 * one) so a provider rejection lands as its own errored `source_runs` row
 * naming the provider's error — never a swallowed log line — while the
 * StoryOS-side edit that triggered it is left exactly as the user made it:
 * nothing here ever touches the record, so there is nothing to roll back.
 */
@Injectable()
export class WriteBackSubscriber implements OnModuleInit {
  private readonly logger = new Logger(WriteBackSubscriber.name);

  /** Swappable in tests, same seam as SourcesService/ConnectionsService.fetcher. */
  fetcher: ConnectionFetcher = defaultConnectionFetcher;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly domainEvents: DomainEventsService,
    private readonly connectionsService: ConnectionsService,
    private readonly recordsService: RecordsService,
    private readonly approvalsService: ApprovalsService,
    private readonly jobs: JobRunnerService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
    // #282 — approved-via-gate pushes execute through the SAME job runner
    // every automation action does, for free retry/backoff/breaker handling
    // (job-runner.service.ts) rather than a second retry mechanism.
    this.jobs.registerExecutor('write_back_push', (payload, helpers) => this.executeApprovedPush(payload, helpers));
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_updated') return;
    void this.pushChanges(event).catch((err: unknown) => {
      this.logger.warn(
        `write-back push failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async pushChanges(event: DomainEvent): Promise<void> {
    const changedFieldIds = new Set(event.changedFieldIds ?? []);
    if (changedFieldIds.size === 0) return;

    const candidates = await this.db.query.sources.findMany({
      where: eq(sources.targetDatabaseId, event.databaseId),
    });
    if (candidates.length === 0) return;

    // Fetched once, lazily, only once some candidate might actually push —
    // most record_updated events touch no write-back source at all.
    let record: { values: unknown } | undefined;

    for (const source of candidates) {
      const config = (source.config ?? {}) as { write_back?: boolean; require_approval_for_push?: boolean };
      if (config.write_back !== true) continue;

      const descriptor = SOURCE_PROVIDER_REGISTRY.get(source.providerSource);
      if (!descriptor?.push || !source.connectionId) continue;

      const mapping = normalizeFieldMapping(source.fieldMapping as SourceFieldMapping);
      const pushable = Object.entries(mapping).filter(
        ([, entry]) => (entry.direction === 'out' || entry.direction === 'both') && changedFieldIds.has(entry.fieldId),
      );
      // Nothing pushable actually changed this write (an `in`-mapped field
      // edit, or a field this source doesn't map at all) — no outbound call.
      if (pushable.length === 0) continue;

      record ??= await this.db.query.records.findFirst({
        where: and(eq(records.id, event.recordId), eq(records.databaseId, event.databaseId)),
        columns: { values: true },
      });
      const recordValues = (record?.values ?? {}) as Record<string, unknown>;
      const externalKey = recordValues[source.externalKeyFieldId];
      // Not owned by this source (no external key on it yet) — nothing to push to.
      if (externalKey === undefined || externalKey === null || externalKey === '') continue;

      const values: Record<string, unknown> = {};
      for (const [externalKeyName, entry] of pushable) {
        values[externalKeyName] = event.changedValues?.[entry.fieldId]?.to ?? recordValues[entry.fieldId];
      }

      // #282 AC — ping-pong guard, checked per-candidate (not at the top of
      // the function) so a source that WOULD have pushed still gets its own
      // audit row naming the cap, rather than a silent early return.
      if (event.depth >= WRITE_BACK_MAX_DEPTH) {
        await this.db.insert(sourceRuns).values({
          sourceId: source.id,
          workspaceId: source.workspaceId,
          startedAt: new Date(),
          finishedAt: new Date(),
          status: 'skipped_depth',
          error: `depth cap (${WRITE_BACK_MAX_DEPTH}) reached at depth ${event.depth} — refusing to push to avoid a pull/push loop`,
          stats: { pushed: false, external_key: externalKey, pushed_keys: Object.keys(values), depth: event.depth, max_depth: WRITE_BACK_MAX_DEPTH },
        });
        continue;
      }

      if (config.require_approval_for_push === true) {
        await this.holdForApproval(source, event, pushable, recordValues, String(externalKey), values);
        continue;
      }

      await this.pushOne(source, event.recordId, externalKey, values);
    }
  }

  /**
   * #282 — the source opted into `require_approval_for_push`: reuse the
   * SAME approvals machinery MN-255 built for automation actions
   * (approvals.service.ts), never a second gate. The before→after preview
   * text is `renderChangeSummary()` — its third caller (comments.service.ts
   * and automations.service.ts's notify path are the other two), the same
   * reuse-not-reinvent direction of travel #282's own grooming notes call out.
   */
  private async holdForApproval(
    source: typeof sources.$inferSelect,
    event: DomainEvent,
    pushable: Array<[string, { fieldId: string }]>,
    recordValues: Record<string, unknown>,
    externalKey: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const changedValuesByFieldId = Object.fromEntries(
      pushable.map(([, entry]) => [
        entry.fieldId,
        { from: event.changedValues?.[entry.fieldId]?.from, to: event.changedValues?.[entry.fieldId]?.to ?? recordValues[entry.fieldId] },
      ]),
    );
    const summary = await this.recordsService.renderChangeSummary(event.databaseId, changedValuesByFieldId);
    const previewText = `Push to ${source.providerSource} (${source.name}): ${summary || 'field values changed'}`;

    const action: WriteBackPushAction = { type: 'write_back_push', source_id: source.id, external_key: externalKey, values };
    await this.approvalsService.create({
      workspaceId: source.workspaceId,
      databaseId: event.databaseId,
      ruleId: null,
      runId: null,
      recordId: event.recordId,
      actionIndex: 0,
      action,
      previewText,
      requesterActorId: event.actorId ?? source.createdBy ?? 'system',
    });

    await this.db.insert(sourceRuns).values({
      sourceId: source.id,
      workspaceId: source.workspaceId,
      startedAt: new Date(),
      finishedAt: new Date(),
      status: 'pending_approval',
      stats: { pushed: false, external_key: externalKey, pushed_keys: Object.keys(values), diff: changedValuesByFieldId },
    });
  }

  /** #282 — the JobRunnerService executor for an APPROVED write_back_push. */
  private async executeApprovedPush(payload: Record<string, unknown>, helpers: JobHelpers): Promise<unknown> {
    const action = (payload as { action: WriteBackPushAction }).action;
    const source = await this.db.query.sources.findFirst({ where: eq(sources.id, action.source_id) });
    if (!source) throw new Error(`write-back source ${action.source_id} no longer exists`);
    const descriptor = SOURCE_PROVIDER_REGISTRY.get(source.providerSource);
    if (!descriptor?.push || !source.connectionId) {
      throw new Error(`source ${source.id} can no longer push (provider/connection changed since approval)`);
    }

    const startedAt = new Date();
    const baseStats = { pushed: true, external_key: action.external_key, pushed_keys: Object.keys(action.values), approved: true };
    try {
      const { auth } = await helpers.connectionAuth(source.connectionId);
      const result = await descriptor.push!({
        auth,
        config: (source.config ?? {}) as Record<string, unknown>,
        fetcher: this.fetcher,
        externalKey: action.external_key,
        values: action.values,
      });
      await this.db.insert(sourceRuns).values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt,
        finishedAt: new Date(),
        status: 'ok',
        stats: { ...baseStats, ...result.stats },
      });
      return result;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.db.insert(sourceRuns).values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt,
        finishedAt: new Date(),
        status: 'error',
        error: message,
        stats: baseStats,
      });
      throw err;
    }
  }

  private async pushOne(
    source: typeof sources.$inferSelect,
    recordId: string,
    externalKey: unknown,
    values: Record<string, unknown>,
  ): Promise<void> {
    const descriptor = SOURCE_PROVIDER_REGISTRY.get(source.providerSource)!;
    const startedAt = new Date();
    const baseStats = { pushed: true, record_id: recordId, external_key: externalKey, pushed_keys: Object.keys(values) };
    try {
      const { auth } = await this.connectionsService.getDecryptedAuth(source.workspaceId, source.connectionId!);
      const result = await descriptor.push!({
        auth,
        config: (source.config ?? {}) as Record<string, unknown>,
        fetcher: this.fetcher,
        externalKey: String(externalKey),
        values,
      });
      await this.db.insert(sourceRuns).values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt,
        finishedAt: new Date(),
        status: 'ok',
        stats: { ...baseStats, ...result.stats },
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await this.db.insert(sourceRuns).values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt,
        finishedAt: new Date(),
        status: 'error',
        error: message,
        stats: baseStats,
      });
    }
  }
}
