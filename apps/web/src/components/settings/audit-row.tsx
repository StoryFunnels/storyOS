import type { ReactNode } from 'react';
import { RelationChip } from '@/components/table-view/relation-chip';
import { describeAuditEvent } from '@/lib/audit-events';
import { describeFieldChange } from '@/lib/audit-values';
import { recordHref } from '@/lib/records';

/**
 * Ticket #1287 - the "what happened" cell of one audit row, split out of the page so it renders without a browser (a test reads its text).
 *
 * The API (PR 1535) resolves every name a row needs: `record` (number, title, database), `other_record` (the far side of a link),
 * `old_display` / `new_display` (option labels, people in words) and `actor_name`. This file only PLACES them. It never invents one:
 * a name the API did not send is left out or shown as a neutral phrase ("a record", a dash), never an id and never a guess. Record links render through the
 * shared RelationChip (table-view/relation-cell), not a copy of its styles.
 */
export interface AuditRecordRef {
  id: string;
  number: number | null;
  title: string | null;
  database_id: string | null;
  database_name: string | null;
  deleted: boolean;
  withheld: boolean;
}

export interface AuditLogEntry {
  kind: 'event' | 'field_change';
  id: string;
  record_id: string | null;
  /** Present on kind: 'event' only. */
  type?: string;
  /** Present on kind: 'field_change' only. */
  field?: string | null;
  actor_id: string | null;
  actor_name: string | null;
  source: 'human' | 'agent' | 'automation' | 'mcp' | null;
  /** The agent's name when an agent made the write (a snapshot taken then). Null for everything else. */
  agent_name?: string | null;
  payload?: unknown;
  old_value?: unknown;
  new_value?: unknown;
  /** Ticket #1287: the values as a person reads them (option labels, people in words). Absent from an older API. */
  old_display?: unknown;
  new_display?: unknown;
  record?: AuditRecordRef | null;
  other_record?: AuditRecordRef | null;
  created_at: string;
}

/** Shown where a name is missing: neutral, asserts nothing. */
export const NO_NAME = '—';

/** The record a row is about, as a chip that links to it, plus the database it lives in. Null when the row has no record. */
export function AuditRecordRefView({ ws, record, withDatabase = true }: { ws: string; record: AuditRecordRef | null | undefined; withDatabase?: boolean }): ReactNode {
  if (!record) return null;
  // A record this viewer may not read: the API sends only its id. "a record" is the whole truth; no name, no link.
  if (record.withheld) return <span className="text-muted">a record</span>;
  const title = record.title?.trim() || null;
  // Purged (no row, no names): nothing honest to name.
  if (record.deleted && !title && record.database_id === null) return <span className="text-muted" data-testid="audit-record-gone">{NO_NAME}</span>;
  const linkable = Boolean(record.database_id) && !record.deleted;
  return (
    <>
      <RelationChip
        title={title ?? 'Untitled'}
        number={record.number}
        href={linkable && record.database_id ? recordHref(ws, record.database_id, { id: record.id, title: record.title, number: record.number }) : undefined}
      />
      {withDatabase && record.database_name && <span className="text-muted"> in {record.database_name}</span>}
      {record.deleted && <span className="text-muted"> (in Trash)</span>}
    </>
  );
}

export function AuditWhat({ entry: e, ws, memberName }: { entry: AuditLogEntry; ws: string; memberName: (id: string) => string | undefined }) {
  const withheld = e.record?.withheld === true;
  if (e.kind === 'event') {
    const event = describeAuditEvent(e.type, e.payload);
    // The far side of a link: its CURRENT title, linked, when the API resolved it; else the title the event carried when it was written.
    const otherRef = e.other_record && !e.other_record.withheld && e.other_record.title ? e.other_record : null;
    // A created record's own title is also on the record chip below: name it once.
    const nameIsRecord = Boolean(event.name) && event.name === e.record?.title?.trim();
    return (
      <>
        {event.lead}
        {otherRef ? (
          <>
            {' '}
            <AuditRecordRefView ws={ws} record={otherRef} withDatabase={false} />
          </>
        ) : (
          event.name &&
          !nameIsRecord && (
            <>
              {' '}
              <span className="font-medium text-ink">“{event.name}”</span>
            </>
          )
        )}
        {event.tail}
        {e.record && (
          <>
            {' '}
            <span className="text-muted">·</span> <AuditRecordRefView ws={ws} record={e.record} />
          </>
        )}
        {event.detail && (
          <span className="text-muted">
            {' '}
            · {event.known ? event.detail : `Event code: ${event.detail}`}
          </span>
        )}
      </>
    );
  }
  // A field change on a record the viewer may not read arrives with its field and values blanked; say what is true, not "a deleted field".
  if (withheld) {
    return (
      <>
        Changed a field · <AuditRecordRefView ws={ws} record={e.record} />
      </>
    );
  }
  const change = describeFieldChange(
    e.field ?? undefined,
    e.old_display !== undefined ? e.old_display : e.old_value,
    e.new_display !== undefined ? e.new_display : e.new_value,
    memberName,
  );
  return (
    <>
      {change.kind === 'set' ? (
        <>
          Set <span className="font-medium text-ink">{change.field}</span> to {change.to}
        </>
      ) : change.kind === 'cleared' ? (
        <>
          Cleared <span className="font-medium text-ink">{change.field}</span>
          <span className="text-muted"> · was {change.from}</span>
        </>
      ) : change.from === null ? (
        <>
          Changed <span className="font-medium text-ink">{change.field}</span>
        </>
      ) : (
        <>
          <span className="font-medium text-ink">{change.field}</span>: {change.from} → {change.to}
        </>
      )}
      {e.record && (
        <>
          {' '}
          <span className="text-muted">·</span> <AuditRecordRefView ws={ws} record={e.record} />
        </>
      )}
    </>
  );
}
