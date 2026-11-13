import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, getTableColumns, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { ChangeSource } from '../db/schema';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, recordFieldChanges, records, selectOptions } from '../db/schema';
import { MembersDbService } from '../members/members-db.service';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { presentAuditRecords, redactIfWithheld } from './audit-record-presenter';
import { presentAuditActor } from './audit-actor';
import { renderTypedValue } from './render-values';
import { cursorTimestampSql, encodeKeysetCursor, keysetCondition, newestFirst } from './keyset-cursor';

/**
 * #454 — a read model and access boundary over data that ALREADY EXISTS
 * (activity_events, record_field_changes), not a new event stream. Every
 * record-level create/update/delete/restore is already captured; this makes
 * it visible workspace-wide instead of per-record, admin-only, filterable.
 *
 * #1059 closed the gap this comment used to state: a space, database or view deleted, restored, restricted or unrestricted is now an
 * `activity_events` row too (`activity/structural-events.ts`, `record_id` null, the object in `payload.object`), read by the same
 * query. What is still NOT here: a PERMANENT purge (none exists; everything is a soft delete, #453) and anything in a PERSONAL space or
 * a personal view, which are private from admins and so never in a workspace-wide log.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly members: MembersDbService,
    private readonly access: AccessService,
  ) {}

  async list(
    membership: Membership,
    filter: { actor?: string; entity?: string; type?: string[]; source?: ChangeSource[]; from?: string; to?: string; limit?: number; cursor?: string },
  ) {
    const workspaceId = membership.workspaceId;
    const limit = filter.limit ?? 50;
    const to = filter.to ? new Date(filter.to) : new Date();
    const from = filter.from ? new Date(filter.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const eventConditions = [
      eq(activityEvents.workspaceId, workspaceId),
      gte(activityEvents.createdAt, from),
      lte(activityEvents.createdAt, to),
    ];
    const changeConditions = [
      eq(recordFieldChanges.workspaceId, workspaceId),
      gte(recordFieldChanges.createdAt, from),
      lte(recordFieldChanges.createdAt, to),
    ];
    if (filter.actor) {
      eventConditions.push(eq(activityEvents.actorId, filter.actor));
      changeConditions.push(eq(recordFieldChanges.actorUserId, filter.actor));
    }
    if (filter.source?.length) {
      eventConditions.push(inArray(activityEvents.source, filter.source));
      changeConditions.push(inArray(recordFieldChanges.source, filter.source));
    }
    if (filter.entity) {
      // #1059 — an entity is a RECORD, or a space/database/view named in a structural event's payload.
      eventConditions.push(or(eq(activityEvents.recordId, filter.entity), sql`${activityEvents.payload} -> 'object' ->> 'id' = ${filter.entity}`)!);
      changeConditions.push(eq(recordFieldChanges.recordId, filter.entity));
    }
    if (filter.type?.length) {
      // #1059 — narrow to event types (`database.deleted`, `space.restricted`, `record.deleted`...). A field change is not an event
      // type of its own, so a type filter leaves them out.
      eventConditions.push(inArray(activityEvents.type, filter.type));
      changeConditions.push(sql`false`);
    }
    // #851 — a (created_at, id) tuple, NOT created_at alone: rows of one transaction share it.
    // One cursor serves both tables: it is only a (timestamp, uuid) constant to compare against,
    // and uuids are unique across both, so it resumes correctly wherever its row came from.
    const eventAfter = keysetCondition(activityEvents.createdAt, activityEvents.id, filter.cursor);
    if (eventAfter) eventConditions.push(eventAfter);
    const changeAfter = keysetCondition(recordFieldChanges.createdAt, recordFieldChanges.id, filter.cursor);
    if (changeAfter) changeConditions.push(changeAfter);

    // Two independent tables, merged and re-sorted here rather than a SQL
    // UNION — record_field_changes carries a per-FIELD row (#31's design),
    // event carries a per-WRITE row; a caller reading "what happened" wants
    // both without needing to know that split exists.
    const [events, changes] = await Promise.all([
      this.db
        .select({ ...getTableColumns(activityEvents), cursorTs: cursorTimestampSql(activityEvents.createdAt) })
        .from(activityEvents)
        .where(and(...eventConditions))
        .orderBy(desc(activityEvents.createdAt), desc(activityEvents.id))
        .limit(limit + 1),
      this.db
        .select({ ...getTableColumns(recordFieldChanges), cursorTs: cursorTimestampSql(recordFieldChanges.createdAt) })
        .from(recordFieldChanges)
        .where(and(...changeConditions))
        .orderBy(desc(recordFieldChanges.createdAt), desc(recordFieldChanges.id))
        .limit(limit + 1),
    ]);

    const fieldIds = [...new Set(changes.map((c) => c.fieldId).filter((id): id is string => Boolean(id)))];
    const fieldRows = fieldIds.length
      ? await this.db.query.fields.findMany({ where: (t, { inArray }) => inArray(t.id, fieldIds) })
      : [];
    const fieldName = new Map(fieldRows.map((f) => [f.id, f.displayName]));
    const fieldType = new Map(fieldRows.map((f) => [f.id, f.type]));
    // ticket #1287 - option ids to labels for the select-like fields on this page: ONE read for every database, no deletedAt filter
    // (the history of an option outliving the option is the point of a log; see render-values.ts).
    const selectFieldIds = fieldRows.filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow').map((f) => f.id);
    const optionRows = selectFieldIds.length
      ? await this.db.select({ id: selectOptions.id, label: selectOptions.label }).from(selectOptions).where(inArray(selectOptions.fieldId, selectFieldIds))
      : [];
    const optionLabel = new Map(optionRows.map((o) => [o.id, o.label]));
    const display = (value: unknown, type: string | null | undefined): unknown => {
      if (type !== 'select' && type !== 'multi_select' && type !== 'workflow') return renderTypedValue(value, type, { optionLabel });
      // a select value with no surviving option never prints its raw id
      const one = (v: unknown) => (typeof v === 'string' ? (optionLabel.get(v) ?? '(deleted option)') : v);
      return Array.isArray(value) ? value.map(one) : one(value);
    };

    // #454 — the no-FK decision (schema.ts's actorUserId/actorId comments)
    // exists so a removed (or GDPR-erased) member's historical rows still
    // name someone. resolveMembersForUsers reads the Members system
    // database's TOMBSTONED rows, which survive both — the first production
    // caller of this method (it previously had none).
    const actorIds = [
      ...new Set(
        [...events.map((e) => e.actorId), ...changes.map((c) => c.actorUserId)].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    ];
    const resolvedActors = await this.members.resolveMembersForUsers(workspaceId, actorIds);
    // ticket #1287 - `actor_name` is always words, never the auth id: a member's name, "Members sync" for the projection, a former member
    // as removed. `actor_id` stays beside it as the filter key (?actor=) and is not for display.
    const actorOf = (id: string | null) => presentAuditActor(id, resolvedActors.get(id ?? ''));

    const merged = [
      ...events.map((e) => ({
        kind: 'event' as const,
        id: e.id,
        record_id: e.recordId,
        // #1059 — for a structural event (space/database/view deleted, restored, restricted): what it happened to. null for a record event.
        object: (e.payload as { object?: { kind: string; id: string; name: string } } | null)?.object ?? null,
        type: e.type,
        actor_id: e.actorId,
        ...actorOf(e.actorId),
        source: e.source,
        // #934 — the credential and the agent behind the action, from the columns #882 / #541 already stamp: the audit
        // log is where "which credential did that" is a LIST, not one lookup per row. Null = a session, an OAuth grant,
        // an automation, or before the credential was recorded. No user_id: the human is `actor_*`, as before.
        credential_id: e.tokenId,
        agent_id: e.agentId,
        agent_name: e.agentName,
        // ticket #1132 / ADR-0021 §4 - the Runner run behind the action, so the line reads "Sales assistant, run 42, on Ievgen's
        // MacBook". run_number is looked up below (the Run's public number); runner_name is the snapshot taken when it was written.
        run_id: e.runId,
        runner_id: e.runnerId,
        runner_name: e.runnerName,
        payload: e.payload,
        created_at: e.createdAt,
        cursorTs: e.cursorTs,
      })),
      ...changes.map((c) => ({
        kind: 'field_change' as const,
        id: c.id,
        record_id: c.recordId,
        field: c.fieldId ? (fieldName.get(c.fieldId) ?? '(deleted field)') : 'Name',
        // ticket #1287 - the type and the values as a person reads them, ALONGSIDE the raw old_value/new_value below.
        field_type: c.fieldId ? (fieldType.get(c.fieldId) ?? null) : 'title',
        old_display: display(c.oldValue, c.fieldId ? fieldType.get(c.fieldId) : 'title'),
        new_display: display(c.newValue, c.fieldId ? fieldType.get(c.fieldId) : 'title'),
        actor_id: c.actorUserId,
        ...actorOf(c.actorUserId),
        source: c.source,
        credential_id: c.tokenId,
        agent_id: c.agentId,
        agent_name: c.agentName,
        run_id: c.runId,
        runner_id: c.runnerId,
        runner_name: c.runnerName,
        old_value: c.oldValue,
        new_value: c.newValue,
        created_at: c.createdAt,
        cursorTs: c.cursorTs,
      })),
    ].sort(newestFirst); // exact (microsecond text, id): a ms Date would tie rows that are not tied

    const page = merged.slice(0, limit);
    const hasMore = merged.length > limit;
    const last = page[page.length - 1];
    // ticket #1132 - "run 42": the Run record's public number, read for the rows on THIS page only. A Run that was since deleted
    // reads null (the row still carries run_id and the Runner's name).
    const runIds = [...new Set(page.map((r) => r.run_id).filter((id): id is string => Boolean(id)))];
    const runNumbers = new Map<string, number>();
    if (runIds.length > 0) {
      const runRows = await this.db.select({ id: records.id, number: records.number }).from(records).where(inArray(records.id, runIds));
      for (const r of runRows) if (r.number != null) runNumbers.set(r.id, r.number);
    }
    // ticket #1287 - name the record each row is about, for the rows on THIS page only: one batched read, gated for this viewer.
    // A relation.linked / relation.unlinked event names the OTHER record in its payload; it is resolved in the same batch, by the same rule.
    const otherIdOf = (r: { kind: string; payload?: unknown }): string | undefined =>
      r.kind === 'event' ? ((r.payload as { other?: { id?: string } } | null)?.other?.id ?? undefined) : undefined;
    const recordsById = await presentAuditRecords(this.db, this.access, membership, [...page.map((r) => r.record_id), ...page.map(otherIdOf)]);
    return {
      // cursorTs is a transport detail of the merge; it never reaches the client.
      data: page.map(({ cursorTs: _ts, ...row }) => {
        void _ts;
        const record = row.record_id ? (recordsById.get(row.record_id) ?? null) : null; // null: no record (a structural event names its `object`)
        const otherId = otherIdOf(row);
        const other = otherId ? (recordsById.get(otherId) ?? null) : null;
        // The payload's `other.title` is the title AT WRITE TIME; for a record this viewer may not read it must not travel either.
        const payload = other?.withheld && 'payload' in row ? { payload: { ...(row.payload as object), other: { id: otherId } } } : {};
        return redactIfWithheld(
          { ...row, ...payload, run_number: row.run_id ? (runNumbers.get(row.run_id) ?? null) : null, record, other_record: other },
          record,
        );
      }),
      next_cursor: hasMore && last ? encodeKeysetCursor({ t: last.cursorTs, id: last.id }) : null,
      has_more: hasMore,
    };
  }
}
