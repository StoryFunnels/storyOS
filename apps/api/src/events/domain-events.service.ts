import { Injectable } from '@nestjs/common';

export interface DomainEvent {
  type: 'record_created' | 'record_updated' | 'record_linked';
  workspaceId: string;
  databaseId: string;
  recordId: string;
  changedFieldIds?: string[];
  relationFieldId?: string;
  actorId: string;
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
