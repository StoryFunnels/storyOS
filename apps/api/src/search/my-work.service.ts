import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { inferStateCategory, isFinishedStateCategory } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, records, selectOptions } from '../db/schema';
import { user } from '../db/auth-schema';
import { notDeleted } from '../db/soft-delete';
import { AccessService } from '../access/access.service';
import { RecordsService } from '../records/records.service';
import { renderCommentText, truncateForPreview } from '../comments/comment-render';
import type { Membership } from '../workspaces/workspace-access.guard';
import { presentRules, ruleFor } from '../automations/rule-visibility';
import { readApprovalSnapshot, UNKNOWN_REQUEST_TEXT } from '../automations/approval-snapshot';

/** Field types worth rendering as a dense-row chip in My Work (MN-072). */
const DENSE_TYPES = new Set(['select', 'multi_select', 'workflow', 'user', 'relation', 'date', 'checkbox']);

/** Rows returned per database, and per waiting list. A section past this says so (`truncated`) and carries its exact `total`. */
export const MY_WORK_PAGE = 50;

/** The due-date field is found by NAME, exactly as the web's `pickFacetFields` does it: a database with no such field has no due date here. */
const DUE_NAME = /(^|\W)(due|deadline)(\W|$)|due.?date|target.?date/i;

export type MyWorkMode = 'assigned' | 'created' | 'assigned_by_me';

/**
 * #1250 — the ONE place My work is computed. The My work page, the MCP `get_my_work` and the digest email (#1251) all call this;
 * a surface must not grow its own copy of "what is open for this person".
 *
 * Every number a section reports (`total`) is a SQL count over the same predicate that selects its rows, never the length of the
 * fetched page (ticket #404: a page is a window, and counting it reports the window's size).
 */
@Injectable()
export class MyWorkService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly recordsService: RecordsService,
  ) {}

  /**
   * #979 — for each record, who LAST set `userId` into one of its person fields, and when.
   *
   * Derived from the activity trail (`activity_events`, a `record.updated` event's `payload.diff`), not from a new column and not from
   * `record_field_changes`: that table is plan-gated (Free captures nothing, Pro keeps a day), so the answer would vanish on exactly the
   * workspaces most likely to ask. The activity trail is written for every update, has no pruning job today, and is indexed by
   * (record_id, created_at), so one query per database page (at most 50 records) reads it.
   *
   * An event counts when a person field's `to` CONTAINS the user and its `from` did not: the change that put them there, whether the
   * field holds one person or several. `DISTINCT ON (record_id) ... ORDER BY created_at DESC` is the LAST such change, so
   * A → B → me reports whoever set me, and me → removed → me again reports the second setter.
   *
   * No row means no change ever put the user there (the record was created with them set, was imported, or the trail predates the
   * assignment's capture): `null`, never a guess. The actor's name is what the record's own activity feed already shows to a caller who
   * can read the record, which every caller of this endpoint can for a row it returns.
   */
  private async assignedBy(
    recordIds: string[],
    userFieldIds: string[],
    userId: string,
  ): Promise<Map<string, { assigned_by: { id: string; name: string; kind: 'user' | 'agent' }; assigned_at: Date }>> {
    const out = new Map<string, { assigned_by: { id: string; name: string; kind: 'user' | 'agent' }; assigned_at: Date }>();
    if (recordIds.length === 0 || userFieldIds.length === 0) return out;
    const me = JSON.stringify(userId);
    const events = await this.db.execute<{
      record_id: string;
      actor_id: string | null;
      created_at: Date;
      source: string | null;
      agent_id: string | null;
      agent_name: string | null;
    }>(sql`
      SELECT DISTINCT ON (e.record_id) e.record_id, e.actor_id, e.created_at, e.source, e.agent_id, e.agent_name
      FROM activity_events e
      WHERE e.record_id IN (${sql.join(recordIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND e.type = 'record.updated'
        AND jsonb_typeof(e.payload->'diff') = 'object'
        AND EXISTS (
          SELECT 1 FROM jsonb_each(e.payload->'diff') d
          WHERE d.key IN (${sql.join(userFieldIds.map((id) => sql`${id}`), sql`, `)})
            AND (d.value->'to') @> ${me}::jsonb
            AND NOT COALESCE((d.value->'from') @> ${me}::jsonb, false)
        )
      ORDER BY e.record_id, e.created_at DESC, e.id DESC
    `);
    const rows = events.rows;
    const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id)))];
    const names = new Map(
      (actorIds.length ? await this.db.query.user.findMany({ where: inArray(user.id, actorIds), columns: { id: true, name: true } }) : []).map((a) => [a.id, a.name]),
    );
    for (const r of rows) {
      const agent = r.source === 'agent' || Boolean(r.agent_id);
      const by = agent
        ? { id: r.agent_id ?? r.actor_id ?? '', name: r.agent_name ?? names.get(r.actor_id ?? '') ?? '(agent)', kind: 'agent' as const }
        : r.actor_id
          ? { id: r.actor_id, name: names.get(r.actor_id) ?? '(deactivated)', kind: 'user' as const }
          : null;
      if (by) out.set(r.record_id, { assigned_by: by, assigned_at: new Date(r.created_at) });
    }
    return out;
  }

  /** Renderable field metadata for a database's dense My Work rows (MN-072). */
  private async denseFields(databaseId: string) {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      orderBy: (f, { asc }) => [asc(f.position)],
    });
    const dense = fieldRows.filter((f) => DENSE_TYPES.has(f.type));
    const selectIds = dense.filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow').map((f) => f.id);
    const opts = selectIds.length
      ? await this.db.query.selectOptions.findMany({ where: inArray(selectOptions.fieldId, selectIds) })
      : [];
    const byField = new Map<string, Array<{ id: string; label: string; color: string; category: string | null }>>();
    for (const o of opts) {
      const list = byField.get(o.fieldId) ?? [];
      // #1017 — the state category rides along, so My Work reads "finished" as data (ticket #1014) instead of guessing from the label.
      list.push({ id: o.id, label: o.label, color: o.color, category: o.category ?? null });
      byField.set(o.fieldId, list);
    }
    return dense.map((f) => ({
      id: f.id,
      api_name: f.apiName,
      display_name: f.displayName,
      type: f.type,
      options: byField.get(f.id) ?? undefined,
    }));
  }

  /**
   * Which of a database's select/workflow options are FINISHED, which are STARTED, and which field is its due date — read once per
   * database. "Finished" is `isFinishedStateCategory(category ?? inferStateCategory(label))`, the exact rule the My work page applies
   * (`isCompletedState`), so a row the page would grey out as done is a row the server drops. The state field is picked the way the
   * page picks it: a workflow field, else a select named State/Status.
   */
  private async stateAndDue(databaseId: string) {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
      orderBy: (f, { asc }) => [asc(f.position)],
    });
    const stateField =
      fieldRows.find((f) => f.type === 'workflow') ??
      fieldRows.find((f) => f.type === 'select' && /^(state|status)$/i.test(f.displayName.trim())) ??
      null;
    const dueField = fieldRows.find((f) => f.type === 'date' && DUE_NAME.test(f.displayName)) ?? null;
    let finishedIds: string[] = [];
    let startedIds: string[] = [];
    if (stateField) {
      const opts = await this.db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, stateField.id) });
      const cat = (o: (typeof opts)[number]) => o.category ?? inferStateCategory(o.label);
      finishedIds = opts.filter((o) => isFinishedStateCategory(cat(o))).map((o) => o.id);
      startedIds = opts.filter((o) => cat(o) === 'started').map((o) => o.id);
    }
    return { stateField, dueField, finishedIds, startedIds, userFieldIds: fieldRows.filter((f) => f.type === 'user').map((f) => f.id) };
  }

  /** A JSON-valued record column holds `ids` (a select option id, or a one-element array of one). */
  private valueIn(fieldId: string, ids: string[]): SQL {
    const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    return sql`(${records.values}->>${fieldId} IN (${list}) OR ${records.values}->${fieldId}->>0 IN (${list}))`;
  }

  /**
   * #1250 — one section of records (assigned to me, created by me, or assigned BY me to someone else), per database.
   *
   * - Finished rows (a completed/canceled state) are dropped here, server-side, unless `includeFinished` (the My work page, which
   *   renders them greyed out, asks for them; everything else gets open work only).
   * - Each database's rows come in the order overdue → due within a week → in progress → the rest, each by most recently changed, so
   *   when a database is past MY_WORK_PAGE the rows that were cut are the least urgent ones.
   * - `total` is a SQL count over the same predicate; `truncated` is `total > rows.length` and is never silent.
   */
  async recordSection(membership: Membership, userId: string, mode: MyWorkMode, opts: { includeFinished?: boolean } = {}) {
    // #474 phase 4 — see the note on `reachableDatabaseIds`: a record-scoped-only guest reaches a database without seeing all of it.
    const reachable = await this.access.reachableDatabaseIds(membership);
    if (reachable !== null && reachable.size === 0) return { groups: [], total: 0, truncated: false };

    const dbRows = await this.db.query.databases.findMany({
      where: and(
        eq(databases.workspaceId, membership.workspaceId),
        notDeleted(databases.deletedAt),
        ...(reachable !== null ? [inArray(databases.id, [...reachable])] : []),
      ),
      columns: { id: true, name: true, icon: true, color: true, spaceId: true },
    });

    const today = new Date().toISOString().slice(0, 10);
    const weekEnd = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);

    const groups: Array<{
      database: { id: string; name: string; icon: string | null; color: string | null };
      fields: Awaited<ReturnType<MyWorkService['denseFields']>>;
      /** Exact count of this database's rows in the section, however many `records` carries. */
      total: number;
      truncated: boolean;
      records: Array<{
        id: string;
        title: string;
        number: number | null;
        updated_at: Date;
        values: Record<string, unknown>;
        /** #979 — who last set the caller into a person field of this record, or null (see `assignedBy`). */
        assigned_by: { id: string; name: string; kind: 'user' | 'agent' } | null;
        assigned_at: Date | null;
      }>;
    }> = [];
    let grandTotal = 0;
    let anyTruncated = false;

    for (const database of dbRows) {
      const meta = await this.stateAndDue(database.id);
      let predicate: SQL | undefined;
      if (mode === 'created') {
        predicate = eq(records.createdBy, userId);
      } else {
        if (meta.userFieldIds.length === 0) continue;
        if (mode === 'assigned') {
          predicate = or(...meta.userFieldIds.map((id) => sql`${records.values}->${id} ? ${userId}`));
        } else {
          // Open records whose CURRENT assignee, in some person field, is someone other than me AND whose LAST change to that field
          // was made by me. A later change by anyone else (a reassignment, or the assignee handing it on) ends it being mine to chase.
          predicate = or(
            ...meta.userFieldIds.map(
              (id) => sql`(
                (SELECT e.actor_id FROM activity_events e
                  WHERE e.record_id = ${records.id} AND e.type = 'record.updated'
                    AND jsonb_typeof(e.payload->'diff') = 'object' AND (e.payload->'diff') ? ${id}
                  ORDER BY e.created_at DESC, e.id DESC LIMIT 1) = ${userId}
                AND (
                  (jsonb_typeof(${records.values}->${id}) = 'string' AND ${records.values}->>${id} <> '' AND ${records.values}->>${id} <> ${userId})
                  OR (jsonb_typeof(${records.values}->${id}) = 'array' AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements_text(${records.values}->${id}) x WHERE x <> ${userId}))
                )
              )`,
            ),
          );
        }
      }
      const recordScope = reachable !== null ? await this.access.visibleRecordIds(membership, database) : null;
      if (recordScope && recordScope.ids.size === 0) continue;

      const where = and(
        eq(records.databaseId, database.id),
        isNull(records.deletedAt),
        predicate,
        ...(recordScope ? [inArray(records.id, [...recordScope.ids])] : []),
        ...(!opts.includeFinished && meta.stateField && meta.finishedIds.length
          ? [sql`NOT COALESCE(${this.valueIn(meta.stateField.id, meta.finishedIds)}, false)`]
          : []),
      );

      // The total comes from SQL over the same predicate — never from `rows.length`, which is capped (ticket #404).
      const [counted] = await this.db.select({ n: sql<number>`count(*)::int` }).from(records).where(where);
      const total = counted?.n ?? 0;
      if (total === 0) continue;

      const dueExpr = meta.dueField ? sql`left(${records.values}->>${meta.dueField.id}, 10)` : null;
      const rank = sql`CASE
        WHEN ${dueExpr ?? sql`NULL`} IS NOT NULL AND ${dueExpr ?? sql`NULL`} <> '' AND ${dueExpr ?? sql`NULL`} < ${today} THEN 0
        WHEN ${dueExpr ?? sql`NULL`} IS NOT NULL AND ${dueExpr ?? sql`NULL`} <> '' AND ${dueExpr ?? sql`NULL`} <= ${weekEnd} THEN 1
        WHEN ${meta.stateField && meta.startedIds.length ? this.valueIn(meta.stateField.id, meta.startedIds) : sql`false`} THEN 2
        ELSE 3 END`;

      const rows = await this.db.query.records.findMany({
        where,
        orderBy: [rank, desc(records.updatedAt)],
        limit: MY_WORK_PAGE,
      });

      const defs = await this.recordsService.fieldDefs(database.id);
      const projected = await this.recordsService.attachLinks(
        rows.map((r) => this.recordsService.project(r, defs)),
        defs,
        membership,
      );
      const byId = new Map(projected.map((p) => [p.id, p]));
      const assigned =
        mode === 'assigned'
          ? await this.assignedBy(rows.map((r) => r.id), meta.userFieldIds, userId)
          : mode === 'assigned_by_me'
            ? await this.assignedAtByMe(rows.map((r) => r.id), meta.userFieldIds, userId)
            : new Map<string, { assigned_by: { id: string; name: string; kind: 'user' | 'agent' } | null; assigned_at: Date }>();
      groups.push({
        database: { id: database.id, name: database.name, icon: database.icon, color: database.color },
        fields: await this.denseFields(database.id),
        total,
        truncated: total > rows.length,
        records: rows.map((r) => ({
          id: r.id,
          // #884 — attachLinks narrowed the PROJECTED titles; this row shape reads the stored title, so use theirs.
          title: byId.get(r.id)?.title ?? r.title,
          number: r.number,
          updated_at: r.updatedAt,
          values: byId.get(r.id)?.values ?? {},
          assigned_by: assigned.get(r.id)?.assigned_by ?? null,
          assigned_at: assigned.get(r.id)?.assigned_at ?? null,
        })),
      });
      grandTotal += total;
      anyTruncated ||= total > rows.length;
    }
    return { groups, total: grandTotal, truncated: anyTruncated };
  }

  /** When the caller last changed one of these records' person fields (for the "assigned by me" rows). `assigned_by` is not repeated: it is the caller. */
  private async assignedAtByMe(recordIds: string[], userFieldIds: string[], userId: string) {
    const out = new Map<string, { assigned_by: null; assigned_at: Date }>();
    if (recordIds.length === 0 || userFieldIds.length === 0) return out;
    const events = await this.db.execute<{ record_id: string; created_at: Date }>(sql`
      SELECT DISTINCT ON (e.record_id) e.record_id, e.created_at
      FROM activity_events e
      WHERE e.record_id IN (${sql.join(recordIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND e.type = 'record.updated' AND e.actor_id = ${userId}
        AND jsonb_typeof(e.payload->'diff') = 'object'
        AND EXISTS (SELECT 1 FROM jsonb_each(e.payload->'diff') d WHERE d.key IN (${sql.join(userFieldIds.map((id) => sql`${id}`), sql`, `)}))
      ORDER BY e.record_id, e.created_at DESC, e.id DESC
    `);
    for (const r of events.rows) out.set(r.record_id, { assigned_by: null, assigned_at: new Date(r.created_at) });
    return out;
  }

  /**
   * #1250 — what is WAITING on this person: approvals they can decide, and mentions of them they have neither replied to nor read.
   *
   * - Approvals: pending and not expired, where the caller is the named approver or a workspace admin (the same two people the decide
   *   route accepts). A named approver keeps the approval even without general access to its database (the decide route allows it), but
   *   the RECORD is only named when the caller can reach it.
   * - Mentions: a comment that @-mentions the caller, written by someone else, with no LATER comment by the caller on that record and no
   *   read mention notification since it was written. One entry per record (the newest unanswered mention). Records in a personal
   *   space never surface here, and only records the caller can see do.
   *
   * Each list is capped at MY_WORK_PAGE with an exact SQL `total` and `truncated`.
   */
  async waiting(membership: Membership, userId: string) {
    const workspaceId = membership.workspaceId;
    const visible = await this.access.visibleDatabaseIds(membership);
    const recordGrantIds = await this.access.guestRecordGrantIds(membership);
    const canReachDb = (id: string | null | undefined) => Boolean(id) && (visible === null || visible.has(id!));

    // ── approvals ──
    const approvalWhere = sql`a.workspace_id = ${workspaceId}::uuid AND a.status = 'pending' AND a.expires_at > now()
      AND ${membership.role === 'admin' ? sql`true` : sql`a.approver_id = ${userId}`}`;
    const approvalCount = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM approvals a WHERE ${approvalWhere}`);
    const approvalRows = await this.db.execute<{
      id: string; record_id: string | null; preview_text: string; created_at: Date; expires_at: Date; database_id: string | null;
      rule_id: string | null; action_snapshot: unknown;
    }>(sql`
      SELECT a.id, a.record_id, a.preview_text, a.created_at, a.expires_at, (a.action_snapshot #>> '{ctx,databaseId}') AS database_id, a.rule_id, a.action_snapshot
      FROM approvals a WHERE ${approvalWhere}
      ORDER BY a.expires_at ASC, a.created_at DESC LIMIT ${MY_WORK_PAGE}
    `);
    const approvalTotal = approvalCount.rows[0]?.n ?? 0;
    const recordIdsOf = approvalRows.rows.map((r) => r.record_id).filter((v): v is string => Boolean(v));
    const recs = recordIdsOf.length
      ? await this.db
          .select({ id: records.id, title: records.title, number: records.number, databaseId: records.databaseId, databaseName: databases.name })
          .from(records)
          .innerJoin(databases, eq(databases.id, records.databaseId))
          .where(and(inArray(records.id, recordIdsOf), isNull(records.deletedAt)))
      : [];
    const recById = new Map(recs.map((r) => [r.id, r]));
    // #1280 — the rule is shown the way /approvals shows it: one shared gate (rule-visibility.ts), never this surface's own reading of automations.
    const rules = await presentRules(this.db, this.access, membership, approvalRows.rows.map((r) => r.rule_id));
    const approvalItems = approvalRows.rows.map((r) => {
      const rec = r.record_id ? recById.get(r.record_id) : undefined;
      const reachable = rec ? canReachDb(rec.databaseId) || Boolean(recordGrantIds?.has(rec.id)) : false;
      // #1298 — the same reading /approvals uses: a row whose snapshot cannot be read is an unknown request here too, not a different story.
      const readable = readApprovalSnapshot({ id: r.id, actionSnapshot: r.action_snapshot }).readable;
      return {
        approval_id: r.id,
        unknown: !readable,
        // #1280 — which automation is asking. Name + id for a viewer who may read that database's automations, else the neutral rule_label; all null for an approval no rule wrote (or whose rule was deleted).
        ...ruleFor(rules, r.rule_id),
        preview_text: readable ? r.preview_text : UNKNOWN_REQUEST_TEXT,
        created_at: new Date(r.created_at),
        expires_at: new Date(r.expires_at),
        record: rec && reachable ? { id: rec.id, number: rec.number, title: rec.title, database_id: rec.databaseId, database_name: rec.databaseName } : null,
      };
    });

    // ── mentions ──
    const scope =
      visible === null
        ? sql`true`
        : sql`(${visible.size ? sql`r.database_id IN (${sql.join([...visible].map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`}
            OR ${recordGrantIds?.size ? sql`r.id IN (${sql.join([...recordGrantIds].map((id) => sql`${id}::uuid`), sql`, `)})` : sql`false`})`;
    const mentionCte = sql`
      WITH m AS (
        SELECT DISTINCT ON (c.record_id) c.id AS comment_id, c.record_id, c.author_id, c.body, c.created_at,
               r.number, r.title, r.database_id, d.name AS database_name
        FROM comments c
        JOIN records r ON r.id = c.record_id AND r.deleted_at IS NULL
        JOIN databases d ON d.id = r.database_id AND d.deleted_at IS NULL AND d.workspace_id = ${workspaceId}::uuid
        JOIN spaces s ON s.id = d.space_id AND NOT s.personal
        WHERE ${userId} = ANY(c.mentions) AND c.deleted_at IS NULL AND c.author_id <> ${userId}
          AND ${scope}
          AND NOT EXISTS (SELECT 1 FROM comments c2 WHERE c2.record_id = c.record_id AND c2.author_id = ${userId}
                            AND c2.deleted_at IS NULL AND c2.created_at > c.created_at)
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = ${userId} AND n.record_id = c.record_id
                            AND n.type = 'mentioned' AND n.read_at IS NOT NULL AND n.created_at >= c.created_at)
        ORDER BY c.record_id, c.created_at DESC
      )`;
    const mentionCount = await this.db.execute<{ n: number }>(sql`${mentionCte} SELECT count(*)::int AS n FROM m`);
    const mentionRows = await this.db.execute<{
      comment_id: string; record_id: string; author_id: string; body: unknown; created_at: Date;
      number: number | null; title: string; database_id: string; database_name: string;
    }>(sql`${mentionCte} SELECT * FROM m ORDER BY created_at DESC LIMIT ${MY_WORK_PAGE}`);
    const authorIds = [...new Set(mentionRows.rows.map((r) => r.author_id))];
    const authors = new Map(
      (authorIds.length ? await this.db.query.user.findMany({ where: inArray(user.id, authorIds), columns: { id: true, name: true } }) : []).map((a) => [a.id, a.name]),
    );
    const mentionItems = mentionRows.rows.map((r) => ({
      comment_id: r.comment_id,
      mentioned_by: { id: r.author_id, name: authors.get(r.author_id) ?? '(deactivated)' },
      excerpt: truncateForPreview(renderCommentText(r.body as never), 200),
      created_at: new Date(r.created_at),
      record: { id: r.record_id, number: r.number, title: r.title, database_id: r.database_id, database_name: r.database_name },
    }));
    await this.recordsService.narrowTitles(membership, mentionItems.map((m) => m.record)); // #884
    await this.recordsService.narrowTitles(membership, approvalItems.flatMap((a) => (a.record ? [a.record] : [])));

    const mentionTotal = mentionCount.rows[0]?.n ?? 0;
    return {
      total: approvalTotal + mentionTotal,
      truncated: approvalTotal > approvalItems.length || mentionTotal > mentionItems.length,
      approvals: { total: approvalTotal, truncated: approvalTotal > approvalItems.length, items: approvalItems },
      mentions: { total: mentionTotal, truncated: mentionTotal > mentionItems.length, items: mentionItems },
    };
  }
}
