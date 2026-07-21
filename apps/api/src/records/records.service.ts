import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, SQL } from 'drizzle-orm';
import { evaluateFormula, formulaRefs, validateRecordValues } from '@storyos/schemas';
import type { FormulaNode } from '@storyos/schemas';
import type { FieldDef } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { activityEvents, databases, documents, fields, memberships, recordLinks, recordVersions, records, relations, selectOptions, user } from '../db/schema';
import type { QueryRecordsInput } from '@storyos/schemas';
import { compileFilter, cursorCondition, sortExpr } from './query-compiler';
import type { SortSpec } from './query-compiler';
import { keyBetween, keysAfter } from './rank';
import { diffSnapshots } from './record-diff';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEventsService } from '../events/domain-events.service';
import { MentionsService } from '../mentions/mentions.service';
import { AbuseFlagsService } from '../abuse/abuse-flags.service';

type RecordRow = typeof records.$inferSelect;

/** MN-080: a resolved relation write — validated targets plus which side we're on. */
interface LinkPlan {
  relationId: string;
  side: 'a' | 'b';
  apiName: string;
  /** MN-267: this record's own relation-field id — lets writeLinks() report exactly
   * which relation field changed, without re-deriving it from apiName later. */
  fieldId: string;
  /** MN-267: the database on the OTHER side of this relation — lets writeLinks()
   * report where the affected rollup-bearing records (if any) live. */
  targetDatabaseId: string;
  targets: Array<{ id: string; title: string }>;
}

export interface ProjectedRecord {
  id: string;
  /** Per-database sequential public id — the human handle in URLs (MN-087). */
  number: number | null;
  title: string;
  values: Record<string, unknown>;
  position: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const TRASH_RETENTION_DAYS = 30;

/** #278: a relation target is either a real record uuid or a public number — never
 * anything else. Guards planLinks() from handing a non-uuid string to a uuid column,
 * which Postgres rejects with a raw syntax error (surfaced as an opaque 500). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The RecordsRepository seam (ADR-0002): every record read/write in the
 * system flows through this service. Storage strategy changes happen here,
 * behind an unchanged public API.
 */
@Injectable()
export class RecordsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notificationsService: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly mentions: MentionsService,
    private readonly abuseFlags: AbuseFlagsService,
  ) {}

  /** Live field definitions + valid option ids, in validator shape. */
  async fieldDefs(databaseId: string): Promise<FieldDef[]> {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const selectFieldIds = fieldRows
      .filter((f) => f.type === 'select' || f.type === 'multi_select')
      .map((f) => f.id);
    const options = selectFieldIds.length
      ? await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectFieldIds),
        })
      : [];
    const optionsByField = new Map<string, string[]>();
    for (const option of options) {
      const list = optionsByField.get(option.fieldId) ?? [];
      list.push(option.id);
      optionsByField.set(option.fieldId, list);
    }
    return fieldRows.map((f) => ({
      id: f.id,
      api_name: f.apiName,
      type: f.type,
      config: (f.config ?? {}) as Record<string, unknown>,
      option_ids: optionsByField.get(f.id),
    }));
  }

  /** Projects storage rows through live fields: api_name keys, dangling options → null. */
  project(row: RecordRow, defs: FieldDef[]): ProjectedRecord {
    const values: Record<string, unknown> = {};
    const stored = row.values as Record<string, unknown>;
    for (const def of defs) {
      if (def.type === 'title' || def.type === 'relation') continue;
      if (def.type === 'created_at' || def.type === 'updated_at' || def.type === 'created_by') continue;
      if (def.type === 'id') continue; // surfaced top-level as `number`, not in values
      const raw = stored[def.id];
      if (raw === undefined || raw === null) continue;
      if (def.type === 'select') {
        values[def.api_name] = def.option_ids?.includes(raw as string) ? raw : null;
      } else if (def.type === 'multi_select') {
        const kept = (raw as string[]).filter((id) => def.option_ids?.includes(id));
        if (kept.length) values[def.api_name] = kept;
      } else {
        values[def.api_name] = raw;
      }
    }
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      values,
      position: row.position,
      created_by: row.createdBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }

  /** Fills relation-field values with {id, title} chips for a page of records (MN-018). */
  async attachLinks(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const relationDefs = defs.filter((d) => d.type === 'relation');
    if (relationDefs.length === 0 || projected.length === 0) {
      return this.attachFormulas(projected, defs); // lookups need relations; formulas don't
    }
    const ids = projected.map((p) => p.id);

    for (const def of relationDefs) {
      const relationId = def.config['relation_id'] as string;
      const side = def.config['side'] as 'a' | 'b';
      const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
      const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

      const rows = await this.db
        .select({ mine: myCol, id: records.id, title: records.title, number: records.number })
        .from(recordLinks)
        .innerJoin(records, eq(records.id, otherCol))
        .where(
          and(
            eq(recordLinks.relationId, relationId),
            inArray(myCol, ids),
            isNull(records.deletedAt),
          ),
        );

      const byRecord = new Map<string, Array<{ id: string; title: string; number: number | null }>>();
      for (const row of rows) {
        const list = byRecord.get(row.mine) ?? [];
        list.push({ id: row.id, title: row.title, number: row.number });
        byRecord.set(row.mine, list);
      }
      for (const record of projected) {
        const chips = byRecord.get(record.id);
        if (chips?.length) record.values[def.api_name] = chips;
      }
    }
    const withLookups = await this.attachLookups(projected, defs);
    const withRollups = await this.attachRollups(withLookups, defs);
    return this.attachFormulas(withRollups, defs);
  }

  /**
   * MN-064: aggregates related records through the already-attached relation
   * chips. One target-defs load + one records batch per rollup field. Empty
   * relation: 0 for count, null for the rest.
   */
  private async attachRollups(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const rollupDefs = defs.filter((d) => d.type === 'rollup');
    if (rollupDefs.length === 0 || projected.length === 0) return projected;

    for (const def of rollupDefs) {
      const op = def.config['op'] as 'count' | 'sum' | 'avg' | 'min' | 'max';
      const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
      const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
      if (!relationDef || relationDef.type !== 'relation') continue; // dangling — resolve to nothing

      let targetFieldId: string | null = null;
      if (targetApiName) {
        const side = relationDef.config['side'] as 'a' | 'b';
        const relation = await this.db.query.relations.findFirst({
          where: eq(relations.id, relationDef.config['relation_id'] as string),
        });
        if (!relation) continue;
        const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
        const targetDefs = await this.fieldDefs(targetDbId);
        targetFieldId = targetDefs.find((d) => d.api_name === targetApiName)?.id ?? null;
      }

      const numberById = new Map<string, number>();
      if (targetFieldId) {
        const linkedIds = new Set<string>();
        for (const record of projected) {
          const chips = record.values[relationDef.api_name] as Array<{ id: string }> | undefined;
          chips?.forEach((chip) => linkedIds.add(chip.id));
        }
        if (linkedIds.size > 0) {
          const targetRows = await this.db.query.records.findMany({
            where: and(inArray(records.id, [...linkedIds]), isNull(records.deletedAt)),
          });
          for (const row of targetRows) {
            const raw = (row.values as Record<string, unknown>)[targetFieldId];
            if (typeof raw === 'number') numberById.set(row.id, raw);
          }
        }
      }

      for (const record of projected) {
        const chips = (record.values[relationDef.api_name] as Array<{ id: string }> | undefined) ?? [];
        if (!targetApiName) {
          record.values[def.api_name] = op === 'count' ? chips.length : null;
          continue;
        }
        const nums = chips
          .map((chip) => numberById.get(chip.id))
          .filter((v): v is number => typeof v === 'number');
        if (op === 'count') {
          record.values[def.api_name] = nums.length;
        } else if (nums.length === 0) {
          record.values[def.api_name] = null;
        } else if (op === 'sum') {
          record.values[def.api_name] = nums.reduce((a, b) => a + b, 0);
        } else if (op === 'avg') {
          record.values[def.api_name] = nums.reduce((a, b) => a + b, 0) / nums.length;
        } else if (op === 'min') {
          record.values[def.api_name] = Math.min(...nums);
        } else {
          record.values[def.api_name] = Math.max(...nums);
        }
      }
    }
    return projected;
  }


  /**
   * Resolves lookup values through the already-attached relation chips
   * (MN-040): one target-defs load + one records batch per lookup field —
   * never per record. select ids are projected as labels so clients can
   * render without the target schema.
   */
  /** MN-043: evaluates formula fields after lookups resolve; select ids become labels in the value bag. */
  private async attachFormulas(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const formulaDefs = defs.filter((d) => d.type === 'formula' && (d.config['ast'] as unknown));
    if (formulaDefs.length === 0 || projected.length === 0) return projected;

    // Formulas compare select LABELS, not option ids.
    const selectDefs = defs.filter((d) => d.type === 'select');
    const labelByOption = new Map<string, string>();
    if (selectDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
      });
      for (const option of options) labelByOption.set(option.id, option.label);
    }

    // Topological order so formula-over-formula chains resolve (save-time cap = 5).
    const ordered = orderFormulasByDependency(formulaDefs);

    for (const record of projected) {
      const bag: Record<string, unknown> = { name: record.title };
      for (const def of defs) {
        let value = record.values[def.api_name];
        if (def.type === 'select' && typeof value === 'string') {
          value = labelByOption.get(value) ?? value;
        }
        bag[def.api_name] = value ?? null;
      }
      for (const def of ordered) {
        try {
          const result = evaluateFormula(def.config['ast'] as FormulaNode, bag);
          record.values[def.api_name] = result ?? null;
          bag[def.api_name] = result ?? null;
        } catch {
          record.values[def.api_name] = null;
        }
      }
    }
    return projected;
  }

  /**
   * MN-260: persists formula values into `computed_values` so fieldExpr()/the
   * keyset-cursor ORDER BY can sort by them like any stored field, reusing
   * that machinery unchanged instead of a second (offset) pagination mode.
   *
   * Deliberately narrower than attachFormulas(): only formulas that pass
   * formulaDependsOnlyOnOwnRecord are computed here, straight off `row.values`
   * — no lookup/rollup resolution, no related-record query. A formula that
   * reaches into a lookup or rollup would freeze against a related record we
   * don't have in hand at this record's own write time (the exact cross-record
   * problem rollups have); it's simply not written here and stays excluded
   * from SORTABLE, rather than materializing a value that's wrong from the start.
   *
   * Runs as a small follow-up transaction after the record's own write commits
   * — the displayed value (attachFormulas, called on every read) is untouched
   * and always fresh; this only feeds the persisted sort key.
   */
  private async materializeFormulas(defs: FieldDef[], rows: RecordRow[]): Promise<void> {
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    const formulaDefs = defs.filter(
      (d) => d.type === 'formula' && (d.config['ast'] as unknown) && formulaDependsOnlyOnOwnRecord(d, byApiName),
    );
    if (formulaDefs.length === 0 || rows.length === 0) return;

    const selectDefs = defs.filter((d) => d.type === 'select');
    const labelByOption = new Map<string, string>();
    if (selectDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
      });
      for (const option of options) labelByOption.set(option.id, option.label);
    }

    const ordered = orderFormulasByDependency(formulaDefs);

    await this.db.transaction(async (tx) => {
      for (const row of rows) {
        const stored = row.values as Record<string, unknown>;
        // MN-267: a rollup field is never in `values` (it's purely computed) — its
        // materialized value lives in `computed_values`, written independently by
        // recomputeRollupsForRelationField. Reading it from there (rather than the
        // always-undefined `values` lookup below) is what makes a formula-over-rollup
        // safe to materialize at all now that formulaDependsOnlyOnOwnRecord allows it.
        const computed = row.computedValues as Record<string, unknown>;
        const bag: Record<string, unknown> = { name: row.title };
        for (const def of defs) {
          let value: unknown = def.type === 'rollup' ? computed[def.id] : stored[def.id];
          if (def.type === 'select' && typeof value === 'string') {
            value = labelByOption.get(value) ?? value;
          }
          bag[def.api_name] = value ?? null;
        }
        const patch: Record<string, unknown> = {};
        for (const def of ordered) {
          try {
            const result = evaluateFormula(def.config['ast'] as FormulaNode, bag);
            patch[def.id] = result ?? null;
            bag[def.api_name] = result ?? null;
          } catch {
            patch[def.id] = null;
          }
        }
        // MN-267: merge (jsonb `||`), never a full replace — recomputeRollupsForRelationField
        // writes into this SAME column independently (a rollup and a formula can both
        // materialize for the same record without racing to clobber each other's keys).
        await tx
          .update(records)
          .set({ computedValues: sql`${records.computedValues} || ${JSON.stringify(patch)}::jsonb` })
          .where(eq(records.id, row.id));
      }
    });
  }

  /**
   * MN-260: backfill for a single just-created (or just-edited) formula field
   * across every existing record in its database — without this, sorting by a
   * brand-new formula field would leave every pre-existing record's sort value
   * null until that record happened to be written again. Only runs when the
   * field itself qualifies (formulaDependsOnlyOnOwnRecord); a no-op otherwise.
   * Chunked to avoid holding thousands of rows in memory at once.
   */
  async materializeFormulaFieldForAllRecords(databaseId: string, fieldId: string): Promise<void> {
    const defs = await this.fieldDefs(databaseId);
    const def = defs.find((d) => d.id === fieldId);
    if (!def || def.type !== 'formula') return;
    const CHUNK = 500;
    let cursor: string | null = null;
    for (;;) {
      const conditions = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
      if (cursor) conditions.push(gt(records.id, cursor));
      const chunk: RecordRow[] = await this.db.query.records.findMany({
        where: and(...conditions),
        orderBy: [asc(records.id)],
        limit: CHUNK,
      });
      if (chunk.length === 0) break;
      await this.materializeFormulas(defs, chunk);
      cursor = chunk[chunk.length - 1]!.id;
      if (chunk.length < CHUNK) break;
    }
  }

  /**
   * MN-267: the cross-record half of rollup materialization. `attachRollups()`
   * (above) is read-time only — this is the genuinely new piece: given a
   * database, ONE of its relation fields, and a bounded set of record ids on
   * that database, recomputes every rollup field configured to read through
   * that relation field for exactly those records, and persists into
   * `computed_values` (merged, never a full replace — see materializeFormulas).
   *
   * Two callers feed this, both via RollupInvalidationSubscriber:
   *  - a RELATED record's own field changed (invalidateRollupsForChange case a)
   *  - this relation's link membership changed (case b, using writeLinks'
   *    precise before∪after ids — see DomainEvent.linkedRelations)
   *
   * Chunked (CHUNK) so a highly-connected relation's fan-out is bounded per
   * round trip — this method itself is always invoked fire-and-forget by the
   * subscriber, never awaited by the write that triggered the change, so the
   * chunking bounds memory/transaction size rather than request latency.
   *
   * Also re-materializes any formula that (transitively) depends on one of
   * these rollups, for the SAME chunk — otherwise a formula-over-rollup's
   * sort value would only ever refresh the next time that record happened to
   * be written directly, defeating the point of lifting
   * formulaDependsOnlyOnOwnRecord's rollup exclusion.
   */
  async recomputeRollupsForRelationField(
    databaseId: string,
    relationFieldId: string,
    recordIds: string[],
  ): Promise<void> {
    if (recordIds.length === 0) return;
    const defs = await this.fieldDefs(databaseId);
    const rollupDefs = defs.filter(
      (d) => d.type === 'rollup' && d.config['relation_field_id'] === relationFieldId,
    );
    if (rollupDefs.length === 0) return;

    const CHUNK = 500;
    for (let i = 0; i < recordIds.length; i += CHUNK) {
      const chunk = recordIds.slice(i, i + CHUNK);
      const patchByRecord = new Map<string, Record<string, unknown>>();
      for (const def of rollupDefs) {
        const values = await this.computeRollupValuesForChunk(def, defs, chunk);
        for (const recordId of chunk) {
          const patch = patchByRecord.get(recordId) ?? {};
          patch[def.id] = values.has(recordId) ? values.get(recordId) : def.config['op'] === 'count' ? 0 : null;
          patchByRecord.set(recordId, patch);
        }
      }
      await this.db.transaction(async (tx) => {
        for (const [recordId, patch] of patchByRecord) {
          await tx
            .update(records)
            .set({ computedValues: sql`${records.computedValues} || ${JSON.stringify(patch)}::jsonb` })
            .where(eq(records.id, recordId));
        }
      });
      if (defs.some((d) => d.type === 'formula')) {
        const freshRows = await this.db.query.records.findMany({ where: inArray(records.id, chunk) });
        await this.materializeFormulas(defs, freshRows).catch(() => undefined);
      }
    }
  }

  /** One grouped aggregate query per rollup field per chunk — never N+1 per record. */
  private async computeRollupValuesForChunk(
    def: FieldDef,
    defs: FieldDef[],
    recordIds: string[],
  ): Promise<Map<string, number | null>> {
    const op = def.config['op'] as 'count' | 'sum' | 'avg' | 'min' | 'max';
    const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
    const result = new Map<string, number | null>();
    if (!relationDef || relationDef.type !== 'relation') return result; // dangling — resolves to nothing, same as attachRollups

    const side = relationDef.config['side'] as 'a' | 'b';
    const relationId = relationDef.config['relation_id'] as string;
    const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;

    if (op === 'count') {
      const rows = await this.db
        .select({ mine: myCol, n: sql<number>`count(*)` })
        .from(recordLinks)
        .innerJoin(records, and(eq(records.id, otherCol), isNull(records.deletedAt)))
        .where(and(eq(recordLinks.relationId, relationId), inArray(myCol, recordIds)))
        .groupBy(myCol);
      for (const r of rows) result.set(r.mine, Number(r.n));
      return result;
    }

    const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
    if (!targetApiName) return result;
    const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relationId) });
    if (!relation) return result;
    const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
    const targetDefs = await this.fieldDefs(targetDbId);
    const targetFieldId = targetDefs.find((d) => d.api_name === targetApiName)?.id;
    if (!targetFieldId) return result;

    const numExpr = sql`((${records.values}->>${targetFieldId})::numeric)`;
    const aggExpr =
      op === 'sum'
        ? sql<number>`sum(${numExpr})`
        : op === 'avg'
          ? sql<number>`avg(${numExpr})`
          : op === 'min'
            ? sql<number>`min(${numExpr})`
            : sql<number>`max(${numExpr})`;

    const rows = await this.db
      .select({ mine: myCol, v: aggExpr })
      .from(recordLinks)
      .innerJoin(
        records,
        and(
          eq(records.id, otherCol),
          isNull(records.deletedAt),
          sql`jsonb_typeof(${records.values}->${targetFieldId}) = 'number'`,
        ),
      )
      .where(and(eq(recordLinks.relationId, relationId), inArray(myCol, recordIds)))
      .groupBy(myCol);
    for (const r of rows) result.set(r.mine, r.v === null ? null : Number(r.v));
    return result;
  }

  /**
   * MN-267: backfill for a newly-created rollup field across every existing
   * record on its database — mirrors materializeFormulaFieldForAllRecords'
   * reasoning exactly (without this, sorting by a brand-new rollup field
   * would show every pre-existing record as null until its relation next
   * changed). Chunked to avoid holding thousands of ids in memory at once.
   */
  async recomputeRollupFieldForAllRecords(databaseId: string, fieldId: string): Promise<void> {
    const defs = await this.fieldDefs(databaseId);
    const def = defs.find((d) => d.id === fieldId);
    if (!def || def.type !== 'rollup') return;
    const relationFieldId = def.config['relation_field_id'] as string | undefined;
    if (!relationFieldId) return;
    const CHUNK = 500;
    let cursor: string | null = null;
    for (;;) {
      const conditions = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
      if (cursor) conditions.push(gt(records.id, cursor));
      const chunk = await this.db.query.records.findMany({
        where: and(...conditions),
        orderBy: [asc(records.id)],
        limit: CHUNK,
        columns: { id: true },
      });
      if (chunk.length === 0) break;
      await this.recomputeRollupsForRelationField(
        databaseId,
        relationFieldId,
        chunk.map((r) => r.id),
      );
      cursor = chunk[chunk.length - 1]!.id;
      if (chunk.length < CHUNK) break;
    }
  }

  /**
   * MN-267: the reverse-lookup entry point RollupInvalidationSubscriber calls
   * for every record_created/record_updated domain event. Two independent,
   * additive cascades — a change can trigger either, both, or neither:
   *
   *  (a) `changedFieldIds` — a plain field on `recordId` changed. Walks every
   *      relation where `databaseId` participates, and for each one whose
   *      OTHER side has a rollup reading through the reverse relation field
   *      (a `count` rollup always qualifies — it cares about link membership,
   *      not field values; sum/avg/min/max only if the changed field is its
   *      target), recomputes that rollup for whichever other-side records are
   *      CURRENTLY linked to `recordId`.
   *  (b) `linkedRelations` — this record's own relation link-set changed.
   *      Uses writeLinks()'s precise before∪after ids (never reconstructed
   *      from record_links after the fact, so an unlink is never missed) to
   *      recompute both this record's own rollup through the field that
   *      changed, and the affected other-side records' rollup through the
   *      relation's reverse field (`relations.fieldAId`/`fieldBId` — the
   *      relation row already carries both sides' field ids directly, no
   *      extra field-table lookup needed).
   *
   * Always called fire-and-forget from the subscriber (bus-isolated, and
   * wrapped again there) — never lets a recompute failure surface on the
   * write that triggered it.
   */
  async invalidateRollupsForChange(event: {
    databaseId: string;
    recordId: string;
    changedFieldIds?: string[];
    linkedRelations?: Array<{ relationId: string; fieldId: string; otherDatabaseId: string; otherRecordIds: string[] }>;
  }): Promise<void> {
    if (event.changedFieldIds?.length) {
      // target_field_api_name (rollup config) is an api_name; changedFieldIds are
      // field ids (Object.keys(diff) in update()) — resolve ids to api_names on
      // THIS database once, up front, so the per-relation filter below compares
      // like with like instead of an id against a name that never matches.
      const myDefs = await this.fieldDefs(event.databaseId);
      const idToApiName = new Map(myDefs.map((d) => [d.id, d.api_name]));
      const changedApiNames = new Set(
        event.changedFieldIds.map((id) => idToApiName.get(id)).filter((n): n is string => !!n),
      );
      const rels = await this.db.query.relations.findMany({
        where: or(eq(relations.databaseAId, event.databaseId), eq(relations.databaseBId, event.databaseId)),
      });
      for (const rel of rels) {
        const mySide: 'a' | 'b' = rel.databaseAId === event.databaseId ? 'a' : 'b';
        const otherDbId = mySide === 'a' ? rel.databaseBId : rel.databaseAId;
        const reverseFieldId = mySide === 'a' ? rel.fieldBId : rel.fieldAId;
        const otherDefs = await this.fieldDefs(otherDbId);
        const relevantRollups = otherDefs.filter(
          (d) =>
            d.type === 'rollup' &&
            d.config['relation_field_id'] === reverseFieldId &&
            (d.config['op'] === 'count' || changedApiNames.has(d.config['target_field_api_name'] as string)),
        );
        if (relevantRollups.length === 0) continue;

        const myCol = mySide === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
        const otherCol = mySide === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
        const links = await this.db
          .select({ other: otherCol })
          .from(recordLinks)
          .where(and(eq(recordLinks.relationId, rel.id), eq(myCol, event.recordId)));
        const otherIds = links.map((l) => l.other);
        if (otherIds.length === 0) continue;
        await this.recomputeRollupsForRelationField(otherDbId, reverseFieldId, otherIds);
      }
    }

    for (const link of event.linkedRelations ?? []) {
      await this.recomputeRollupsForRelationField(event.databaseId, link.fieldId, [event.recordId]);
      if (link.otherRecordIds.length === 0) continue;
      const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, link.relationId) });
      if (!relation) continue;
      const reverseFieldId = relation.fieldAId === link.fieldId ? relation.fieldBId : relation.fieldAId;
      await this.recomputeRollupsForRelationField(link.otherDatabaseId, reverseFieldId, link.otherRecordIds);
    }
  }

  private async attachLookups(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const lookupDefs = defs.filter((d) => d.type === 'lookup');
    if (lookupDefs.length === 0 || projected.length === 0) return projected;

    for (const def of lookupDefs) {
      const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
      if (!relationDef || relationDef.type !== 'relation') continue; // dangling — resolve to nothing
      const side = relationDef.config['side'] as 'a' | 'b';
      const relation = await this.db.query.relations.findFirst({
        where: eq(relations.id, relationDef.config['relation_id'] as string),
      });
      if (!relation) continue;
      const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
      const single = relation.cardinality === 'one_to_many' && side === 'a';

      const targetDefs = await this.fieldDefs(targetDbId);
      const targetDef = targetDefs.find((d) => d.api_name === def.config['target_field_api_name']);
      if (!targetDef) continue;

      const optionLabels = new Map<string, string>();
      if (targetDef.type === 'select' || targetDef.type === 'multi_select') {
        const options = await this.db.query.selectOptions.findMany({
          where: eq(selectOptions.fieldId, targetDef.id),
        });
        for (const option of options) optionLabels.set(option.id, option.label);
      }

      const linkedIds = new Set<string>();
      for (const record of projected) {
        const chips = record.values[relationDef.api_name] as Array<{ id: string }> | undefined;
        chips?.forEach((chip) => linkedIds.add(chip.id));
      }
      if (linkedIds.size === 0) continue;

      const targetRows = await this.db.query.records.findMany({
        where: and(inArray(records.id, [...linkedIds]), isNull(records.deletedAt)),
      });
      const valueOf = (row: (typeof targetRows)[number]): unknown => {
        if (targetDef.type === 'title') return row.title;
        const raw = (row.values as Record<string, unknown>)[targetDef.id];
        if (raw === undefined || raw === null) return null;
        if (targetDef.type === 'select') return optionLabels.get(raw as string) ?? null;
        if (targetDef.type === 'multi_select') {
          return (raw as string[]).map((id) => optionLabels.get(id)).filter(Boolean);
        }
        return raw;
      };
      const byId = new Map(targetRows.map((row) => [row.id, valueOf(row)]));

      for (const record of projected) {
        const chips = record.values[relationDef.api_name] as Array<{ id: string }> | undefined;
        if (!chips?.length) continue;
        const resolved = chips.map((chip) => byId.get(chip.id)).filter((v) => v !== undefined && v !== null);
        record.values[def.api_name] = single ? (resolved[0] ?? null) : resolved;
      }
    }
    return projected;
  }

  /** Active members of a workspace, for resolving a person by id / email / name. */
  private async userDirectory(workspaceId: string) {
    const rows = await this.db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(memberships)
      .innerJoin(user, eq(user.id, memberships.userId))
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.status, 'active')));
    return rows;
  }

  /**
   * MN-118: resolve people written to a user field.
   *
   * The validator accepted ANY string as a user id, so `assignee: "Ievgen"` was
   * stored verbatim and echoed back as success — the UI then rendered "(unknown)".
   * Silent corruption with a success receipt is the worst failure mode for an
   * agent-first product: an agent that verifies its own write by reading the echo
   * reports success.
   *
   * So a person may be written by id, email or display name, and anything that
   * doesn't resolve to exactly one active member throws — the raw string is never
   * stored. Runs before validation, so the validator still only ever sees ids.
   */
  private async resolveUserInputs(
    workspaceId: string,
    defs: FieldDef[],
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const userKeys = Object.keys(input).filter(
      (k) => defs.find((d) => d.api_name === k)?.type === 'user',
    );
    if (userKeys.length === 0) return input;

    const directory = await this.userDirectory(workspaceId);
    const byId = new Map(directory.map((u) => [u.id, u]));
    const byEmail = new Map(directory.map((u) => [u.email.toLowerCase(), u]));
    const byName = new Map<string, Array<{ id: string; name: string }>>();
    for (const u of directory) {
      const key = (u.name ?? '').trim().toLowerCase();
      if (!key) continue;
      byName.set(key, [...(byName.get(key) ?? []), u]);
    }

    const resolveOne = (raw: unknown, apiName: string): string => {
      if (typeof raw !== 'string' || !raw.trim()) {
        throw new UnprocessableEntityException({
          message: 'Record values validation failed',
          details: [{ path: `values.${apiName}`, message: 'expected a user id, email or name' }],
        });
      }
      const value = raw.trim();
      if (byId.has(value)) return value;
      const email = byEmail.get(value.toLowerCase());
      if (email) return email.id;
      const named = byName.get(value.toLowerCase()) ?? [];
      if (named.length === 1) return named[0]!.id;

      // Name the candidates: the agent's next turn should be able to fix itself.
      const who = directory.map((u) => `${u.name} <${u.email}>`).join(', ');
      throw new UnprocessableEntityException({
        message: 'Record values validation failed',
        details: [
          {
            path: `values.${apiName}`,
            message:
              named.length > 1
                ? `"${value}" matches ${named.length} people — use their email or id. Members: ${who}`
                : `no member "${value}" — use a user id, email, or exact name. Members: ${who}`,
          },
        ],
      });
    };

    const out = { ...input };
    for (const key of userKeys) {
      const raw = out[key];
      if (raw === null) continue; // explicit clear
      out[key] = Array.isArray(raw)
        ? [...new Set(raw.map((v) => resolveOne(v, key)))]
        : resolveOne(raw, key);
    }
    return out;
  }

  private validateOrThrow(defs: FieldDef[], input: Record<string, unknown>) {
    // MN-080: relations are accepted inline and written with the record, so a
    // seeding job doesn't need a second round-trip per record and never leaves a
    // record briefly unlinked.
    const result = validateRecordValues(defs, input, { relations: 'collect' });
    if (result.issues.length > 0) {
      throw new UnprocessableEntityException({
        message: 'Record values validation failed',
        details: result.issues,
      });
    }
    return result;
  }

  /**
   * MN-080: turn `{ project: [3] | ['<uuid>'] }` into everything needed to write
   * record_links. Resolved and fully validated BEFORE the transaction opens, so a
   * bad target id fails the whole write instead of leaving an unlinked record.
   */
  private async planLinks(
    defs: FieldDef[],
    links: Record<string, Array<string | number>>,
  ): Promise<LinkPlan[]> {
    const plans: LinkPlan[] = [];
    for (const [apiName, raw] of Object.entries(links)) {
      const def = defs.find((d) => d.api_name === apiName)!;
      const config = def.config as { relation_id?: string; side?: 'a' | 'b' };
      const relation = config.relation_id
        ? await this.db.query.relations.findFirst({ where: eq(relations.id, config.relation_id) })
        : undefined;
      if (!relation || !config.side) {
        throw new UnprocessableEntityException({
          message: 'Record values validation failed',
          details: [{ path: `values.${apiName}`, message: 'relation no longer exists' }],
        });
      }
      const side = config.side;
      const targetDatabaseId = side === 'a' ? relation.databaseBId : relation.databaseAId;

      // Ids and public numbers both allowed; numbers are the friendly form. A JSON
      // payload (e.g. from create_record, where relations are written inline with
      // the rest of the record) may carry a public number as a numeric string like
      // "1" rather than a JS number — that's treated the same as the number 1, never
      // as a raw id lookup. Anything that is neither a real uuid nor a number/numeric
      // string is rejected here, by field and value, instead of reaching the uuid
      // column and failing as a raw Postgres syntax error the caller sees as an
      // opaque 500 (#278).
      const isNumericString = (v: string) => /^\d+$/.test(v.trim());
      const toNumber = (v: string | number) => (typeof v === 'number' ? v : Number.parseInt(v.trim(), 10));
      const invalid = raw.find(
        (v) => !(typeof v === 'number' || (typeof v === 'string' && (isNumericString(v) || UUID_RE.test(v.trim())))),
      );
      if (invalid !== undefined) {
        throw new UnprocessableEntityException({
          message: 'Record values validation failed',
          details: [
            {
              path: `values.${apiName}`,
              message: `expected a record id or number, got ${JSON.stringify(invalid)}`,
            },
          ],
        });
      }
      const ids = raw.filter((v): v is string => typeof v === 'string' && !isNumericString(v));
      const numbers = raw
        .filter((v) => typeof v === 'number' || (typeof v === 'string' && isNumericString(v)))
        .map(toNumber);
      const found = raw.length
        ? await this.db.query.records.findMany({
            where: and(
              eq(records.databaseId, targetDatabaseId),
              isNull(records.deletedAt),
              numbers.length && ids.length
                ? or(inArray(records.id, ids), inArray(records.number, numbers))
                : numbers.length
                  ? inArray(records.number, numbers)
                  : inArray(records.id, ids),
            ),
            columns: { id: true, title: true, number: true },
          })
        : [];

      const targets: Array<{ id: string; title: string }> = [];
      for (const v of raw) {
        const numeric = typeof v === 'number' || (typeof v === 'string' && isNumericString(v));
        const hit = found.find((r) => (numeric ? r.number === toNumber(v) : r.id === v));
        if (!hit) {
          throw new UnprocessableEntityException({
            message: 'Record values validation failed',
            details: [
              {
                path: `values.${apiName}`,
                message: `no record "${v}" in the target database — links are not created`,
              },
            ],
          });
        }
        if (!targets.some((t) => t.id === hit.id)) targets.push({ id: hit.id, title: hit.title });
      }

      if (relation.cardinality === 'one_to_many' && side === 'a' && targets.length > 1) {
        throw new ConflictException(
          `"${apiName}" can link to only one target (one-to-many); got ${targets.length}`,
        );
      }
      plans.push({ relationId: relation.id, side, apiName, fieldId: def.id, targetDatabaseId, targets });
    }
    return plans;
  }

  /**
   * Writes a plan's links inside an existing transaction. `replace` clears the
   * record's current targets first — an update naming a relation means "set it to
   * exactly this", the same semantics as PUT /links.
   *
   * MN-267: also returns, per plan, the before∪after set of other-side record ids —
   * captured HERE, before the replace-delete runs, because that's the only place an
   * unlinked id is still visible. This feeds RollupInvalidationSubscriber: a rollup
   * on either side of this relation may need to recompute for exactly these ids.
   */
  private async writeLinks(
    tx: Db,
    workspaceId: string,
    actorId: string | null,
    record: { id: string; title: string },
    plans: LinkPlan[],
    replace: boolean,
  ): Promise<Array<{ relationId: string; fieldId: string; otherDatabaseId: string; otherRecordIds: string[] }>> {
    const affected: Array<{ relationId: string; fieldId: string; otherDatabaseId: string; otherRecordIds: string[] }> = [];
    for (const plan of plans) {
      const myCol = plan.side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
      const otherCol = plan.side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
      let beforeIds: string[] = [];
      if (replace) {
        const existing = await tx
          .select({ other: otherCol })
          .from(recordLinks)
          .where(and(eq(recordLinks.relationId, plan.relationId), eq(myCol, record.id)));
        beforeIds = existing.map((r) => r.other);
        await tx
          .delete(recordLinks)
          .where(and(eq(recordLinks.relationId, plan.relationId), eq(myCol, record.id)));
      }
      if (plan.targets.length) {
        await tx
          .insert(recordLinks)
          .values(
            plan.targets.map((t) => ({
              relationId: plan.relationId,
              fromRecordId: plan.side === 'a' ? record.id : t.id,
              toRecordId: plan.side === 'a' ? t.id : record.id,
            })),
          )
          .onConflictDoNothing();
        await tx.insert(activityEvents).values(
          plan.targets.flatMap((target) => [
            {
              workspaceId,
              recordId: record.id,
              actorId,
              type: 'relation.linked',
              payload: { relation_id: plan.relationId, other: target },
            },
            {
              workspaceId,
              recordId: target.id,
              actorId,
              type: 'relation.linked',
              payload: { relation_id: plan.relationId, other: { id: record.id, title: record.title } },
            },
          ]),
        );
      }
      const otherIds = new Set([...beforeIds, ...plan.targets.map((t) => t.id)]);
      if (otherIds.size > 0) {
        affected.push({
          relationId: plan.relationId,
          fieldId: plan.fieldId,
          otherDatabaseId: plan.targetDatabaseId,
          otherRecordIds: [...otherIds],
        });
      }
    }
    return affected;
  }

  private async lastPosition(databaseId: string): Promise<string | null> {
    const [last] = await this.db
      .select({ position: records.position })
      .from(records)
      .where(eq(records.databaseId, databaseId))
      .orderBy(desc(records.position))
      .limit(1);
    return last?.position ?? null;
  }

  async create(
    workspaceId: string,
    databaseId: string,
    input: Record<string, unknown>,
    actorId: string | null,
    depth = 0,
  ): Promise<ProjectedRecord> {
    const [created] = await this.createBatch(workspaceId, databaseId, [input], actorId, depth);
    return created!;
  }

  /**
   * Duplicate a record (MN-074): scalar values + description document + the
   * record's single references and many-to-many links. Owned collections
   * (one_to_many where this record is the "one" side) are NOT copied — a child
   * can only have one parent, so we never reparent them. Title gets " (copy)".
   */
  async duplicate(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const src = await this.get(databaseId, recordId);
    const defs = await this.fieldDefs(databaseId);
    const SKIP = new Set([
      'id', 'relation', 'lookup', 'rollup', 'formula', 'button', 'title', 'created_at', 'updated_at', 'created_by',
    ]);
    const input: Record<string, unknown> = { name: `${(src.title ?? '').trim() || 'Untitled'} (copy)` };
    for (const def of defs) {
      if (SKIP.has(def.type)) continue;
      const v = src.values[def.api_name];
      if (v !== undefined && v !== null) input[def.api_name] = v;
    }
    const created = await this.create(workspaceId, databaseId, input, actorId, 0);

    // Copy links: single references (one_to_many side a) and many-to-many; skip owned collections.
    for (const def of defs.filter((d) => d.type === 'relation')) {
      const relation = await this.db.query.relations.findFirst({
        where: eq(relations.id, def.config['relation_id'] as string),
      });
      if (!relation) continue;
      const side = def.config['side'] as 'a' | 'b';
      if (relation.cardinality === 'one_to_many' && side === 'b') continue;
      if (side === 'a') {
        const rows = await this.db
          .select({ to: recordLinks.toRecordId })
          .from(recordLinks)
          .where(and(eq(recordLinks.relationId, relation.id), eq(recordLinks.fromRecordId, recordId)));
        if (rows.length) {
          await this.db
            .insert(recordLinks)
            .values(rows.map((r) => ({ relationId: relation.id, fromRecordId: created.id, toRecordId: r.to })))
            .onConflictDoNothing();
          // MN-287: duplicate() copies links via raw inserts (bypassing writeLinks()
          // entirely — the whole point is copying without re-running link resolution),
          // the same gap auto-link had before it emitted its own record_linked. Same
          // event shape RelationsService's addLinks emits: RollupInvalidationSubscriber
          // recomputes the new record's own rollup through this field AND (via the
          // relation's reverse field) every copied target's rollup.
          this.domainEvents.emit({
            type: 'record_linked',
            workspaceId,
            databaseId,
            recordId: created.id,
            relationFieldId: def.id,
            actorId,
            depth: 0,
            linkedRelations: [
              {
                relationId: relation.id,
                fieldId: def.id,
                otherDatabaseId: relation.databaseBId,
                otherRecordIds: rows.map((r) => r.to),
              },
            ],
          });
        }
      } else {
        const rows = await this.db
          .select({ from: recordLinks.fromRecordId })
          .from(recordLinks)
          .where(and(eq(recordLinks.relationId, relation.id), eq(recordLinks.toRecordId, recordId)));
        if (rows.length) {
          await this.db
            .insert(recordLinks)
            .values(rows.map((r) => ({ relationId: relation.id, fromRecordId: r.from, toRecordId: created.id })))
            .onConflictDoNothing();
          this.domainEvents.emit({
            type: 'record_linked',
            workspaceId,
            databaseId,
            recordId: created.id,
            relationFieldId: def.id,
            actorId,
            depth: 0,
            linkedRelations: [
              {
                relationId: relation.id,
                fieldId: def.id,
                otherDatabaseId: relation.databaseAId,
                otherRecordIds: rows.map((r) => r.from),
              },
            ],
          });
        }
      }
    }

    // Copy the description document, if any.
    const doc = await this.db.query.documents.findFirst({ where: eq(documents.recordId, recordId) });
    if (doc?.content) {
      await this.db
        .insert(documents)
        .values({ recordId: created.id, content: doc.content, contentText: doc.contentText, version: 1 });
    }

    return this.get(databaseId, created.id);
  }

  /** Batch create (≤100, enforced by the DTO), one transaction, one activity event each. */
  async createBatch(
    workspaceId: string,
    databaseId: string,
    inputs: Array<Record<string, unknown>>,
    actorId: string | null,
    depth = 0,
    options: { suppressAutomations?: boolean } = {},
  ): Promise<ProjectedRecord[]> {
    const defs = await this.fieldDefs(databaseId);
    // MN-118: people resolve to real ids before validation, so a name can never be
    // stored verbatim and reported as success.
    const resolved = await Promise.all(
      inputs.map((input) => this.resolveUserInputs(workspaceId, defs, input)),
    );
    const validated = resolved.map((input) => this.validateOrThrow(defs, input));
    // Resolved up front: an unknown target must fail before any record is inserted.
    const linkPlans = await Promise.all(
      validated.map((v) => (v.links ? this.planLinks(defs, v.links) : Promise.resolve([]))),
    );
    const positions = await keysAfter(await this.lastPosition(databaseId), inputs.length);

    // MN-267: keyed by record index — writeLinks() runs inside the transaction below
    // and reports which other-side records may need a rollup recompute; carried out
    // to the record_created emit after commit, same pattern update() uses.
    const linkedRelationsByIndex = new Map<
      number,
      Array<{ relationId: string; fieldId: string; otherDatabaseId: string; otherRecordIds: string[] }>
    >();

    const rows = await this.db.transaction(async (tx) => {
      // Allocate a contiguous block of public numbers atomically (MN-087): bump the
      // per-database counter by N and take the returned high-water mark. Gap-tolerant.
      const [db] = await tx
        .update(databases)
        .set({ recordCounter: sql`${databases.recordCounter} + ${inputs.length}` })
        .where(eq(databases.id, databaseId))
        .returning({ counter: databases.recordCounter });
      const firstNumber = (db!.counter as number) - inputs.length + 1;
      const inserted = await tx
        .insert(records)
        .values(
          validated.map((v, i) => ({
            databaseId,
            number: firstNumber + i,
            title: v.title ?? '',
            values: stripNulls(v.values),
            position: positions[i]!,
            createdBy: actorId,
            updatedBy: actorId,
          })),
        )
        .returning();
      await tx.insert(activityEvents).values(
        inserted.map((row) => ({
          workspaceId,
          recordId: row.id,
          actorId,
          type: 'record.created',
          payload: { title: row.title },
        })),
      );
      for (const [i, row] of inserted.entries()) {
        const plans = linkPlans[i]!;
        if (plans.length) {
          const linked = await this.writeLinks(tx as unknown as Db, workspaceId, actorId, row, plans, false);
          if (linked.length) linkedRelationsByIndex.set(i, linked);
        }
      }
      return inserted;
    });
    // MN-195: fire-and-forget, after the write already succeeded — never lets
    // an abuse-detection failure turn into a failed write. Counts every
    // create path (including bulk import), never blocks or slows any of them.
    void this.abuseFlags.recordWrites(workspaceId, rows.length).catch(() => undefined);
    // MN-260: materialize formula sort values off the freshly-written rows —
    // best-effort/isolated the same way domain events are: a failure here must
    // never fail the create the user is waiting on.
    if (defs.some((d) => d.type === 'formula')) {
      await this.materializeFormulas(defs, rows).catch(() => undefined);
    }
    if (!options.suppressAutomations) {
      for (const [i, row] of rows.entries()) {
        this.domainEvents.emit({
          type: 'record_created',
          workspaceId,
          databaseId,
          recordId: row.id,
          actorId,
          depth,
          linkedRelations: linkedRelationsByIndex.get(i),
        });
      }
    }
    return rows.map((row) => this.project(row, defs));
  }

  async getRow(databaseId: string, recordId: string): Promise<RecordRow> {
    const row = await this.db.query.records.findFirst({
      where: and(eq(records.id, recordId), eq(records.databaseId, databaseId), isNull(records.deletedAt)),
    });
    if (!row) throw new NotFoundException('Record not found');
    return row;
  }

  async get(databaseId: string, recordId: string): Promise<ProjectedRecord> {
    const [row, defs] = await Promise.all([
      this.getRow(databaseId, recordId),
      this.fieldDefs(databaseId),
    ]);
    const [projected] = await this.attachLinks([this.project(row, defs)], defs);
    return projected!;
  }

  /** Resolve a record by its public per-database number (MN-087, pretty URLs). */
  async getByNumber(databaseId: string, number: number): Promise<ProjectedRecord> {
    const row = await this.db.query.records.findFirst({
      where: and(eq(records.databaseId, databaseId), eq(records.number, number), isNull(records.deletedAt)),
    });
    if (!row) throw new NotFoundException('Record not found');
    const defs = await this.fieldDefs(databaseId);
    const [projected] = await this.attachLinks([this.project(row, defs)], defs);
    return projected!;
  }

  async update(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    input: Record<string, unknown>,
    actorId: string,
    depth = 0,
  ): Promise<ProjectedRecord> {
    const defs = await this.fieldDefs(databaseId);
    const row = await this.getRow(databaseId, recordId);
    const validated = this.validateOrThrow(
      defs,
      await this.resolveUserInputs(workspaceId, defs, input),
    );
    // MN-080: resolved before the transaction — a bad target must not half-apply.
    const linkPlans = validated.links ? await this.planLinks(defs, validated.links) : [];

    const before = row.values as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...before };
    const diff: Record<string, { from: unknown; to: unknown }> = {};

    for (const [fieldId, value] of Object.entries(validated.values)) {
      const previous = before[fieldId] ?? null;
      if (JSON.stringify(previous) === JSON.stringify(value)) continue;
      diff[fieldId] = { from: previous, to: value };
      if (value === null) delete merged[fieldId];
      else merged[fieldId] = value;
    }
    if (validated.title !== undefined && validated.title !== row.title) {
      diff['title'] = { from: row.title, to: validated.title };
    }

    // A relation-only update has no value diff, but is still a real change.
    if (Object.keys(diff).length === 0 && linkPlans.length === 0) return this.project(row, defs);

    // MN-267: populated inside the transaction below (writeLinks' before∪after
    // report), read after commit to feed the record_updated event.
    let linkedRelations: Array<{
      relationId: string;
      fieldId: string;
      otherDatabaseId: string;
      otherRecordIds: string[];
    }> = [];

    const updated = await this.db.transaction(async (tx) => {
      const [next] = await tx
        .update(records)
        .set({ values: merged, title: validated.title ?? row.title, updatedBy: actorId })
        .where(eq(records.id, recordId))
        .returning();
      if (Object.keys(diff).length > 0) {
        await tx.insert(activityEvents).values({
          workspaceId,
          recordId,
          actorId,
          type: 'record.updated',
          payload: { diff },
        });
        // MN-231: snapshot the FULL pre-write state (not just the diff) so a
        // later restore can write it straight back without replaying a chain
        // of diffs. Same transaction as the write it's capturing — never
        // captured without the change it precedes actually landing.
        await tx.insert(recordVersions).values({
          workspaceId,
          recordId,
          actorId,
          title: row.title,
          values: before,
        });
      }
      // Naming a relation in an update sets it to exactly these targets.
      if (linkPlans.length) {
        linkedRelations = await this.writeLinks(
          tx as unknown as Db,
          workspaceId,
          actorId,
          { id: next!.id, title: next!.title },
          linkPlans,
          true,
        );
      }
      return next!;
    });

    // MN-260: recompute this record's own formula sort values off the just-
    // written row. Awaited (not fire-and-forget) so a query issued right after
    // this update already sees the fresh materialized value — same "near-
    // immediate" staleness bound the event bus gives everything else here.
    // Isolated like the mentions re-sync below: a failure here must never fail
    // the update the user is waiting on.
    if (defs.some((d) => d.type === 'formula')) {
      await this.materializeFormulas(defs, [updated]).catch(() => undefined);
    }

    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId,
      recordId,
      changedFieldIds: Object.keys(diff).filter((k) => k !== 'title'),
      actorId,
      depth,
      linkedRelations: linkedRelations.length ? linkedRelations : undefined,
    });

    // #140: a rich_text field can carry @/# mentions — re-sync backlinks +
    // notifications when one changed. Fire-and-forget: never fails the write.
    if (defs.some((d) => d.type === 'rich_text' && d.id in diff)) {
      void this.mentions
        .syncRecordMentions(workspaceId, databaseId, recordId, actorId)
        .catch(() => undefined);
    }

    // MN-049: newly-added people on user fields get an "assigned" notification.
    const addedUsers = new Set<string>();
    for (const def of defs) {
      if (def.type !== 'user' || !(def.id in diff)) continue;
      const prev = new Set<string>([].concat((before[def.id] as never) ?? []));
      const next = [].concat((merged[def.id] as never) ?? []) as string[];
      next.forEach((id) => {
        if (!prev.has(id)) addedUsers.add(id);
      });
    }
    if (addedUsers.size > 0) {
      await this.notificationsService.notify({
        workspaceId,
        databaseId,
        recordId,
        actorId,
        type: 'assigned',
        recipients: [...addedUsers],
      });
    }

    // MN-073: a status/priority (any select) change pings the record's assignees —
    // the people carried on its user fields — so triage state is pushed, not polled.
    const changedSelects = defs.filter((d) => d.type === 'select' && d.id in diff);
    if (changedSelects.length > 0) {
      const assignees = new Set<string>();
      for (const def of defs) {
        if (def.type !== 'user') continue;
        ([] as string[]).concat((merged[def.id] as never) ?? []).forEach((id) => {
          if (id) assignees.add(id);
        });
      }
      if (assignees.size > 0) {
        await this.notificationsService.notify({
          workspaceId,
          databaseId,
          recordId,
          actorId,
          type: 'state_changed',
          recipients: [...assignees],
          snippet: `${changedSelects.map((d) => d.api_name).join(', ')} changed`,
        });
      }
    }
    return this.project(updated, defs);
  }

  /** MN-231: version history, newest first (cursor-paginated like ActivityService.listForRecord). */
  async listVersions(recordId: string, limit: number, cursor?: string) {
    const conditions = [eq(recordVersions.recordId, recordId)];
    if (cursor) {
      const created = new Date(Buffer.from(cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(recordVersions.createdAt, created));
    }
    const rows = await this.db.query.recordVersions.findMany({
      where: and(...conditions),
      orderBy: [desc(recordVersions.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    return {
      data: page.map((v) => ({
        id: v.id,
        title: v.title,
        actor_id: v.actorId,
        created_at: v.createdAt,
      })),
      next_cursor:
        hasMore && page.length > 0
          ? Buffer.from(page[page.length - 1]!.createdAt.toISOString()).toString('base64url')
          : null,
      has_more: hasMore,
    };
  }

  /**
   * MN-231: restore a record's values + title to a previously captured
   * snapshot (record_versions). Writes back the FULL snapshot (not a merge)
   * — this is "go back to exactly this point", not a field patch.
   *
   * Deliberately narrower than update(): it does NOT re-run mentions re-sync
   * or the "assigned"/"state_changed" notification side effects update()
   * fires for genuine user edits. Restoring an old snapshot re-triggering a
   * notification storm for changes that already happened once would be
   * confusing, not helpful. It DOES write the same activity_events shape
   * (so the restore shows up in the existing MN-027 trail) and recomputes
   * formulas, so read paths stay consistent.
   *
   * The pre-restore state is itself snapshotted first, so a restore is never
   * a one-way door — restoring "to version N" can always be undone by
   * restoring to the version captured immediately before it ran.
   */
  async restoreVersion(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    versionId: string,
    actorId: string,
  ): Promise<ProjectedRecord> {
    const version = await this.db.query.recordVersions.findFirst({
      where: and(eq(recordVersions.id, versionId), eq(recordVersions.recordId, recordId)),
    });
    if (!version) throw new NotFoundException('Version not found');

    const defs = await this.fieldDefs(databaseId);
    const row = await this.getRow(databaseId, recordId);
    const target = { values: version.values as Record<string, unknown>, title: version.title };
    const diff = diffSnapshots({ values: row.values as Record<string, unknown>, title: row.title }, target);

    if (Object.keys(diff).length === 0) return this.project(row, defs);

    const updated = await this.db.transaction(async (tx) => {
      await tx.insert(recordVersions).values({
        workspaceId,
        recordId,
        actorId,
        title: row.title,
        values: row.values,
      });
      const [next] = await tx
        .update(records)
        .set({ values: target.values, title: target.title, updatedBy: actorId })
        .where(eq(records.id, recordId))
        .returning();
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.updated',
        payload: { diff, restored_from_version_id: versionId },
      });
      return next!;
    });

    if (defs.some((d) => d.type === 'formula')) {
      await this.materializeFormulas(defs, [updated]).catch(() => undefined);
    }

    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId,
      recordId,
      changedFieldIds: Object.keys(diff).filter((k) => k !== 'title'),
      actorId,
      depth: 0,
    });

    return this.project(updated, defs);
  }

  /**
   * Atomic move (ADR-0005 / MN-022): new fractional position between the given
   * neighbor and its adjacent record, plus an optional value patch (kanban
   * drops change group field + position in ONE call). Position changes emit
   * no activity noise; value changes reuse the normal update path.
   */
  async move(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    input: { before_record_id?: string; after_record_id?: string; values?: Record<string, unknown> },
    actorId: string,
  ): Promise<ProjectedRecord> {
    await this.getRow(databaseId, recordId);

    let newPosition: string | undefined;
    if (input.before_record_id || input.after_record_id) {
      const anchorId = (input.before_record_id ?? input.after_record_id)!;
      const anchor = await this.getRow(databaseId, anchorId);

      if (input.after_record_id) {
        // Place directly after the anchor: between anchor and its successor.
        const [next] = await this.db
          .select({ position: records.position })
          .from(records)
          .where(
            and(
              eq(records.databaseId, databaseId),
              isNull(records.deletedAt),
              sql`(${records.position}, ${records.id}) > (${anchor.position}, ${anchor.id})`,
            ),
          )
          .orderBy(asc(records.position), asc(records.id))
          .limit(1);
        newPosition = await keyBetween(anchor.position, next?.position ?? null);
      } else {
        // Place directly before the anchor: between its predecessor and anchor.
        const [prev] = await this.db
          .select({ position: records.position })
          .from(records)
          .where(
            and(
              eq(records.databaseId, databaseId),
              isNull(records.deletedAt),
              sql`(${records.position}, ${records.id}) < (${anchor.position}, ${anchor.id})`,
            ),
          )
          .orderBy(desc(records.position), desc(records.id))
          .limit(1);
        newPosition = await keyBetween(prev?.position ?? null, anchor.position);
      }
    }

    if (newPosition !== undefined) {
      await this.db.update(records).set({ position: newPosition }).where(eq(records.id, recordId));
      // Rebalance fallback: fractional keys grow on repeated same-gap inserts.
      if (newPosition.length > 40) await this.rebalance(databaseId);
    }

    if (input.values && Object.keys(input.values).length > 0) {
      return this.update(workspaceId, databaseId, recordId, input.values, actorId);
    }
    return this.get(databaseId, recordId);
  }

  /** Rewrites all positions with fresh evenly-spaced keys (key-length exhaustion). */
  private async rebalance(databaseId: string) {
    const rows = await this.db.query.records.findMany({
      where: eq(records.databaseId, databaseId),
      orderBy: [asc(records.position), asc(records.id)],
      columns: { id: true },
    });
    const keys = await keysAfter(null, rows.length);
    await this.db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i++) {
        await tx.update(records).set({ position: keys[i]! }).where(eq(records.id, rows[i]!.id));
      }
    });
  }

  async softDelete(workspaceId: string, databaseId: string, recordId: string, actorId: string) {
    await this.getRow(databaseId, recordId);
    await this.db.transaction(async (tx) => {
      await tx.update(records).set({ deletedAt: new Date() }).where(eq(records.id, recordId));
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.deleted',
        payload: {},
      });
    });
    return { deleted: true };
  }

  /** MN-050: one values patch applied to many records; per-record validation, partial failures reported. */
  async batchUpdate(
    workspaceId: string,
    databaseId: string,
    recordIds: string[],
    input: Record<string, unknown>,
    actorId: string,
  ) {
    const failed: Array<{ record_id: string; message: string }> = [];
    let updated = 0;
    for (const recordId of recordIds) {
      try {
        await this.update(workspaceId, databaseId, recordId, input, actorId);
        updated++;
      } catch (error) {
        failed.push({
          record_id: recordId,
          message: error instanceof Error ? (error as { message: string }).message : 'failed',
        });
      }
    }
    return { updated, failed };
  }

  async batchDelete(workspaceId: string, databaseId: string, recordIds: string[], actorId: string) {
    const rows = await this.db.query.records.findMany({
      where: and(eq(records.databaseId, databaseId), inArray(records.id, recordIds), isNull(records.deletedAt)),
      columns: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await this.db.transaction(async (tx) => {
        await tx.update(records).set({ deletedAt: new Date() }).where(inArray(records.id, ids));
        await tx.insert(activityEvents).values(
          ids.map((id) => ({ workspaceId, recordId: id, actorId, type: 'record.deleted', payload: {} })),
        );
      });
    }
    return { deleted: ids.length, record_ids: ids };
  }

  async batchRestore(workspaceId: string, databaseId: string, recordIds: string[], actorId: string) {
    const rows = await this.db.query.records.findMany({
      where: and(eq(records.databaseId, databaseId), inArray(records.id, recordIds), isNotNull(records.deletedAt)),
      columns: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await this.db.transaction(async (tx) => {
        await tx.update(records).set({ deletedAt: null }).where(inArray(records.id, ids));
        await tx.insert(activityEvents).values(
          ids.map((id) => ({ workspaceId, recordId: id, actorId, type: 'record.restored', payload: {} })),
        );
      });
    }
    return { restored: ids.length };
  }

  async restore(workspaceId: string, databaseId: string, recordId: string, actorId: string) {
    const row = await this.db.query.records.findFirst({
      where: and(
        eq(records.id, recordId),
        eq(records.databaseId, databaseId),
        isNotNull(records.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException('Record not found in trash');
    await this.db.transaction(async (tx) => {
      await tx.update(records).set({ deletedAt: null }).where(eq(records.id, recordId));
      await tx.insert(activityEvents).values({
        workspaceId,
        recordId,
        actorId,
        type: 'record.restored',
        payload: {},
      });
    });
    const defs = await this.fieldDefs(databaseId);
    return this.project({ ...row, deletedAt: null }, defs);
  }

  async listTrash(databaseId: string) {
    const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.db.query.records.findMany({
      where: and(
        eq(records.databaseId, databaseId),
        isNotNull(records.deletedAt),
        gt(records.deletedAt, cutoff),
      ),
      orderBy: [desc(records.deletedAt)],
      limit: 200,
    });
    return rows.map((r) => ({ id: r.id, title: r.title, deleted_at: r.deletedAt }));
  }

  /**
   * The workhorse: POST /records/query (MN-012). Filter AST → SQL via the
   * compiler; multi-key sorts with NULLS FIRST/LAST (MN-252 — `input.nulls`,
   * default 'last'); keyset cursors with id tiebreaker; no sorts = manual
   * (position) order.
   */
  async query(databaseId: string, input: QueryRecordsInput, currentUserId: string) {
    const defs = await this.fieldDefs(databaseId);
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    const nullsFirst = input.nulls === 'first';

    const SORTABLE = new Set([
      'id', 'title', 'text', 'number', 'date', 'url', 'email', 'select',
      // MN-267: rollup is now materialized too (recomputeRollupsForRelationField,
      // invalidated via RollupInvalidationSubscriber on the related record's
      // change or the relation's own link-set change) — reuses computed_values/
      // fieldExpr()/the keyset cursor exactly like formula does (MN-260).
      'checkbox', 'created_at', 'updated_at', 'created_by', 'user', 'formula', 'rollup',
    ]);
    const sorts: SortSpec[] = input.sorts.map((s) => {
      const def = byApiName.get(s.field);
      if (!def) throw new UnprocessableEntityException(`unknown sort field "${s.field}"`);
      if (!SORTABLE.has(def.type) || (def.type === 'user' && def.config['multi'] === true)) {
        throw new UnprocessableEntityException(`cannot sort by ${def.type} field "${s.field}"`);
      }
      // MN-260/MN-267: a formula is only sortable if its materialized value can
      // be trusted — i.e. it never (transitively) reaches a `lookup` field.
      // `rollup` is no longer excluded here (see formulaDependsOnlyOnOwnRecord's
      // doc comment) — it has real invalidation plumbing now, same as a formula
      // referencing another formula.
      if (def.type === 'formula' && !formulaDependsOnlyOnOwnRecord(def, byApiName)) {
        throw new UnprocessableEntityException(
          `cannot sort by formula field "${s.field}" — it depends on a related record (through a lookup), which isn't materialized yet`,
        );
      }
      return { def, direction: s.direction };
    });

    const conditions: unknown[] = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
    if (input.q) conditions.push(sql`${records.title} ILIKE ${'%' + input.q + '%'}`);
    if (input.filter) {
      conditions.push(compileFilter(input.filter, { defs: byApiName, currentUserId }));
    }

    if (input.cursor) {
      const decoded = decodeQueryCursor(input.cursor, sorts.length);
      if (sorts.length > 0) {
        conditions.push(
          cursorCondition(
            sorts,
            (decoded.v ?? []).map((value, i) => reviveSortValue(value, sorts[i]!.def.type)),
            decoded.id,
            nullsFirst,
          ),
        );
      } else {
        const after = or(
          gt(records.position, String(decoded.p)),
          and(eq(records.position, String(decoded.p)), gt(records.id, decoded.id)),
        );
        conditions.push(after!);
      }
    }

    const nullsClause = nullsFirst ? sql`NULLS FIRST` : sql`NULLS LAST`;
    const orderBy =
      sorts.length > 0
        ? [
            ...sorts.map((s) =>
              s.direction === 'asc'
                ? sql`${sortExpr(s.def)} ASC ${nullsClause}`
                : sql`${sortExpr(s.def)} DESC ${nullsClause}`,
            ),
            asc(records.id),
          ]
        : [asc(records.position), asc(records.id)];

    const rows = await this.db
      .select()
      .from(records)
      .where(and(...(conditions as Parameters<typeof and>)))
      .orderBy(...(orderBy as SQL[]))
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = page[page.length - 1];

    let nextCursor: string | null = null;
    if (hasMore && last) {
      nextCursor =
        sorts.length > 0
          ? encodeQueryCursor({ v: sorts.map((s) => extractSortValue(last, s.def)), id: last.id })
          : encodeQueryCursor({ p: last.position, id: last.id });
    }

    return {
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  /** Simple list: manual (position) order, optional q title search, keyset cursor. */
  async list(databaseId: string, opts: { limit: number; cursor?: string; q?: string }) {
    const defs = await this.fieldDefs(databaseId);
    const conditions = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
    if (opts.q) conditions.push(sql`${records.title} ILIKE ${'%' + opts.q + '%'}`);

    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      const after = or(
        gt(records.position, decoded.position),
        and(eq(records.position, decoded.position), gt(records.id, decoded.id)),
      );
      conditions.push(after!);
    }

    const rows = await this.db.query.records.findMany({
      where: and(...conditions),
      orderBy: [asc(records.position), asc(records.id)],
      limit: opts.limit + 1,
    });

    const page = rows.slice(0, opts.limit);
    const hasMore = rows.length > opts.limit;
    const lastRow = page[page.length - 1];
    return {
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs),
      next_cursor: hasMore && lastRow ? encodeCursor(lastRow.position, lastRow.id) : null,
      has_more: hasMore,
    };
  }
}

function stripNulls(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null));
}

/**
 * Topological order so formula-over-formula chains resolve (save-time cap = 5).
 * Shared by attachFormulas (read-time, page-scoped) and materializeFormulas
 * (write-time, persisted) — same ordering, two different destinations.
 */
function orderFormulasByDependency(formulaDefs: FieldDef[]): FieldDef[] {
  const ordered: FieldDef[] = [];
  const remaining = new Set(formulaDefs);
  for (let pass = 0; pass < 6 && remaining.size > 0; pass++) {
    for (const def of [...remaining]) {
      const refs = new Set<string>();
      const walk = (n: { kind: string; api_name?: string; operand?: unknown; left?: unknown; right?: unknown; args?: unknown[] }) => {
        if (n.kind === 'ref' && n.api_name) refs.add(n.api_name);
        if (n.operand) walk(n.operand as never);
        if (n.left) walk(n.left as never);
        if (n.right) walk(n.right as never);
        (n.args as never[] | undefined)?.forEach((a) => walk(a));
      };
      walk(def.config['ast'] as never);
      const blocked = [...remaining].some((other) => other !== def && refs.has(other.api_name));
      if (!blocked) {
        ordered.push(def);
        remaining.delete(def);
      }
    }
  }
  ordered.push(...remaining); // defensive: cycles saved before the guard still evaluate (to null)
  return ordered;
}

/**
 * MN-260 spike finding, resolved for rollup by MN-267: rollups had NO
 * recompute-on-related-record-change plumbing when this was first written
 * (attachRollups was purely a read-time, per-fetched-page computation, and no
 * subscriber on DomainEventsService touched rollups at all). That plumbing now
 * exists — RollupInvalidationSubscriber + RecordsService.invalidateRollupsForChange/
 * recomputeRollupsForRelationField, persisting into the same `computed_values`
 * column formula already uses — so a formula that depends on a rollup is safe
 * to materialize: the rollup's own materialized value is what gets read (see
 * materializeFormulas' `computed` lookup), not a value computed as if the
 * related record's total were always null.
 *
 * `lookup` stays excluded — it has no materialization/invalidation plumbing of
 * its own (a separate ticket, if ever addressed), so a formula reaching into
 * one would still silently compute as if the looked-up value were always
 * null. This walks the formula's full dependency chain (through other
 * formulas, and now through rollups too) and excludes it from
 * materialization/SORTABLE only if it ever reaches a lookup.
 */
function formulaDependsOnlyOnOwnRecord(def: FieldDef, byApiName: Map<string, FieldDef>): boolean {
  const visited = new Set<string>();
  const walk = (ast: FormulaNode): boolean => {
    for (const apiName of formulaRefs(ast)) {
      if (visited.has(apiName)) continue; // already cleared, or mid-cycle (cycles are save-time rejected anyway)
      visited.add(apiName);
      const target = byApiName.get(apiName);
      if (!target) continue; // dangling ref resolves to null at eval time — not a cross-record concern
      if (target.type === 'lookup') return false;
      if (target.type === 'formula') {
        const targetAst = target.config['ast'] as FormulaNode | undefined;
        if (targetAst && !walk(targetAst)) return false;
      }
    }
    return true;
  };
  const ast = def.config['ast'] as FormulaNode | undefined;
  return ast ? walk(ast) : true;
}

function extractSortValue(row: RecordRow, def: { id: string; type: string }): unknown {
  if (def.type === 'id') return row.number;
  if (def.type === 'title') return row.title;
  if (def.type === 'created_at') return row.createdAt.toISOString();
  if (def.type === 'updated_at') return row.updatedAt.toISOString();
  if (def.type === 'created_by') return row.createdBy;
  if (def.type === 'formula' || def.type === 'rollup') {
    const raw = (row.computedValues as Record<string, unknown>)[def.id];
    return raw === undefined ? null : raw;
  }
  const raw = (row.values as Record<string, unknown>)[def.id];
  return raw === undefined ? null : raw;
}

function reviveSortValue(value: unknown, type: string): unknown {
  if (value === null) return null;
  if (type === 'created_at' || type === 'updated_at') return new Date(String(value));
  return value;
}

interface QueryCursor {
  v?: unknown[];
  p?: string;
  id: string;
}

function encodeQueryCursor(cursor: QueryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeQueryCursor(cursor: string, expectedSortCount: number): Required<Pick<QueryCursor, 'id'>> & QueryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as QueryCursor;
    if (typeof parsed.id !== 'string') throw new Error();
    if (expectedSortCount > 0) {
      if (!Array.isArray(parsed.v) || parsed.v.length !== expectedSortCount) throw new Error();
    } else if (typeof parsed.p !== 'string') {
      throw new Error();
    }
    return parsed as Required<Pick<QueryCursor, 'id'>> & QueryCursor;
  } catch {
    throw new UnprocessableEntityException('Invalid cursor');
  }
}

function encodeCursor(position: string, id: string): string {
  return Buffer.from(JSON.stringify({ position, id })).toString('base64url');
}

function decodeCursor(cursor: string): { position: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      position: string;
      id: string;
    };
    if (typeof parsed.position !== 'string' || typeof parsed.id !== 'string') throw new Error();
    return parsed;
  } catch {
    throw new UnprocessableEntityException('Invalid cursor');
  }
}
