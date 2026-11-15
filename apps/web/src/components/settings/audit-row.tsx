import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { RelationChip } from '@/components/table-view/relation-chip';
import { describeAuditEvent } from '@/lib/audit-events';
import { auditActorLabel, describeFieldChange } from '@/lib/audit-values';
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
  /** 'member' (a person, possibly removed) | 'system' (a StoryOS process) | null (none recorded). Absent from an older API. */
  actor_kind?: 'member' | 'system' | null;
  /** True only for a member who has left (their Members row is tombstoned); never for a system actor. Absent from an older API. */
  actor_removed?: boolean;
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
export function AuditRecordRefView({
  ws,
  record,
  withDatabase = true,
  linked = true,
}: {
  ws: string;
  record: AuditRecordRef | null | undefined;
  withDatabase?: boolean;
  /** False where the row is itself a button (a link inside it would nest interactive elements): the chip draws without its href. */
  linked?: boolean;
}): ReactNode {
  if (!record) return null;
  // A record this viewer may not read: the API sends only its id. "a record" is the whole truth; no name, no link.
  if (record.withheld) return <span className="text-muted">a record</span>;
  const title = record.title?.trim() || null;
  // Purged (no row, no names): nothing honest to name.
  if (record.deleted && !title && record.database_id === null) return <span className="text-muted" data-testid="audit-record-gone">{NO_NAME}</span>;
  const linkable = linked && Boolean(record.database_id) && !record.deleted;
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

export function AuditWhat({
  entry: e,
  ws,
  memberName,
  linked = true,
}: {
  entry: AuditLogEntry;
  ws: string;
  memberName: (id: string) => string | undefined;
  /** See AuditRecordRefView. Default true: the audit log page links its chips. */
  linked?: boolean;
}) {
  const withheld = e.record?.withheld === true;
  if (e.kind === 'event') {
    const event = describeAuditEvent(e.type, e.payload);
    // The far side of a link: its CURRENT title, linked, when the API resolved it; else the title the event carried when it was written.
    const otherRef = e.other_record && !e.other_record.withheld && e.other_record.title ? e.other_record : null;
    // A created record's own title is also on the record chip below: name it once.
    const nameIsRecord = Boolean(event.name) && event.name === e.record?.title?.trim();
    // Ticket #1287 (Vera, PR 1512): a record this viewer may not read is "a record", and NOTHING the event carries may name it. Decided here,
    // before any name is printed, not left to the API having blanked the payload: a title, a summary or a snapshot name in the payload
    // is never drawn for a withheld row.
    if (withheld) {
      return (
        <>
          {event.lead}
          {event.tail}
          {e.record && (
            <>
              {' '}
              <span className="text-muted">·</span> <AuditRecordRefView ws={ws} record={e.record} />
            </>
          )}
        </>
      );
    }
    return (
      <>
        {event.lead}
        {otherRef ? (
          <>
            {' '}
            <AuditRecordRefView ws={ws} record={otherRef} withDatabase={false} linked={linked} />
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
            <span className="text-muted">·</span> <AuditRecordRefView ws={ws} record={e.record} linked={linked} />
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
        Changed a field · <AuditRecordRefView ws={ws} record={e.record} linked={linked} />
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
          <span className="text-muted">·</span> <AuditRecordRefView ws={ws} record={e.record} linked={linked} />
        </>
      )}
    </>
  );
}

/** The actor cell: the name, then a neutral "(removed)" only when the API says the member has left (`actor_removed`). Never guessed from the name. */
export function AuditActor({ entry: e, memberName }: { entry: AuditLogEntry; memberName: (id: string) => string | undefined }) {
  const label = auditActorLabel(e.actor_name, e.actor_id, memberName);
  // "A former member" already says it: do not say it twice. A tombstoned member keeps their real name and gains the marker.
  const marker = e.actor_removed === true && e.actor_kind !== 'system' && label !== 'A former member';
  return (
    <>
      <span className="truncate">{label}</span>
      {marker && <span className="shrink-0 text-muted" data-testid="audit-actor-removed">(removed)</span>}
    </>
  );
}

/** Ticket #1287: one write is a `record.updated` event AND one `field_change` row per changed field (same transaction, same instant). */
const diffKeyCount = (payload: unknown): number | null => {
  const diff = payload && typeof payload === 'object' ? (payload as { diff?: unknown }).diff : undefined;
  return diff && typeof diff === 'object' && !Array.isArray(diff) ? Object.keys(diff).length : null;
};

/**
 * Hides a `record.updated` row only when the field-change rows beside it already say everything it says.
 *
 * The rule, and why each clause: the event and its field rows are inserted in ONE transaction (records.service.ts `update`), so they share
 * record_id AND created_at to the instant. The event's `payload.diff` has exactly one key per field row. So an event is dropped only when
 * the loaded rows hold the SAME NUMBER of field changes, for the same record at the same created_at, as the diff has keys. Anything short
 * of that keeps it: no diff in the payload, a Free workspace (field changes are not captured at all), a page boundary that split the
 * write (fewer field rows loaded than keys), two writes to one record in the same millisecond (the count is then not equal). Keeping a
 * row is the safe direction; a row is never hidden on a guess. Restores (`restored_from_version_id`) are kept: that sentence is information.
 */
export function collapseDuplicateUpdates<T extends AuditLogEntry>(entries: readonly T[]): T[] {
  const fieldRows = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === 'field_change' && e.record_id) {
      const key = `${e.record_id}|${e.created_at}`;
      fieldRows.set(key, (fieldRows.get(key) ?? 0) + 1);
    }
  }
  return entries.filter((e) => {
    if (e.kind !== 'event' || e.type !== 'record.updated' || !e.record_id) return true;
    if ((e.payload as { restored_from_version_id?: unknown } | null | undefined)?.restored_from_version_id) return true;
    const keys = diffKeyCount(e.payload);
    if (keys === null || keys === 0) return true;
    return fieldRows.get(`${e.record_id}|${e.created_at}`) !== keys;
  });
}

export type AuditFeedState = 'loading' | 'error' | 'empty-filtered' | 'empty' | 'rows';

/** A failed query is not "no results": an error with nothing loaded is its own state (rows already loaded stay on screen). */
export function auditFeedState(q: { isLoading: boolean; isError: boolean; rows: number; filtersApplied: number }): AuditFeedState {
  if (q.isLoading) return 'loading';
  if (q.rows > 0) return 'rows';
  if (q.isError) return 'error';
  return q.filtersApplied > 0 ? 'empty-filtered' : 'empty';
}

/** The audit log could not be read. Says so, offers a retry, and claims nothing about what the log holds. Filters are left as they are. */
export function AuditLoadError({ onRetry, retrying = false }: { onRetry: () => void; retrying?: boolean }) {
  return (
    <EmptyState
      variant="filtered"
      role="alert"
      data-testid="audit-error"
      icon={<AlertTriangle className="h-4 w-4 text-error" />}
      title="Could not load the audit log"
      body="This is not an empty log; the request failed. Your filters are unchanged."
      action={{ label: retrying ? 'Trying…' : 'Try again', onClick: onRetry, variant: 'secondary', disabled: retrying, testId: 'audit-retry' }}
    />
  );
}
