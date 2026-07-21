import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/domain-events.service';
import { RecordsService } from './records.service';

/**
 * MN-267: the reverse-lookup half of rollup materialization. Rollup depends
 * on OTHER records through a relation — attachRollups() (records.service.ts)
 * is read-time-only and stays correct for display regardless, but the
 * separate `computed_values` sort/cursor materialization (MN-260's column,
 * reused here rather than a second storage mechanism) needs something to
 * invalidate it when the CHANGE happens on a related record or a relation
 * edge, not the rollup-bearing record's own write. Nothing did that before
 * this (confirmed by the #267 spike: DomainEventsService had exactly three
 * subscribers, none touching rollup).
 *
 * Mirrors AutoLinkSubscriber's shape exactly: subscribes to the after-commit
 * event bus, fire-and-forgets the cascade (RecordsService.invalidateRollupsForChange
 * does its own internal chunking — recomputeRollupsForRelationField — so a
 * highly-connected relation's fan-out is bounded per round trip rather than a
 * synchronous block in the write path that triggered it), and never lets a
 * recompute failure surface on that write (bus isolation + local catch).
 *
 * Listens to all three event types on purpose: `record_created`/`record_updated`
 * carry `changedFieldIds` (a related record's own field changed) and/or
 * `linkedRelations` (a relation written inline via update()'s `values`);
 * `record_linked` — emitted by RelationsService's addLinks/replaceLinks/removeLinks
 * (MN-267; previously declared on DomainEvent but never fired by anything) —
 * carries only `linkedRelations`, for links written through the dedicated
 * Links API instead of inline.
 */
@Injectable()
export class RollupInvalidationSubscriber implements OnModuleInit {
  private readonly logger = new Logger('RollupInvalidation');

  constructor(
    private readonly recordsService: RecordsService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  onModuleInit(): void {
    this.domainEvents.subscribe((event) => this.handle(event));
  }

  private handle(event: DomainEvent): void {
    if (event.type !== 'record_created' && event.type !== 'record_updated' && event.type !== 'record_linked') return;
    if (!event.changedFieldIds?.length && !event.linkedRelations?.length) return;
    void this.recordsService
      .invalidateRollupsForChange({
        databaseId: event.databaseId,
        recordId: event.recordId,
        changedFieldIds: event.changedFieldIds,
        linkedRelations: event.linkedRelations,
      })
      .catch((err: unknown) =>
        this.logger.warn(
          `rollup invalidation failed for record ${event.recordId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }
}
