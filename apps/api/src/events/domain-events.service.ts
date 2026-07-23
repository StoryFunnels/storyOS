import { Injectable } from '@nestjs/common';

export interface DomainEvent {
  type: 'record_created' | 'record_updated' | 'record_linked' | 'record_deleted';
  workspaceId: string;
  databaseId: string;
  recordId: string;
  changedFieldIds?: string[];
  relationFieldId?: string;
  /**
   * MN-267: precise before∪after other-side target ids for every relation
   * field this write touched — captured by RecordsService.writeLinks() AT
   * WRITE TIME (before the delete-then-insert replace), never reconstructed
   * from record_links after the fact, so an unlink is never missed. Lets
   * RollupInvalidationSubscriber recompute both this record's own rollup
   * through the field that changed and the affected other-side records'
   * rollup through the relation's reverse field.
   */
  linkedRelations?: Array<{
    relationId: string;
    fieldId: string;
    otherDatabaseId: string;
    otherRecordIds: string[];
  }>;
  /** null for anonymous public-form submissions (MN-101). */
  actorId: string | null;
  depth: number;
}

type Listener = (event: DomainEvent) => void;

/** In-process after-commit event bus (MN-047). Single-node v1 by design. */
@Injectable()
export class DomainEventsService {
  private listeners: Listener[] = [];

  subscribe(listener: Listener): void {
    this.listeners.push(listener);
  }

  emit(event: DomainEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listeners are isolated — a bad subscriber never breaks the write path
      }
    }
  }
}
