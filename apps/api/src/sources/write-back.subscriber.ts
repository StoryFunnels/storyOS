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
import { normalizeFieldMapping } from './field-mapping';
import { SOURCE_PROVIDER_REGISTRY } from './providers';

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
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
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
      const config = (source.config ?? {}) as { write_back?: boolean };
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

      await this.pushOne(source, event.recordId, externalKey, values);
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
