import { Injectable } from '@nestjs/common';

export interface DomainEvent {
  type: 'record_created' | 'record_updated' | 'record_linked' | 'record_deleted';
  workspaceId: string;
  databaseId: string;
  recordId: string;
  changedFieldIds?: string[];
  /**
   * #273 — the before/after values behind `changedFieldIds`, keyed by field id
   * (exactly RecordsService.update()'s own diff, passed through at no cost). Lets
   * a firing automation render the `{changesSummary}` token without re-reading a
   * pre-write state it can no longer see. Resolution to labels happens lazily,
   * only for a rule whose actions actually use the token.
   */
  changedValues?: Record<string, { from: unknown; to: unknown }>;
  /**
   * #132: this record's own title (the `records.title` column) changed. Kept
   * SEPARATE from `changedFieldIds` on purpose — the title has a field id, but
   * automations/auto-link key off `changedFieldIds` and must not newly fire on a
   * title edit. Only the cross-record-name cascade
   * (RecordsService.invalidateRollupsForChange) reads this, to recompute the
   * names of records that LOOK UP this record's title.
   */
  titleChanged?: boolean;
  relationFieldId?: string;
  /**
   * #324 — this `record_linked` event exists ONLY so automations see the link.
   * The derived-data cascade (rollups, cross-record names) already ran for the
   * same user action off the accompanying `record_updated`, which carries the
   * identical `linkedRelations`.
   *
   * Set when a relation is written INLINE on a record update. Without it,
   * RollupInvalidationSubscriber — which consumes both event types — would run
   * the whole fan-out twice for one edit. The flag is on the event rather than
   * inferred by the subscriber because only the emitter knows the pair was sent.
   */
  derivedAlreadyHandled?: boolean;
  /**
   * #270 — for a `record_linked` event, whether records were LINKED or UNLINKED
   * through `relationFieldId`. Lets a record_linked automation trigger fire on
   * only one direction. Undefined for a `replaceLinks` set-operation (mixed) and
   * for every non-relation event.
   */
  linkDirection?: 'link' | 'unlink';
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
