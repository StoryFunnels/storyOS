import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { records, sourceRuns, sources } from '../db/schema';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { SOURCE_PROVIDER_REGISTRY } from './providers';

/**
 * #279 (write-back, slice A) — a record owned by a `write_back`-enabled
 * source got edited. This does NOT push anything yet: it logs what WOULD be
 * pushed to `source_runs`, so real traffic shape can be watched before slice
 * B/C/D turn the write side on for real. `descriptor.push` existing is not
 * enough on its own — the gate is `write_back` in the source's own config,
 * defaulting off, exactly like every other opt-in mutation in this codebase.
 *
 * Mirrors RollupInvalidationSubscriber/ShopifyCatalogueSubscriber's shape:
 * subscribe in onModuleInit, fire-and-forget with its own try/catch so one
 * source's lookup failure never touches the record write that triggered it.
 */
@Injectable()
export class WriteBackSubscriber implements OnModuleInit {
  private readonly logger = new Logger(WriteBackSubscriber.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_updated') return;
    void this.logIntendedPushes(event).catch((err: unknown) => {
      this.logger.warn(
        `write-back dry-run logging failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async logIntendedPushes(event: DomainEvent): Promise<void> {
    const candidates = await this.db.query.sources.findMany({
      where: eq(sources.targetDatabaseId, event.databaseId),
    });
    if (candidates.length === 0) return;

    let record: { values: unknown } | undefined;
    for (const source of candidates) {
      const config = (source.config ?? {}) as { write_back?: boolean };
      if (config.write_back !== true) continue;

      // A provider without push() never attempts one — supportsPush governs
      // this the same way it does listProviders()'s surfaced signal.
      const descriptor = SOURCE_PROVIDER_REGISTRY.get(source.providerSource);
      if (!descriptor?.push) continue;

      // Fetched once, lazily, only once something might actually log — most
      // record_updated events touch no write-back source at all.
      record ??= await this.db.query.records.findFirst({
        where: and(eq(records.id, event.recordId), eq(records.databaseId, event.databaseId)),
        columns: { values: true },
      });
      const values = (record?.values ?? {}) as Record<string, unknown>;
      const externalKey = values[source.externalKeyFieldId];
      // Not owned by this source (no external key on it yet) — nothing to push.
      if (externalKey === undefined || externalKey === null || externalKey === '') continue;

      await this.db.insert(sourceRuns).values({
        sourceId: source.id,
        workspaceId: source.workspaceId,
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'push_dry_run',
        stats: {
          would_push: true,
          record_id: event.recordId,
          external_key: externalKey,
          changed_field_ids: event.changedFieldIds ?? [],
        },
      });
    }
  }
}
