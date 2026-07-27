import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { ShopifyCatalogueService } from './shopify-catalogue.service';

/**
 * #110 — materialize Shopify product↔variant and product↔collection relations
 * as records sync in. Subscribes to the after-commit event bus (exactly like
 * relations/auto-link.subscriber.ts) and, when a record in a Shopify catalogue
 * database is created or updated, resolves its stored GID foreign keys to
 * product records and writes the `record_links`.
 *
 * Best-effort by design: a failure here never breaks the write that triggered
 * it. The materializer's own link writes emit `record_linked` (via
 * RelationsService.replaceLinks), never `record_created`/`record_updated`, so
 * this subscriber — which only reacts to the latter two — never loops back on
 * its own output.
 */
@Injectable()
export class ShopifyCatalogueSubscriber implements OnModuleInit {
  private readonly logger = new Logger('ShopifyCatalogue');

  constructor(
    private readonly catalogue: ShopifyCatalogueService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_created' && event.type !== 'record_updated') return;
    void this.catalogue
      .materializeForRecord(
        event.workspaceId,
        event.databaseId,
        event.recordId,
        event.actorId ?? 'shopify-catalogue',
      )
      .catch((err: unknown) =>
        this.logger.warn(
          `link materialization failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
}
