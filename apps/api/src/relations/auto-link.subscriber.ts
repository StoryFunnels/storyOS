import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { AutoLinkService } from './auto-link.service';

/**
 * On-write auto-link (MN-085). Subscribes to the after-commit event bus and, when a
 * record is created or updated, applies any auto-link rules its database participates
 * in — so links appear as the data changes, not only when someone clicks "Run now".
 *
 * Best-effort by design: a failure here never breaks the write that triggered it
 * (the bus already isolates listeners; we also swallow + log). Auto-link creates
 * record_links but emits no domain event, so there is no cascade to guard against.
 */
@Injectable()
export class AutoLinkSubscriber implements OnModuleInit {
  private readonly logger = new Logger('AutoLink');

  constructor(
    private readonly autoLink: AutoLinkService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_created' && event.type !== 'record_updated') return;
    void this.autoLink
      .autoLinkForRecord(event.databaseId, event.recordId, event.changedFieldIds, event.actorId)
      .catch((err: unknown) =>
        this.logger.warn(
          `auto-link failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
}
