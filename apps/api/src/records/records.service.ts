import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql, SQL } from 'drizzle-orm';
import { activeFilter, applyFieldDefaults, evaluateFormula, formulaRefs, systemFieldDefsFor, validateRecordValues } from '@storyos/schemas';
import type { FormulaNode } from '@storyos/schemas';
import type { FieldDef, FilterNode } from '@storyos/schemas';
import { DB } from '../db/db.module';
import { buildRenderContext, renderTypedValue } from '../activity/render-values';
import { assertOwnedAttachments, loadAttachmentChips } from '../attachments/attachment-values';
import type { Db } from '../db/client';
import { activityEvents, databases, documents, fields, memberships, recordFieldChanges, recordLinks, recordVersions, recordWatchers, records, relations, selectOptions, user } from '../db/schema';
import type { ChangeSource } from '../db/schema';
import type { QueryRecordsInput } from '@storyos/schemas';
import { compileFilter, cursorCondition, filterReferencedFields, sortExpr } from './query-compiler';
import type { CompilerContext, SortSpec } from './query-compiler';
import { keyBetween, keysAfter } from './rank';
import { diffSnapshots } from './record-diff';
import { EntitlementsService } from '../billing/entitlements.service';
import { summarizeChanges } from './record-change-summary';
import { isPickOneOp, pickOneRow, pickOneSortKey, rollupFieldValue } from './rollup-pick-one';
import type { PickOneOp } from './rollup-pick-one';
import type { ChangeSummaryField } from './record-change-summary';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEventsService } from '../events/domain-events.service';
import { MentionsService } from '../mentions/mentions.service';
import { AbuseFlagsService } from '../abuse/abuse-flags.service';
import { AccessService } from '../access/access.service';
import type { Membership } from '../workspaces/workspace-access.guard';

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
    private readonly entitlements: EntitlementsService,
    /** #469 — per-viewer database visibility for relation chips (attachLinks). */
    private readonly access: AccessService,
  ) {}

  /**
   * #31 — days of history this workspace keeps. `0` means the feature is OFF
   * and nothing is captured; see docs/architecture/version-history.md.
   *
   * Cached per workspace for the life of the request-ish: this is consulted on
   * every record write, and a plan does not change mid-write. A stale read is
   * harmless in both directions — a just-upgraded workspace starts capturing a
   * moment later, a just-downgraded one captures a few rows the prune removes.
   */
  private historyWindowCache = new Map<string, { days: number; at: number }>();

  private async historyRetentionDays(workspaceId: string): Promise<number> {
    const cached = this.historyWindowCache.get(workspaceId);
    if (cached && Date.now() - cached.at < 30_000) return cached.days;
    const { historyRetentionDays: days } = await this.entitlements.getLimits(workspaceId);
    this.historyWindowCache.set(workspaceId, { days, at: Date.now() });
    return days;
  }

  /** Live field definitions + valid option ids, in validator shape. */
  async fieldDefs(databaseId: string): Promise<FieldDef[]> {
    const fieldRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const selectFieldIds = fieldRows
      .filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow')
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
      if (def.type === 'select' || def.type === 'workflow') {
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

  /**
   * Fills relation-field values with {id, title} chips for a page of records
   * (MN-018).
   *
   * `membership` is the CALLER, optional and omitted by every internal/system
   * use (title recompute, automations, migrations, agent packs) that must see
   * every chip regardless of who eventually reads the result. Pass it from an
   * actual HTTP request so a chip pointing at a database the caller cannot see
   * is never attached (#469) — a guest granted "Wholesale Orders" but denied
   * "Roasts" read the denied database's record titles through the relation
   * chip on every order, on the query response, the CSV export (which reads
   * these same chips, `export/csv.ts`), and the links endpoint. Lookup and
   * rollup fields (`attachLookups`/`attachRollups` below) derive their linked
   * ids from the SAME chips this attaches, so withholding a chip here also
   * withholds the lookup value and zeroes the rollup for that relation — one
   * fix point, not three.
   */
  async attachLinks(
    projected: ProjectedRecord[],
    defs: FieldDef[],
    membership?: Membership,
  ): Promise<ProjectedRecord[]> {
    const relationDefs = defs.filter((d) => d.type === 'relation');
    if (relationDefs.length === 0 || projected.length === 0) {
      // #391 — attachments do NOT need relations, so they must be resolved on
      // this path too. Missing it meant a database with no relation field
      // returned raw attachment ids and every card rendered a uuid, which is
      // exactly how the six tests below failed the first time.
      return this.attachFormulas(await this.attachFiles(projected, defs), defs); // lookups need relations; formulas don't
    }
    const ids = projected.map((p) => p.id);

    for (const def of relationDefs) {
      const relationId = def.config['relation_id'] as string;
      const side = def.config['side'] as 'a' | 'b';

      if (membership) {
        const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relationId) });
        if (!relation) continue; // dangling — no chips
        const targetDatabaseId = side === 'a' ? relation.databaseBId : relation.databaseAId;
        const targetDb = await this.db.query.databases.findFirst({
          where: eq(databases.id, targetDatabaseId),
          columns: { id: true, spaceId: true },
        });
        // A caller who cannot read the target database gets no chips for this
        // field at all — never a partial/redacted chip, an ABSENT one, exactly
        // like the direct route already 404s rather than reveal a shape.
        if (targetDb && (await this.access.effectiveForDatabase(membership, targetDb)) === null) continue;
      }

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
    const withAttachments = await this.attachFiles(projected, defs);
    const withLookups = await this.attachLookups(withAttachments, defs);
    const withRollups = await this.attachRollups(withLookups, defs);
    return this.attachFormulas(withRollups, defs);
  }

  /**
   * #391 — turn an attachment field's stored id list into renderable chips.
   *
   * The stored value is an ordered array of attachment ids; a client cannot draw
   * a thumbnail from a uuid, so the projection resolves them the same way
   * relation chips are resolved — one batched query for the page, then a lookup
   * per value.
   *
   * ORDER comes from the stored array, not from the query. A gallery card shows
   * the FIRST file, and "first" has to mean what the user dragged to the front
   * rather than whatever `created_at` says.
   *
   * An id with no surviving row simply drops out. That is the same rule dangling
   * relation targets follow, and it means a half-finished delete degrades to a
   * shorter list rather than to a broken image.
   */
  private async attachFiles(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const attachmentDefs = defs.filter((d) => d.type === 'attachment');
    if (attachmentDefs.length === 0 || projected.length === 0) return projected;
    const chips = await loadAttachmentChips(
      this.db,
      projected.map((r) => r.id),
      attachmentDefs.map((d) => d.id),
    );
    for (const record of projected) {
      for (const def of attachmentDefs) {
        const ids = record.values[def.api_name];
        record.values[def.api_name] = Array.isArray(ids)
          ? ids.map((id) => chips.get(String(id))).filter(Boolean)
          : [];
      }
    }
    return projected;
  }

  /**
   * MN-064: aggregates related records through the already-attached relation
   * chips. One target-defs load + one records batch per rollup field. Empty
   * relation: 0 for count, null for the rest.
   *
   * MN-295: an optional `filter` on the rollup config scopes the aggregate to
   * only the linked records matching it — the SAME filter AST/compiler as
   * saved views (query-compiler's compileFilter), just compiled against the
   * RELATED database's fields and folded into the `targetRows` where-clause
   * below, so a filtered rollup fetches only the target rows that pass its
   * condition (rather than filtering an already-`SELECT *`ed batch in JS).
   */
  private async attachRollups(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const rollupDefs = defs.filter((d) => d.type === 'rollup');
    if (rollupDefs.length === 0 || projected.length === 0) return projected;

    for (const def of rollupDefs) {
      const rawOp = def.config['op'];
      // #286: first/last is argmax/argmin, not an aggregate — it orders the
      // linked records and reads a value off the ONE that wins, so it shares
      // nothing with the numeric path below beyond the relation + filter.
      if (isPickOneOp(rawOp)) {
        await this.attachPickOneRollup(def, defs, projected, rawOp);
        continue;
      }
      const op = rawOp as 'count' | 'sum' | 'avg' | 'min' | 'max';
      const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
      const filterNode = activeFilter(def.config['filter'] as FilterNode | undefined);
      const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
      if (!relationDef || relationDef.type !== 'relation') continue; // dangling — resolve to nothing

      let targetFieldId: string | null = null;
      let filterSql: SQL | undefined;
      if (targetApiName || filterNode) {
        const side = relationDef.config['side'] as 'a' | 'b';
        const relation = await this.db.query.relations.findFirst({
          where: eq(relations.id, relationDef.config['relation_id'] as string),
        });
        if (!relation) continue;
        const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
        const targetDefs = await this.fieldDefs(targetDbId);
        if (targetApiName) targetFieldId = targetDefs.find((d) => d.api_name === targetApiName)?.id ?? null;
        if (filterNode) {
          const ctx: CompilerContext = {
            defs: new Map(targetDefs.map((d) => [d.api_name, d])),
            currentUserId: '', // rollup filters may not reference "me" (validated at field-create time)
          };
          filterSql = compileFilter(filterNode, ctx);
        }
      }

      const numberById = new Map<string, number>();
      const passesFilter = new Set<string>();
      if (targetFieldId || filterSql) {
        const linkedIds = new Set<string>();
        for (const record of projected) {
          const chips = record.values[relationDef.api_name] as Array<{ id: string }> | undefined;
          chips?.forEach((chip) => linkedIds.add(chip.id));
        }
        if (linkedIds.size > 0) {
          const conditions = [inArray(records.id, [...linkedIds]), isNull(records.deletedAt)];
          if (filterSql) conditions.push(filterSql);
          const targetRows = await this.db.query.records.findMany({ where: and(...conditions) });
          for (const row of targetRows) {
            passesFilter.add(row.id);
            if (targetFieldId) {
              const raw = (row.values as Record<string, unknown>)[targetFieldId];
              if (typeof raw === 'number') numberById.set(row.id, raw);
            }
          }
        }
      }

      for (const record of projected) {
        const allChips = (record.values[relationDef.api_name] as Array<{ id: string }> | undefined) ?? [];
        const chips = filterSql ? allChips.filter((chip) => passesFilter.has(chip.id)) : allChips;
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
   * #286: resolves ONE `first`/`last` rollup for a page of records.
   *
   * Same shape as the aggregate path — one target-defs load and one batched
   * target-rows query per field, never per record — but the reduction is
   * `pickOneRow` (see rollup-pick-one.ts) instead of sum/avg/min/max, and the
   * returned value is whatever field the config names on the WINNING record.
   *
   * With no `target_field_api_name` the value is a relation-style chip
   * (`{ id, title }`) pointing AT that record, which is what the founder asked
   * for: "Last Ticket" should be clickable, not a dead string.
   */
  private async attachPickOneRollup(
    def: FieldDef,
    defs: FieldDef[],
    projected: ProjectedRecord[],
    op: PickOneOp,
  ): Promise<void> {
    const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
    if (!relationDef || relationDef.type !== 'relation') return; // dangling — resolve to nothing
    const orderByApiName = def.config['order_by_field_api_name'] as string | undefined | null;
    if (!orderByApiName) return; // config invariant, enforced at field-create time
    const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
    const filterNode = activeFilter(def.config['filter'] as FilterNode | undefined);

    const side = relationDef.config['side'] as 'a' | 'b';
    const relation = await this.db.query.relations.findFirst({
      where: eq(relations.id, relationDef.config['relation_id'] as string),
    });
    if (!relation) return;
    const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
    const storedDefs = await this.fieldDefs(targetDbId);
    // #351 overlay: `number` (and friends) have no stored `fields` row, and
    // ordering by the public #id is the ticket's headline case. Additive — a real
    // field of the same api_name always wins.
    const targetDefs = [...storedDefs, ...systemFieldDefsFor(storedDefs.map((d) => d.api_name))];
    const orderByDef = targetDefs.find((d) => d.api_name === orderByApiName);
    if (!orderByDef) return; // ordering field was deleted — no defensible winner
    const targetDef = targetApiName ? targetDefs.find((d) => d.api_name === targetApiName) : undefined;
    if (targetApiName && !targetDef) return;

    // Select ids are opaque uuids; both the ordering and the returned value want
    // the LABEL — ordering by option id is ordering by random bytes.
    const labelledDefs = [orderByDef, targetDef].filter(
      (d): d is FieldDef => !!d && ['select', 'workflow', 'multi_select'].includes(d.type),
    );
    const optionLabels = new Map<string, string>();
    if (labelledDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, labelledDefs.map((d) => d.id)),
      });
      for (const option of options) optionLabels.set(option.id, option.label);
    }

    const linkedIds = new Set<string>();
    for (const record of projected) {
      const chips = record.values[relationDef.api_name] as Array<{ id: string }> | undefined;
      chips?.forEach((chip) => linkedIds.add(chip.id));
    }
    // Explicitly null rather than left undefined, so a record with no links
    // serializes as an empty cell instead of a missing key.
    for (const record of projected) record.values[def.api_name] = null;
    if (linkedIds.size === 0) return;

    const conditions = [inArray(records.id, [...linkedIds]), isNull(records.deletedAt)];
    if (filterNode) {
      const ctx: CompilerContext = {
        defs: new Map(targetDefs.map((d) => [d.api_name, d])),
        currentUserId: '', // rollup filters may not reference "me" (validated at field-create time)
      };
      conditions.push(compileFilter(filterNode, ctx));
    }
    const targetRows = await this.db.query.records.findMany({ where: and(...conditions) });
    const rowById = new Map(targetRows.map((row) => [row.id, row]));

    for (const record of projected) {
      const chips = (record.values[relationDef.api_name] as Array<{ id: string }> | undefined) ?? [];
      // The filter is applied by the query above, so a chip with no row here was
      // either filtered out or deleted — both mean "not a candidate".
      const candidates = chips.flatMap((chip) => {
        const row = rowById.get(chip.id);
        return row ? [row] : [];
      });
      const winner = pickOneRow(candidates, op, (row) => rollupFieldValue(row, orderByDef, optionLabels));
      if (!winner) continue;
      record.values[def.api_name] = targetDef
        ? (rollupFieldValue(winner, targetDef, optionLabels) ?? null)
        // Same shape as a relation chip PLUS `database_id`: a relation cell gets
        // the target db from its own field metadata, but a rollup's field has no
        // relation block, so the chip has to carry what the link needs or "Last
        // Ticket" renders as unclickable text — the opposite of the ask.
        : { id: winner.id, title: winner.title, number: winner.number, database_id: targetDbId };
    }
  }

  /**
   * Resolves lookup values through the already-attached relation chips
   * (MN-040): one target-defs load + one records batch per lookup field —
   * never per record. select ids are projected as labels so clients can
   * render without the target schema.
   */
  /** MN-043: evaluates formula fields after lookups resolve; select ids become labels in the value bag. */
  /**
   * #298 — the related records' value bags for every relation a formula
   * aggregates over, for the WHOLE page at once.
   *
   * The shape that matters is the query count: one pass per referenced RELATION,
   * never one per record. A page of 200 projects with `count({Issues})` issues
   * the same number of round trips as a page of 1 — mirroring attachLookups /
   * attachRollups, which already batch this way.
   *
   * Returns recordId → { relationApiName → related bags }, ready to hand to
   * `evaluateFormula`.
   */
  /**
   * #300 — the link sets for a batch of records, shaped exactly like the
   * relation chips a projected record carries.
   *
   * loadRelatedBags() reads its input off `record.values[relationApiName]`,
   * which only exists after projection. Materialization runs before any
   * projection, so this reads the same edges straight from `record_links` and
   * hands loadRelatedBags the shape it already understands — rather than a
   * second bag-loading implementation that would drift from the read path's
   * select-label and soft-delete rules.
   *
   * One query per relation for the whole batch, matching loadRelatedBags' own
   * "never one query per record" property.
   */
  private async relationChipsFromLinks(
    defs: FieldDef[],
    relationApiNames: Set<string>,
    recordIds: string[],
  ): Promise<ProjectedRecord[]> {
    const byId = new Map<string, Record<string, unknown>>();
    for (const id of recordIds) byId.set(id, {});
    for (const apiName of relationApiNames) {
      const relationDef = defs.find((d) => d.api_name === apiName && d.type === 'relation');
      if (!relationDef) continue;
      const relationId = relationDef.config['relation_id'] as string | undefined;
      if (!relationId) continue;
      const side = relationDef.config['side'] as 'a' | 'b';
      const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
      const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
      const links = await this.db
        .select({ mine: myCol, other: otherCol })
        .from(recordLinks)
        .where(and(eq(recordLinks.relationId, relationId), inArray(myCol, recordIds)));
      for (const link of links) {
        const values = byId.get(link.mine);
        if (!values) continue;
        const chips = (values[apiName] as Array<{ id: string }> | undefined) ?? [];
        chips.push({ id: link.other });
        values[apiName] = chips;
      }
    }
    return [...byId.entries()].map(([id, values]) => ({ id, values }) as unknown as ProjectedRecord);
  }

  /**
   * #300 — the relation api_names a set of formula defs aggregates over, walked
   * through intermediate formulas so `{Total} * 2` (where Total is itself
   * `sum({Issues.Estimate})`) is recognised as needing the same related data.
   */
  private relationRefsOf(formulaDefs: FieldDef[], byApiName: Map<string, FieldDef>): Set<string> {
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (ast: FormulaNode | undefined) => {
      if (!ast) return;
      for (const apiName of formulaRefs(ast)) {
        const target = byApiName.get(apiName);
        if (!target) continue;
        if (target.type === 'relation') out.add(apiName);
        if (target.type === 'formula' && !seen.has(apiName)) {
          seen.add(apiName);
          walk(target.config['ast'] as FormulaNode | undefined);
        }
      }
    };
    for (const def of formulaDefs) walk(def.config['ast'] as FormulaNode | undefined);
    return out;
  }

  private async loadRelatedBags(
    projected: ProjectedRecord[],
    defs: FieldDef[],
    relationApiNames: Set<string>,
  ): Promise<Map<string, Record<string, Array<Record<string, unknown>>>>> {
    const out = new Map<string, Record<string, Array<Record<string, unknown>>>>();
    if (relationApiNames.size === 0 || projected.length === 0) return out;

    for (const apiName of relationApiNames) {
      const relationDef = defs.find((d) => d.api_name === apiName && d.type === 'relation');
      if (!relationDef) continue; // not a relation (or gone) — resolves to nothing

      // Every linked id on this page, deduplicated: two projects sharing an
      // issue read it once.
      const linkedIds = new Set<string>();
      for (const record of projected) {
        const chips = record.values[apiName] as Array<{ id: string }> | undefined;
        chips?.forEach((chip) => linkedIds.add(chip.id));
      }
      if (linkedIds.size === 0) continue;

      const relation = await this.db.query.relations.findFirst({
        where: eq(relations.id, relationDef.config['relation_id'] as string),
      });
      if (!relation) continue;
      const side = relationDef.config['side'] as 'a' | 'b';
      const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
      const targetDefs = await this.fieldDefs(targetDbId);

      // Formulas compare select LABELS, not option ids — same rule the
      // own-record bag follows below, so `{Issues.State} = "Done"` means what it
      // looks like.
      const selectDefs = targetDefs.filter((d) => d.type === 'select' || d.type === 'workflow');
      const labelByOption = new Map<string, string>();
      if (selectDefs.length > 0) {
        const options = await this.db.query.selectOptions.findMany({
          where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
        });
        for (const option of options) labelByOption.set(option.id, option.label);
      }

      const rows = await this.db.query.records.findMany({
        where: and(inArray(records.id, [...linkedIds]), isNull(records.deletedAt)),
      });
      const bagById = new Map<string, Record<string, unknown>>();
      for (const row of rows) {
        const stored = row.values as Record<string, unknown>;
        const bag: Record<string, unknown> = {};
        for (const def of targetDefs) {
          // `records.values` is keyed by FIELD ID; formulas address api_names.
          if (def.type === 'title') {
            bag[def.api_name] = row.title ?? null;
            continue;
          }
          let value = stored[def.id];
          if ((def.type === 'select' || def.type === 'workflow') && typeof value === 'string') {
            value = labelByOption.get(value) ?? value;
          }
          bag[def.api_name] = value ?? null;
        }
        bag['number'] = row.number ?? null;
        bagById.set(row.id, bag);
      }

      for (const record of projected) {
        const chips = record.values[apiName] as Array<{ id: string }> | undefined;
        if (!chips?.length) continue;
        // Soft-deleted targets simply drop out — the same way a dangling
        // reference resolves to nothing everywhere else.
        const bags = chips.map((chip) => bagById.get(chip.id)).filter((b): b is Record<string, unknown> => Boolean(b));
        const existing = out.get(record.id) ?? {};
        existing[apiName] = bags;
        out.set(record.id, existing);
      }
    }
    return out;
  }

  private async attachFormulas(projected: ProjectedRecord[], defs: FieldDef[]): Promise<ProjectedRecord[]> {
    const formulaDefs = defs.filter((d) => d.type === 'formula' && (d.config['ast'] as unknown));
    if (formulaDefs.length === 0 || projected.length === 0) return projected;

    // Formulas compare select LABELS, not option ids.
    const selectDefs = defs.filter((d) => d.type === 'select' || d.type === 'workflow');
    const labelByOption = new Map<string, string>();
    if (selectDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
      });
      for (const option of options) labelByOption.set(option.id, option.label);
    }

    // Topological order so formula-over-formula chains resolve (save-time cap = 5).
    const ordered = orderFormulasByDependency(formulaDefs);

    /*
     * #298 — collect every relation the page's formulas aggregate over, then
     * load them ONCE for the whole page before the per-record loop below. Doing
     * it inside that loop would be one query per record per relation, which is
     * the thing the AC forbids.
     */
    const relationApiNames = new Set<string>();
    const relationDefApiNames = new Set(defs.filter((d) => d.type === 'relation').map((d) => d.api_name));
    for (const def of ordered) {
      for (const ref of formulaRefs(def.config['ast'] as FormulaNode)) {
        if (relationDefApiNames.has(ref)) relationApiNames.add(ref);
      }
    }
    const relatedByRecord = await this.loadRelatedBags(projected, defs, relationApiNames);

    for (const record of projected) {
      const bag: Record<string, unknown> = { name: record.title };
      for (const def of defs) {
        // MN-129: the title lives in a column, not `values` — feed it under its own
        // api_name so name templates (`{Name}`, #130) resolve instead of clobbering
        // to null. Same for the #id below.
        if (def.type === 'title') {
          bag[def.api_name] = record.title ?? null;
          continue;
        }
        let value = record.values[def.api_name];
        if ((def.type === 'select' || def.type === 'workflow') && typeof value === 'string') {
          value = labelByOption.get(value) ?? value;
        }
        bag[def.api_name] = value ?? null;
      }
      // MN-129: the record's public #id lives in a column, not `values` — surface
      // it under both system handles so `{Number}`/`{ID}` resolve in formulas.
      bag.number = record.number ?? null;
      bag.id = record.number ?? null;
      const related = relatedByRecord.get(record.id);
      for (const def of ordered) {
        try {
          const result = evaluateFormula(def.config['ast'] as FormulaNode, bag, related);
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
   * — no lookup resolution, no related-record query. A formula that reaches
   * into a LOOKUP, or across a RELATION (#298's `count({Issues})`), would freeze
   * against a related record we don't have in hand at this record's own write
   * time; it's simply not written here and stays excluded from SORTABLE, rather
   * than materializing a value that's wrong from the start.
   *
   * ROLLUPS are the exception and are deliberately included (MN-267): they have
   * an invalidation subscriber that recomputes them when a related record or a
   * link set changes, so their materialized value does not go stale. This
   * comment used to say "lookup or rollup"; that stopped being true when MN-267
   * landed, and the code has been correct since.
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

    const selectDefs = defs.filter((d) => d.type === 'select' || d.type === 'workflow');
    const labelByOption = new Map<string, string>();
    if (selectDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
      });
      for (const option of options) labelByOption.set(option.id, option.label);
    }

    const ordered = orderFormulasByDependency(formulaDefs);

    /*
     * #300: the related records a relation aggregate reduces over. Loaded ONCE
     * for the whole batch, through the same loader the read path uses, so a
     * materialized `count({Issues})` and the value printed in the cell are
     * computed from identical data.
     *
     * This is what makes materializing a cross-record formula defensible at all.
     * #298 deliberately refused to: a value frozen at this record's own write
     * time is stale the moment a linked record changes. It is safe now for the
     * same reason a rollup's is — invalidateRollupsForChange recomputes it when
     * the related record or the link set changes.
     */
    const relationApiNames = this.relationRefsOf(formulaDefs, byApiName);
    let relatedByRecord = new Map<string, Record<string, Array<Record<string, unknown>>>>();
    if (relationApiNames.size > 0) {
      const chips = await this.relationChipsFromLinks(defs, relationApiNames, rows.map((r) => r.id));
      relatedByRecord = await this.loadRelatedBags(chips, defs, relationApiNames);
    }

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
          if (def.type === 'title') {
            bag[def.api_name] = row.title ?? null; // MN-129: title from its column, not `values`
            continue;
          }
          let value: unknown = def.type === 'rollup' ? computed[def.id] : stored[def.id];
          if ((def.type === 'select' || def.type === 'workflow') && typeof value === 'string') {
            value = labelByOption.get(value) ?? value;
          }
          bag[def.api_name] = value ?? null;
        }
        // MN-129: same as attachFormulas — the #id column feeds `{Number}`/`{ID}`.
        bag.number = row.number ?? null;
        bag.id = row.number ?? null;
        const patch: Record<string, unknown> = {};
        for (const def of ordered) {
          try {
            const result = evaluateFormula(
              def.config['ast'] as FormulaNode,
              bag,
              relatedByRecord.get(row.id),
            );
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
   * MN-130: the title field iff it's in computed-name mode with a compiled
   * template. When present, `records.title` is always derived (never the
   * user-supplied title) — see computeTitle / the create+update write paths.
   */
  private computedTitleDef(defs: FieldDef[]): FieldDef | null {
    const titleDef = defs.find((d) => d.type === 'title');
    if (!titleDef) return null;
    if ((titleDef.config['name_mode'] as string | undefined) !== 'computed') return null;
    if (!titleDef.config['ast']) return null;
    return titleDef;
  }

  /** Option-id → label map for a database's select fields (formula/title templates
   *  compare against the visible LABEL, not the stored option id). */
  private async loadSelectLabels(defs: FieldDef[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const selectDefs = defs.filter((d) => d.type === 'select' || d.type === 'workflow');
    if (selectDefs.length === 0) return map;
    const options = await this.db.query.selectOptions.findMany({
      where: inArray(selectOptions.fieldId, selectDefs.map((d) => d.id)),
    });
    for (const option of options) map.set(option.id, option.label);
    return map;
  }

  /**
   * MN-130: evaluate a computed-name template for one record and return the
   * string to store in `records.title`. `valuesById` is the record's field-id-
   * keyed `values` (the same shape materializeFormulas reads). `number` is the
   * record's already-allocated public #id, so a `{Number}`/#id template resolves
   * post-allocation. Never blank: an empty/whitespace result falls back to
   * `#<number>` so a record is never nameless.
   */
  private computeTitle(
    titleDef: FieldDef,
    defs: FieldDef[],
    valuesById: Record<string, unknown>,
    number: number | null,
    labelByOption: Map<string, string>,
    crossRecordByApiName?: Map<string, unknown>,
  ): string {
    const bag: Record<string, unknown> = {};
    for (const def of defs) {
      if (def.type === 'title') {
        bag[def.api_name] = null; // a {Name} self-ref is rejected at compile; never read here
        continue;
      }
      // #132: lookup/rollup/relation are cross-record — their value isn't in this
      // record's own `values`. A computed name may reference a lookup/rollup (its
      // related-record value is materialized ONTO this record); when resolved it
      // arrives via crossRecordByApiName (reactive recompute / read path).
      // Otherwise (own-record write path, or an unresolved ref) it's null. Direct
      // relation traversal is rejected at compile (#132), so relation stays null.
      if (def.type === 'lookup' || def.type === 'rollup' || def.type === 'relation') {
        bag[def.api_name] = crossRecordByApiName?.get(def.api_name) ?? null;
        continue;
      }
      let value: unknown = valuesById[def.id];
      if ((def.type === 'select' || def.type === 'workflow') && typeof value === 'string') {
        value = labelByOption.get(value) ?? value;
      }
      bag[def.api_name] = value ?? null;
    }
    bag.name = null;
    bag.number = number ?? null;
    bag.id = number ?? null;
    let result: unknown;
    try {
      result = evaluateFormula(titleDef.config['ast'] as FormulaNode, bag);
    } catch {
      result = null;
    }
    const text = result == null ? '' : String(result).trim();
    if (text.length > 0) return text;
    return number != null ? `#${number}` : '';
  }

  /**
   * MN-130: recompute every record's title for a database whose title field just
   * switched to (or changed its) computed-name template. Chunked to bound memory
   * on large databases; skips rows whose title is already correct. A no-op when
   * the title field isn't in computed mode.
   */
  async recomputeTitlesForAllRecords(databaseId: string): Promise<void> {
    const defs = await this.fieldDefs(databaseId);
    const titleDef = this.computedTitleDef(defs);
    if (!titleDef) return;
    const labelByOption = await this.loadSelectLabels(defs);
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
      await this.db.transaction(async (tx) => {
        for (const row of chunk) {
          const title = this.computeTitle(
            titleDef,
            defs,
            row.values as Record<string, unknown>,
            row.number,
            labelByOption,
          );
          if (title !== row.title) {
            await tx.update(records).set({ title }).where(eq(records.id, row.id));
          }
        }
      });
      cursor = chunk[chunk.length - 1]!.id;
      if (chunk.length < CHUNK) break;
    }
  }

  /**
   * #132: does this computed title's template reference a cross-record
   * lookup/rollup field? Own-record-only names (#130) never do, so their titles
   * are fully materialized synchronously in the write paths and need no reactive
   * pass — this gate keeps recomputeTitlesForRecords a fast no-op for them.
   */
  private titleReferencesCrossRecord(titleDef: FieldDef, defs: FieldDef[]): boolean {
    const byApi = new Map(defs.map((d) => [d.api_name, d]));
    return formulaRefs(titleDef.config['ast'] as FormulaNode).some((ref) => {
      const target = byApi.get(ref);
      return !!target && (target.type === 'lookup' || target.type === 'rollup');
    });
  }

  /**
   * #132: the reactive half of cross-record computed names — recompute
   * `records.title` for a bounded set of records whose computed name references
   * a lookup/rollup, after the RELATED record (or a link edge) changed. Hung off
   * the SAME MN-267 invalidation path as rollup materialization
   * (invalidateRollupsForChange), so a name that depends on another record's
   * value refreshes LIVE without the dependent record being re-saved.
   *
   * Resolves the lookup/rollup values fresh through attachLinks (the read-time
   * resolver, always current) rather than trusting anything persisted, then
   * writes back only titles that actually changed. A no-op unless the database's
   * title is in computed mode AND references a cross-record field. Chunked and
   * always invoked fire-and-forget by the subscriber, exactly like
   * recomputeRollupsForRelationField.
   */
  async recomputeTitlesForRecords(databaseId: string, recordIds: string[]): Promise<void> {
    if (recordIds.length === 0) return;
    const defs = await this.fieldDefs(databaseId);
    const titleDef = this.computedTitleDef(defs);
    if (!titleDef || !this.titleReferencesCrossRecord(titleDef, defs)) return;
    const labelByOption = await this.loadSelectLabels(defs);
    const crossRecordDefs = defs.filter((d) => d.type === 'lookup' || d.type === 'rollup');
    const CHUNK = 500;
    for (let i = 0; i < recordIds.length; i += CHUNK) {
      const chunkIds = recordIds.slice(i, i + CHUNK);
      const rows: RecordRow[] = await this.db.query.records.findMany({
        where: and(
          eq(records.databaseId, databaseId),
          inArray(records.id, chunkIds),
          isNull(records.deletedAt),
        ),
      });
      if (rows.length === 0) continue;
      // attachLinks resolves relation chips → lookups → rollups (read-time, fresh),
      // giving each record its current cross-record values keyed by api_name.
      const projected = await this.attachLinks(rows.map((r) => this.project(r, defs)), defs);
      const projectedById = new Map(projected.map((p) => [p.id, p]));
      await this.db.transaction(async (tx) => {
        for (const row of rows) {
          const p = projectedById.get(row.id);
          if (!p) continue;
          const crossRecord = new Map<string, unknown>();
          for (const def of crossRecordDefs) crossRecord.set(def.api_name, p.values[def.api_name] ?? null);
          const title = this.computeTitle(
            titleDef,
            defs,
            row.values as Record<string, unknown>,
            row.number,
            labelByOption,
            crossRecord,
          );
          if (title !== row.title) {
            await tx.update(records).set({ title }).where(eq(records.id, row.id));
          }
        }
      });
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
    const onThisRelation = defs.filter(
      (d) => d.type === 'rollup' && d.config['relation_field_id'] === relationFieldId,
    );
    const rollupDefs = onThisRelation.filter((d) => !isPickOneOp(d.config['op']));
    /*
     * #300: first/last rollups ARE materialized now. #286 shipped them read-time
     * only, which is why they could not be sorted or filtered — computed_values
     * was read through one numeric cast, and a pick-one value can be text, a
     * date, or a record chip.
     *
     * They travel the same invalidation path as the numeric ones (this method),
     * so a materialized winner cannot go stale: whatever change made the winner
     * change — an edit to a linked record, or a link added/removed — is exactly
     * what calls in here. What is stored is a SCALAR sort key, not the rich
     * value; the read path still returns the chip.
     */
    const pickOneDefs = onThisRelation.filter((d) => isPickOneOp(d.config['op']));
    /*
     * #300: this is also the link-change entry point for formula relation
     * aggregates, which need no rollup field to exist at all. Returning early on
     * "no rollups" left a database whose only cross-record field is a formula
     * with nothing recomputing it when a link was added or removed — the exact
     * staleness this ticket removes.
     */
    const hasFormulas = defs.some((d) => d.type === 'formula' && (d.config['ast'] as unknown));
    if (rollupDefs.length === 0 && pickOneDefs.length === 0 && !hasFormulas) return;

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
      for (const def of pickOneDefs) {
        const values = await this.computePickOneKeysForChunk(def, defs, chunk);
        for (const recordId of chunk) {
          const patch = patchByRecord.get(recordId) ?? {};
          // No winner is null — never 0. A pick-one has no "count" reading, and
          // 0 would sort as a real value below every genuine one.
          patch[def.id] = values.get(recordId) ?? null;
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

  /**
   * One grouped aggregate query per rollup field per chunk — never N+1 per record.
   *
   * MN-295: an optional `filter` on the rollup config is compiled (SAME
   * query-compiler.compileFilter as attachRollups/saved views) against the
   * RELATED database's fields and joined into the innerJoin's ON clause below,
   * so filtered-out related records never enter the aggregate — for `count`
   * as much as for sum/avg/min/max, which is why the relation lookup that used
   * to happen only in the non-count branch now happens up front whenever a
   * filter is present.
   */
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

    const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
    const filterNode = activeFilter(def.config['filter'] as FilterNode | undefined);

    let filterSql: SQL | undefined;
    let targetDefs: FieldDef[] | undefined;
    if (targetApiName || filterNode) {
      const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, relationId) });
      if (!relation) return result;
      const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
      targetDefs = await this.fieldDefs(targetDbId);
      if (filterNode) {
        const ctx: CompilerContext = {
          defs: new Map(targetDefs.map((d) => [d.api_name, d])),
          currentUserId: '', // rollup filters may not reference "me" (validated at field-create time)
        };
        filterSql = compileFilter(filterNode, ctx);
      }
    }

    if (op === 'count') {
      const rows = await this.db
        .select({ mine: myCol, n: sql<number>`count(*)` })
        .from(recordLinks)
        .innerJoin(records, and(eq(records.id, otherCol), isNull(records.deletedAt), filterSql))
        .where(and(eq(recordLinks.relationId, relationId), inArray(myCol, recordIds)))
        .groupBy(myCol);
      for (const r of rows) result.set(r.mine, Number(r.n));
      return result;
    }

    if (!targetApiName || !targetDefs) return result;
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
          filterSql,
        ),
      )
      .where(and(eq(recordLinks.relationId, relationId), inArray(myCol, recordIds)))
      .groupBy(myCol);
    for (const r of rows) result.set(r.mine, r.v === null ? null : Number(r.v));
    return result;
  }

  /**
   * #300 — the pick-one winner's SORT KEY for a chunk of parent records.
   *
   * The write-side twin of attachPickOneRollup. It resolves the winner by the
   * same rules — same pickOneRow, same rollupFieldValue, same option labels,
   * same optional filter — because two implementations of "which linked record
   * wins" would eventually disagree, and a sort that disagrees with the value
   * printed in the cell is worse than no sort at all.
   *
   * It differs in exactly one respect: the read path already has each parent's
   * relation chips in hand, while this runs before any projection, so the links
   * are read from `record_links` directly. One query for the whole chunk.
   */
  private async computePickOneKeysForChunk(
    def: FieldDef,
    defs: FieldDef[],
    recordIds: string[],
  ): Promise<Map<string, string | number | boolean | null>> {
    const result = new Map<string, string | number | boolean | null>();
    const op = def.config['op'];
    if (!isPickOneOp(op)) return result;
    const relationDef = defs.find((d) => d.id === def.config['relation_field_id']);
    if (!relationDef || relationDef.type !== 'relation') return result; // dangling
    const orderByApiName = def.config['order_by_field_api_name'] as string | undefined | null;
    if (!orderByApiName) return result; // config invariant, enforced at field-create time
    const targetApiName = def.config['target_field_api_name'] as string | undefined | null;
    const filterNode = activeFilter(def.config['filter'] as FilterNode | undefined);

    const side = relationDef.config['side'] as 'a' | 'b';
    const relation = await this.db.query.relations.findFirst({
      where: eq(relations.id, relationDef.config['relation_id'] as string),
    });
    if (!relation) return result;
    const targetDbId = side === 'a' ? relation.databaseBId : relation.databaseAId;
    const storedDefs = await this.fieldDefs(targetDbId);
    // #351 overlay, same as the read path — ordering by the public #id is the
    // headline case and `number` has no stored fields row.
    const targetDefs = [...storedDefs, ...systemFieldDefsFor(storedDefs.map((d) => d.api_name))];
    const orderByDef = targetDefs.find((d) => d.api_name === orderByApiName);
    if (!orderByDef) return result; // ordering field deleted — no defensible winner
    const targetDef = targetApiName ? targetDefs.find((d) => d.api_name === targetApiName) : undefined;
    if (targetApiName && !targetDef) return result;

    const labelledDefs = [orderByDef, targetDef].filter(
      (d): d is FieldDef => !!d && ['select', 'workflow', 'multi_select'].includes(d.type),
    );
    const optionLabels = new Map<string, string>();
    if (labelledDefs.length > 0) {
      const options = await this.db.query.selectOptions.findMany({
        where: inArray(selectOptions.fieldId, labelledDefs.map((d) => d.id)),
      });
      for (const option of options) optionLabels.set(option.id, option.label);
    }

    const myCol = side === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
    const otherCol = side === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
    const links = await this.db
      .select({ mine: myCol, other: otherCol })
      .from(recordLinks)
      .where(and(eq(recordLinks.relationId, relation.id), inArray(myCol, recordIds)));
    if (links.length === 0) return result;

    const conditions = [inArray(records.id, [...new Set(links.map((l) => l.other))]), isNull(records.deletedAt)];
    if (filterNode) {
      const ctx: CompilerContext = {
        defs: new Map(targetDefs.map((d) => [d.api_name, d])),
        currentUserId: '', // rollup filters may not reference "me" (validated at field-create time)
      };
      conditions.push(compileFilter(filterNode, ctx));
    }
    const targetRows = await this.db.query.records.findMany({ where: and(...conditions) });
    const rowById = new Map(targetRows.map((row) => [row.id, row]));

    const candidatesByParent = new Map<string, Array<(typeof targetRows)[number]>>();
    for (const link of links) {
      // A link whose row is missing here was filtered out or deleted — both mean
      // "not a candidate", exactly as on the read path.
      const row = rowById.get(link.other);
      if (!row) continue;
      const list = candidatesByParent.get(link.mine) ?? [];
      list.push(row);
      candidatesByParent.set(link.mine, list);
    }

    for (const [parentId, candidates] of candidatesByParent) {
      const winner = pickOneRow(candidates, op, (row) => rollupFieldValue(row, orderByDef, optionLabels));
      if (!winner) continue;
      const value = targetDef
        ? rollupFieldValue(winner, targetDef, optionLabels)
        : { id: winner.id, title: winner.title, number: winner.number, database_id: targetDbId };
      result.set(parentId, pickOneSortKey(value));
    }
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
   *      target OR — MN-295 — referenced by its filter, since a filtered
   *      aggregate's result can flip when a filtered-on field changes even
   *      with no link change), recomputes that rollup for whichever
   *      other-side records are CURRENTLY linked to `recordId`.
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
    /** #132: this record's title changed — a lookup/rollup targeting the title
     * (target_field_api_name = the title field's api_name) must invalidate too. */
    titleChanged?: boolean;
    linkedRelations?: Array<{ relationId: string; fieldId: string; otherDatabaseId: string; otherRecordIds: string[] }>;
  }): Promise<void> {
    if (event.changedFieldIds?.length || event.titleChanged) {
      // target_field_api_name (rollup config) is an api_name; changedFieldIds are
      // field ids (Object.keys(diff) in update()) — resolve ids to api_names on
      // THIS database once, up front, so the per-relation filter below compares
      // like with like instead of an id against a name that never matches.
      const myDefs = await this.fieldDefs(event.databaseId);
      const idToApiName = new Map(myDefs.map((d) => [d.id, d.api_name]));
      const changedApiNames = new Set(
        (event.changedFieldIds ?? []).map((id) => idToApiName.get(id)).filter((n): n is string => !!n),
      );
      // #132: a title change surfaces as the title field's api_name (e.g. `name`)
      // so a cross-record name that looks up this record's TITLE recomputes. This
      // can't false-cascade a rollup — a rollup's target is a number field, never
      // the title — so it's safe to fold into the same set.
      if (event.titleChanged) {
        const titleApiName = myDefs.find((d) => d.type === 'title')?.api_name;
        if (titleApiName) changedApiNames.add(titleApiName);
      }
      const rels = await this.db.query.relations.findMany({
        where: or(eq(relations.databaseAId, event.databaseId), eq(relations.databaseBId, event.databaseId)),
      });
      for (const rel of rels) {
        const mySide: 'a' | 'b' = rel.databaseAId === event.databaseId ? 'a' : 'b';
        const otherDbId = mySide === 'a' ? rel.databaseBId : rel.databaseAId;
        const reverseFieldId = mySide === 'a' ? rel.fieldBId : rel.fieldAId;
        const otherDefs = await this.fieldDefs(otherDbId);
        const relevantRollups = otherDefs.filter((d) => {
          if (d.type !== 'rollup' || d.config['relation_field_id'] !== reverseFieldId) return false;
          if (d.config['op'] === 'count') return true; // link-membership rollup — safe (if redundant) to always recompute
          if (changedApiNames.has(d.config['target_field_api_name'] as string)) return true;
          // MN-295: a filtered sum/avg/min/max also needs recompute when the
          // changed field is one the filter reads, not just the target field.
          const filterNode = activeFilter(d.config['filter'] as FilterNode | undefined);
          if (!filterNode) return false;
          return [...filterReferencedFields(filterNode)].some((f) => changedApiNames.has(f));
        });
        // #132: the other side's computed name may depend on this change too —
        // either through a rollup we're about to recompute, or through a lookup
        // that reads the very field that changed. Compute this alongside the
        // rollup set so a single linked-ids fetch feeds both cascades.
        const otherTitleDef = this.computedTitleDef(otherDefs);
        const titleAffected =
          !!otherTitleDef &&
          this.titleAffectedByRelatedChange(otherTitleDef, otherDefs, reverseFieldId, changedApiNames, relevantRollups);
        /*
         * #300: a formula relation aggregate on the OTHER side reads this
         * record through the reverse field, so a change here can move it just
         * as it moves a rollup. Without this the materialized sort key would
         * only refresh the next time that record happened to be written — which
         * is precisely the staleness #298 refused to accept.
         *
         * Deliberately coarse: any formula aggregating over this relation is
         * recomputed, without checking WHICH related field the formula reads.
         * A rollup names one target field so it can be precise; a formula can
         * read several fields plus a condition over several more, and a filter
         * that under-matches leaves a wrong number on screen — the failure this
         * whole ticket exists to prevent. Over-recomputing is bounded by the
         * same chunked fan-out and costs a query.
         */
        const formulaAggregateAffected = otherDefs.some(
          (d) =>
            d.type === 'formula' &&
            (d.config['ast'] as unknown) &&
            [...this.relationRefsOf([d], new Map(otherDefs.map((x) => [x.api_name, x])))].some(
              (apiName) => otherDefs.find((x) => x.api_name === apiName)?.id === reverseFieldId,
            ),
        );
        if (relevantRollups.length === 0 && !titleAffected && !formulaAggregateAffected) continue;

        const myCol = mySide === 'a' ? recordLinks.fromRecordId : recordLinks.toRecordId;
        const otherCol = mySide === 'a' ? recordLinks.toRecordId : recordLinks.fromRecordId;
        const links = await this.db
          .select({ other: otherCol })
          .from(recordLinks)
          .where(and(eq(recordLinks.relationId, rel.id), eq(myCol, event.recordId)));
        const otherIds = links.map((l) => l.other);
        if (otherIds.length === 0) continue;
        if (relevantRollups.length > 0) await this.recomputeRollupsForRelationField(otherDbId, reverseFieldId, otherIds);
        if (titleAffected) await this.recomputeTitlesForRecords(otherDbId, otherIds);
        // #300: recomputeRollupsForRelationField re-materializes formulas as its
        // last step, so this only needs to run when it did NOT run at all.
        if (formulaAggregateAffected && relevantRollups.length === 0) {
          const freshRows = await this.db.query.records.findMany({ where: inArray(records.id, otherIds) });
          await this.materializeFormulas(otherDefs, freshRows).catch(() => undefined);
        }
      }
    }

    for (const link of event.linkedRelations ?? []) {
      await this.recomputeRollupsForRelationField(event.databaseId, link.fieldId, [event.recordId]);
      // #132: this record's OWN link-set changed, so its computed name (if it
      // references a lookup/rollup through this relation) may have changed too —
      // recompute it alongside its own rollup.
      await this.recomputeTitlesForRecords(event.databaseId, [event.recordId]);
      if (link.otherRecordIds.length === 0) continue;
      const relation = await this.db.query.relations.findFirst({ where: eq(relations.id, link.relationId) });
      if (!relation) continue;
      const reverseFieldId = relation.fieldAId === link.fieldId ? relation.fieldBId : relation.fieldAId;
      await this.recomputeRollupsForRelationField(link.otherDatabaseId, reverseFieldId, link.otherRecordIds);
      // #132: and the other side's names, if THEY look back through the reverse field.
      await this.recomputeTitlesForRecords(link.otherDatabaseId, link.otherRecordIds);
    }
  }

  /**
   * #132: is `otherDb`'s computed name affected by a related record's field
   * change coming through `reverseFieldId`? Either (a) the name references a
   * rollup we're already recomputing for this change, or (b) it references a
   * lookup that reads through this relation whose target field is one that
   * changed. Anything else is not a false cascade to trigger.
   */
  private titleAffectedByRelatedChange(
    titleDef: FieldDef,
    defs: FieldDef[],
    reverseFieldId: string,
    changedApiNames: Set<string>,
    relevantRollups: FieldDef[],
  ): boolean {
    const refs = new Set(formulaRefs(titleDef.config['ast'] as FormulaNode));
    if (relevantRollups.some((r) => refs.has(r.api_name))) return true;
    const byApi = new Map(defs.map((d) => [d.api_name, d]));
    for (const ref of refs) {
      const target = byApi.get(ref);
      if (
        target?.type === 'lookup' &&
        target.config['relation_field_id'] === reverseFieldId &&
        changedApiNames.has(target.config['target_field_api_name'] as string)
      ) {
        return true;
      }
    }
    return false;
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
    /*
     * #203 — field defaults are applied BEFORE validation, so a default goes
     * through exactly the same checks as a caller-supplied value; a
     * misconfigured default fails loudly here instead of landing as an
     * unvalidated value in the row.
     *
     * One `now` for the whole batch: importing 500 rows should stamp one
     * creation date, not a spread across however long the insert took.
     */
    const now = new Date();
    const withDefaults = inputs.map((input) => applyFieldDefaults(defs, input, now));
    // MN-118: people resolve to real ids before validation, so a name can never be
    // stored verbatim and reported as success.
    const resolved = await Promise.all(
      withDefaults.map((input) => this.resolveUserInputs(workspaceId, defs, input)),
    );
    const validated = resolved.map((input) => this.validateOrThrow(defs, input));
    // Resolved up front: an unknown target must fail before any record is inserted.
    const linkPlans = await Promise.all(
      validated.map((v) => (v.links ? this.planLinks(defs, v.links) : Promise.resolve([]))),
    );
    const positions = await keysAfter(await this.lastPosition(databaseId), inputs.length);

    // MN-130: when the title is a computed name, it's derived from each record's
    // own values + its public #id — never the caller-supplied title. Prepared
    // here so the compute inside the transaction (post-number-allocation) is
    // synchronous; a no-op (null) leaves the classic freetext title untouched.
    const titleDef = this.computedTitleDef(defs);
    const labelByOption = titleDef ? await this.loadSelectLabels(defs) : new Map<string, string>();

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
          validated.map((v, i) => {
            const values = stripNulls(v.values);
            // #id-post-allocation: firstNumber+i is this record's public number,
            // already allocated above, so a `{Number}`/#id template resolves.
            const title = titleDef
              ? this.computeTitle(titleDef, defs, values, firstNumber + i, labelByOption)
              : v.title ?? '';
            return {
              databaseId,
              number: firstNumber + i,
              title,
              values,
              position: positions[i]!,
              createdBy: actorId,
              updatedBy: actorId,
            };
          }),
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

  async get(databaseId: string, recordId: string, membership?: Membership): Promise<ProjectedRecord> {
    const [row, defs] = await Promise.all([
      this.getRow(databaseId, recordId),
      this.fieldDefs(databaseId),
    ]);
    const [projected] = await this.attachLinks([this.project(row, defs)], defs, membership);
    return projected!;
  }

  /** Resolve a record by its public per-database number (MN-087, pretty URLs). */
  async getByNumber(databaseId: string, number: number, membership?: Membership): Promise<ProjectedRecord> {
    const row = await this.db.query.records.findFirst({
      where: and(eq(records.databaseId, databaseId), eq(records.number, number), isNull(records.deletedAt)),
    });
    if (!row) throw new NotFoundException('Record not found');
    const defs = await this.fieldDefs(databaseId);
    const [projected] = await this.attachLinks([this.project(row, defs)], defs, membership);
    return projected!;
  }

  async update(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    input: Record<string, unknown>,
    actorId: string,
    depth = 0,
    /**
     * #390 — WHAT made this change: typed by a person, generated by an agent,
     * fired by an automation, or written over MCP.
     *
     * An explicit argument, never sniffed from inside the writer. A writer that
     * guesses its own caller is the thing that goes quietly wrong when a fifth
     * caller appears; an argument makes a new call site CHOOSE, and makes
     * forgetting visible in review.
     *
     * Defaults to `human` deliberately. A missing source must not become
     * `unknown`: the overwhelming majority of writes really are human, and an
     * `unknown` bucket would grow silently and mean nothing.
     *
     * This is the SECOND axis, not a replacement for the first. `actorUserId`
     * stays the person in every case (ADR-0010 §2, and #357's founder decision:
     * "it's always a person that ran the AI agent, never the agent himself").
     * A fix that set `actorUserId` to an agent id would satisfy a naive reading
     * of "distinguish agent writes" and destroy the accountability trail.
     */
    source: ChangeSource = 'human',
  ): Promise<ProjectedRecord> {
    const defs = await this.fieldDefs(databaseId);
    const row = await this.getRow(databaseId, recordId);
    const validated = this.validateOrThrow(
      defs,
      await this.resolveUserInputs(workspaceId, defs, input),
    );
    /*
     * #391 — an attachment value may only point at files already on THIS record
     * and THIS field. Checked before the transaction, for the same reason link
     * targets are: a forged id must be a clean 422, not a half-applied write.
     *
     * Files arrive through the upload endpoint, which checks access on the way
     * in. This value can reorder or remove; it can never introduce.
     */
    for (const def of defs.filter((d) => d.type === 'attachment')) {
      const next = validated.values[def.id];
      if (Array.isArray(next)) {
        await assertOwnedAttachments(this.db, recordId, def.id, next.map(String));
      }
    }
    // MN-080: resolved before the transaction — a bad target must not half-apply.
    const linkPlans = validated.links ? await this.planLinks(defs, validated.links) : [];
    // #31: resolved OUTSIDE the transaction — a plan lookup must not hold a row
    // lock, and it cannot change mid-write. 0 ⇒ Free ⇒ capture nothing.
    const historyDays = await this.historyRetentionDays(workspaceId);

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
    // MN-130: a computed name is read-only — a direct title write is ignored,
    // and the title is re-derived from the (now merged) values whenever a
    // referenced field changed. When there's no value diff, no referenced field
    // moved, so the title can't have changed either (skip the recompute).
    const titleDef = this.computedTitleDef(defs);
    let nextTitle = row.title;
    if (titleDef) {
      if (Object.keys(diff).length > 0) {
        const labelByOption = await this.loadSelectLabels(defs);
        nextTitle = this.computeTitle(titleDef, defs, merged, row.number, labelByOption);
        if (nextTitle !== row.title) diff['title'] = { from: row.title, to: nextTitle };
      }
    } else {
      nextTitle = validated.title ?? row.title;
      if (validated.title !== undefined && validated.title !== row.title) {
        diff['title'] = { from: row.title, to: validated.title };
      }
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
        .set({ values: merged, title: nextTitle, updatedBy: actorId })
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
        /*
         * #31 (C2) — fan the SAME diff out to one row per changed field.
         *
         * record_versions above answers "what did this record look like then".
         * This answers "who changed the status, and from what" — the question
         * the history UI is actually built around. Same transaction, so a
         * captured change always corresponds to a write that landed.
         *
         * `historyDays === 0` is Free: capture NOTHING rather than
         * capture-then-prune. The window is zero, so those rows could never be
         * read by anyone — pure write amplification plus pruning load
         * (docs/architecture/version-history.md, "Retention").
         */
        if (historyDays > 0) {
          const rows = Object.entries(diff).map(([key, change]) => ({
            workspaceId,
            databaseId,
            recordId,
            // record-diff.ts denotes the promoted title column with the literal
            // "title"; the table stores that as a null field_id.
            fieldId: key === 'title' ? null : key,
            actorUserId: actorId,
            /*
             * Explicitly JSON-encoded so a bare scalar can't be re-parsed as
             * JSON source text on its way into jsonb. What is stored here is
             * exactly what the WRITE stored — note the record READ path coerces
             * some values (a text field holding 3 reads back as "3"), so the
             * timeline and the record can render the same change differently.
             * That is a presentation gap for the history UI to close (#335),
             * not a reason to make capture lie about what was written.
             */
            oldValue: sql`${JSON.stringify((change as { from: unknown }).from ?? null)}::jsonb`,
            newValue: sql`${JSON.stringify((change as { to: unknown }).to ?? null)}::jsonb`,
            /*
             * #390 — the column and the enum have existed since #31; nothing
             * ever wrote a non-default value, so every row in the product said
             * 'human' including rows written by automations and by MCP. The
             * badge was decorative: it rendered whatever the default said.
             */
            source,
          }));
          if (rows.length > 0) await tx.insert(recordFieldChanges).values(rows);
        }
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
    // #132: a computed name that references a lookup/rollup can't be resolved by
    // the synchronous computeTitle above (it only sees own-record values, so the
    // cross-record part comes out null) — re-derive it here off the committed
    // links. A no-op unless the name is computed AND cross-record; awaited (like
    // the formula materialize) so a read right after this update sees the fresh
    // title, isolated so it never fails the write.
    if (titleDef && this.titleReferencesCrossRecord(titleDef, defs)) {
      await this.recomputeTitlesForRecords(databaseId, [recordId]).catch(() => undefined);
    }

    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId,
      recordId,
      changedFieldIds: Object.keys(diff).filter((k) => k !== 'title'),
      changedValues: diff, // #273 — feeds the {changesSummary} automation token
      titleChanged: diff['title'] !== undefined, // #132: drives cross-record name recompute for records that look this up
      actorId,
      depth,
      linkedRelations: linkedRelations.length ? linkedRelations : undefined,
    });

    /*
     * #324 — a relation set INLINE on a record update now also fires
     * `record_linked` rules, exactly as the dedicated Links API does.
     *
     * Before this, the same user action fired a rule or didn't depending on
     * which path the UI happened to take, which is invisible from the screen —
     * so "when a sub-task is attached, comment on the parent" looked flaky.
     * Rollups already treated both paths identically, so automations diverging
     * was an inconsistency rather than a design.
     *
     * One event PER relation, because `relationFieldId` is what the trigger
     * filters on and what {linked.Field} resolves through. Marked
     * derivedAlreadyHandled so the rollup cascade — which consumes both event
     * types — does not run twice for one edit.
     *
     * Direction is always 'link' here: `linkedRelations` on this path carries
     * the ids that ended up ATTACHED. An inline write that removes links is a
     * set-operation with no single direction, which is exactly the case #270
     * already leaves undefined.
     */
    for (const link of linkedRelations) {
      if (link.otherRecordIds.length === 0) continue;
      this.domainEvents.emit({
        type: 'record_linked',
        workspaceId,
        databaseId,
        recordId,
        relationFieldId: link.fieldId,
        linkDirection: 'link',
        linkedRelations: [link],
        actorId,
        depth,
        derivedAlreadyHandled: true,
      });
    }

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
    // #172: a workflow (status) change pings assignees just like any select change.
    const changedSelects = defs.filter((d) => (d.type === 'select' || d.type === 'workflow') && d.id in diff);
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

    // #236 — anyone WATCHING this record hears about ANY change (not only
    // assignees on a select change), carrying a "what changed" summary. Never
    // fails the write.
    await this.notifyWatchers(workspaceId, databaseId, recordId, actorId, defs, before, merged, diff).catch(() =>
      undefined,
    );
    return this.project(updated, defs);
  }

  // ── watch / subscribe (#236) ─────────────────────────────────────────────

  /** Subscribe the user to this record's changes (idempotent). */
  async watch(workspaceId: string, recordId: string, userId: string): Promise<{ watching: true }> {
    await this.db
      .insert(recordWatchers)
      .values({ workspaceId, recordId, userId })
      .onConflictDoNothing();
    return { watching: true };
  }

  /** Unsubscribe the user (idempotent). */
  async unwatch(recordId: string, userId: string): Promise<{ watching: false }> {
    await this.db
      .delete(recordWatchers)
      .where(and(eq(recordWatchers.recordId, recordId), eq(recordWatchers.userId, userId)));
    return { watching: false };
  }

  /** The record's watchers + whether the caller is one (for the watch toggle UI). */
  async listWatchers(recordId: string, callerId: string): Promise<{ watching: boolean; watchers: string[] }> {
    const rows = await this.db.query.recordWatchers.findMany({
      where: eq(recordWatchers.recordId, recordId),
      columns: { userId: true },
    });
    const watchers = rows.map((r) => r.userId);
    return { watching: watchers.includes(callerId), watchers };
  }

  /** #236 — fan a `record_changed` notification out to every watcher (minus the
   * actor), with a resolved "what changed" summary as the snippet. */
  private async notifyWatchers(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    actorId: string,
    defs: FieldDef[],
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    diff: Record<string, unknown>,
  ): Promise<void> {
    const rows = await this.db.query.recordWatchers.findMany({
      where: eq(recordWatchers.recordId, recordId),
      columns: { userId: true },
    });
    const recipients = rows.map((r) => r.userId).filter((id) => id !== actorId);
    if (recipients.length === 0) return;

    const summary = await this.renderChangeSummary(
      databaseId,
      Object.fromEntries(
        Object.keys(diff)
          .filter((k) => k !== 'title')
          .map((id) => [id, { from: before[id], to: after[id] }]),
      ),
      defs,
    );

    await this.notificationsService.notify({
      workspaceId,
      databaseId,
      recordId,
      actorId,
      type: 'record_changed',
      recipients,
      snippet: summary || undefined,
    });
  }

  /**
   * #236/#273 — render a human "Field: from → to · …" line for a set of changed
   * values (keyed by field id, as `RecordsService.update()`'s own diff is). Shared
   * by the watcher notification (#236) and the `{changesSummary}` automation token
   * (#273) so both read identically. `defs` is optional — pass it when the caller
   * already has them to save a lookup.
   */
  async renderChangeSummary(
    databaseId: string,
    changedValues: Record<string, { from: unknown; to: unknown }>,
    defs?: FieldDef[],
  ): Promise<string> {
    const changedIds = Object.keys(changedValues).filter((k) => k !== 'title');
    if (changedIds.length === 0) return '';
    const allDefs = defs ?? (await this.fieldDefs(databaseId));
    const changedDefs = allDefs.filter((d) => changedIds.includes(d.id));
    if (changedDefs.length === 0) return '';

    const nameRows = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), inArray(fields.id, changedDefs.map((d) => d.id))),
      columns: { id: true, displayName: true },
    });
    const nameById = new Map(nameRows.map((r) => [r.id, r.displayName]));
    const optionFieldIds = changedDefs
      .filter((d) => d.type === 'select' || d.type === 'workflow' || d.type === 'multi_select')
      .map((d) => d.id);
    const optionLabels = new Map<string, string>();
    if (optionFieldIds.length) {
      const opts = await this.db.query.selectOptions.findMany({ where: inArray(selectOptions.fieldId, optionFieldIds) });
      for (const o of opts) optionLabels.set(o.id, o.label);
    }
    const changed: ChangeSummaryField[] = changedDefs.map((d) => ({
      id: d.id,
      label: nameById.get(d.id) ?? d.api_name,
      type: d.type,
    }));
    const before = Object.fromEntries(changedIds.map((id) => [id, changedValues[id]!.from]));
    const after = Object.fromEntries(changedIds.map((id) => [id, changedValues[id]!.to]));
    return summarizeChanges(changed, before, after, optionLabels);
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
   * #31 (C2) — the per-record FIELD timeline: who changed what, from what, when.
   *
   * Sibling to listVersions() and deliberately separate: that one answers "what
   * did this record look like then" (whole snapshots, for restore); this one
   * answers "who changed the status, and from what" (per-field events, for
   * reading). Same cursor scheme so the two paginate identically.
   *
   * Field ids are resolved to display names here rather than in the UI, so a
   * DELETED field still renders as something a human can read instead of a bare
   * uuid — the history of a field outliving the field is the whole point.
   */
  async listFieldChanges(databaseId: string, recordId: string, limit: number, cursor?: string) {
    const conditions = [eq(recordFieldChanges.recordId, recordId)];
    if (cursor) {
      const created = new Date(Buffer.from(cursor, 'base64url').toString());
      if (!Number.isNaN(created.getTime())) conditions.push(lt(recordFieldChanges.createdAt, created));
    }
    const rows = await this.db.query.recordFieldChanges.findMany({
      where: and(...conditions),
      orderBy: [desc(recordFieldChanges.createdAt)],
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;

    /*
     * #335 — the same resolution the activity feed already did.
     *
     * Include soft-deleted fields: a change to a field someone later removed is
     * still real history, and rendering it as a uuid would be useless. Since
     * #335 that also covers select OPTION ids, which capture stores raw (and
     * must — a change log that echoed a projection would be recording something
     * other than what the write stored).
     *
     * `old_value`/`new_value` stay exactly as captured. `old_display`/
     * `new_display` are the same values rendered, and `field_type` lets a client
     * render per type without re-fetching a schema that may no longer contain
     * the field at all. That is what #335's "project the values or hand the UI
     * enough type information" asks for; this does both, and keeps the faithful
     * pair so nothing is lost.
     */
    const ctx = await buildRenderContext(this.db, databaseId);

    return {
      data: page.map((c) => ({
        id: c.id,
        field_id: c.fieldId,
        // null field_id is the promoted title column (record-diff.ts's "title").
        field_name: c.fieldId ? ctx.fieldName.get(c.fieldId) ?? '(deleted field)' : 'Name',
        field_type: c.fieldId ? ctx.fieldType.get(c.fieldId) ?? null : 'title',
        actor_id: c.actorUserId,
        source: c.source,
        old_value: c.oldValue,
        new_value: c.newValue,
        old_display: renderTypedValue(c.oldValue, c.fieldId ? ctx.fieldType.get(c.fieldId) : 'title', ctx),
        new_display: renderTypedValue(c.newValue, c.fieldId ? ctx.fieldType.get(c.fieldId) : 'title', ctx),
        created_at: c.createdAt,
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
    // MN-130: a computed name is always derived — restore the snapshot's values,
    // but re-derive the title from them rather than trusting the snapshot's
    // (possibly pre-computed-mode) stored title.
    const titleDef = this.computedTitleDef(defs);
    if (titleDef) {
      const labelByOption = await this.loadSelectLabels(defs);
      target.title = this.computeTitle(titleDef, defs, target.values, row.number, labelByOption);
    }
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
    // #132: re-derive a cross-record computed name off the restored record's
    // committed links (the synchronous computeTitle above resolved only its
    // own-record part). No-op unless the name is computed AND cross-record.
    if (titleDef && this.titleReferencesCrossRecord(titleDef, defs)) {
      await this.recomputeTitlesForRecords(databaseId, [recordId]).catch(() => undefined);
    }

    this.domainEvents.emit({
      type: 'record_updated',
      workspaceId,
      databaseId,
      recordId,
      changedFieldIds: Object.keys(diff).filter((k) => k !== 'title'),
      changedValues: diff, // #273 — feeds the {changesSummary} automation token
      titleChanged: diff['title'] !== undefined, // #132: restore may change the title too
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

  async softDelete(
    workspaceId: string,
    databaseId: string,
    recordId: string,
    actorId: string,
    depth = 0,
  ) {
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
    this.domainEvents.emit({
      type: 'record_deleted',
      workspaceId,
      databaseId,
      recordId,
      actorId,
      depth,
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
      ids.forEach((recordId) =>
        this.domainEvents.emit({
          type: 'record_deleted',
          workspaceId,
          databaseId,
          recordId,
          actorId,
          depth: 0,
        }),
      );
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
    /*
     * #406 — `number` is returned, not just id/title.
     *
     * /records/by-number filters `deletedAt IS NULL`, so once a record is in the
     * trash its public number resolves to a 404 everywhere. Without the number
     * here there was no path from "restore #42" to a record id at all — the id
     * only existed in a response nobody had a reason to keep. The restore
     * endpoints take uuids; this is what lets a caller find the uuid.
     */
    return rows.map((r) => ({ id: r.id, number: r.number, title: r.title, deleted_at: r.deletedAt }));
  }

  /**
   * The workhorse: POST /records/query (MN-012). Filter AST → SQL via the
   * compiler; multi-key sorts with NULLS FIRST/LAST (MN-252 — `input.nulls`,
   * default 'last'); keyset cursors with id tiebreaker; no sorts = manual
   * (position) order.
   */
  /**
   * Count or aggregate WITHOUT pulling rows (#404).
   *
   * "How many contacts do we have?" was answered by fetching every row and
   * counting them in the model's head. On a 148-row x 22-column database that
   * produced 136,922 tokens against a 128,000-token window and simply failed —
   * and the shape is wrong twice over even when it fits:
   *
   *  1. A whole table crosses the context window to compute a single integer.
   *  2. It can only count what fits in ONE PAGE. If the query paginates, the
   *     model counts page one and reports it as the total — a confidently wrong
   *     number, which is #401's failure arriving by a different route.
   *
   * A bigger model does not fix this. The growth is in the DATA, so any fixed
   * window loses eventually; the shape has to change, not the ceiling.
   *
   * The filter is compiled by the SAME `compileFilter` the query path uses. That
   * is the point: a filtered count has to mean exactly what a filtered query
   * means, or the two disagree and the count becomes another thing nobody can
   * trust. Reimplementing the predicate here would be a second copy of the
   * hardest rule in the file.
   *
   * `count` needs no field. Every other op aggregates the numeric values of a
   * target field, in SQL, matching the rollup engine's semantics: non-numeric
   * and absent values are skipped rather than counted as zero, because a zero
   * would silently drag an average down.
   */
  async aggregate(
    databaseId: string,
    input: { op: 'count' | 'sum' | 'avg' | 'min' | 'max'; field?: string; filter?: unknown; q?: string },
    currentUserId: string,
  ): Promise<{
    op: string;
    field: string | null;
    value: number | null;
    filtered: boolean;
    /**
     * #360a — this number is EXACT, and that claim travels as data.
     *
     * "Here are 4 that look relevant" and "there are exactly 4" are different
     * claims, and a user cannot tell them apart unless we say which one they
     * got. The AC is explicit that it must be a FIELD rather than a phrasing
     * instruction: a model told to caveat its answers will sometimes forget, and
     * the one time it forgets is indistinguishable from a wrong count.
     *
     * Always true here, because this endpoint counts in SQL over the whole
     * matching set — there is no sampling and no pagination to be wrong about.
     * It is stated anyway rather than left implicit, so that when the semantic
     * half (#421) lands it returns the same SHAPE with `exact: false`, and a
     * caller reads one field instead of knowing which endpoint it called.
     */
    exact: true;
  }> {
    const defs = await this.fieldDefs(databaseId);
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    for (const def of systemFieldDefsFor(byApiName.keys())) byApiName.set(def.api_name, def);

    const conditions: unknown[] = [eq(records.databaseId, databaseId), isNull(records.deletedAt)];
    if (input.q) conditions.push(sql`${records.title} ILIKE ${'%' + input.q + '%'}`);
    if (input.filter) {
      conditions.push(compileFilter(input.filter as FilterNode, { defs: byApiName, currentUserId }));
    }
    const where = and(...(conditions as SQL[]));

    if (input.op === 'count') {
      const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(records).where(where);
      return { op: 'count', field: null, value: row?.value ?? 0, filtered: Boolean(input.filter || input.q), exact: true };
    }

    if (!input.field) {
      throw new UnprocessableEntityException(`"${input.op}" needs a field to aggregate; only "count" works without one`);
    }
    const def = byApiName.get(input.field);
    if (!def) throw new UnprocessableEntityException(`unknown field "${input.field}"`);

    /*
     * Read the value the same way the rest of the read path does: stored values
     * are keyed by field UUID (ADR-0002), and formulas/rollups live in
     * `computed_values`. Casting through `numeric` rather than `int` so a
     * currency or a decimal is not silently truncated.
     */
    const source =
      def.type === 'formula' || def.type === 'rollup'
        ? sql`${records.computedValues}->>${def.id}`
        : sql`${records.values}->>${def.id}`;
    // A non-numeric value is SKIPPED, not zero. Zero would drag an average down
    // and report a total that is quietly wrong.
    const numeric = sql`NULLIF(${source}, '')::numeric`;
    const guard = sql`${source} ~ '^-?[0-9]+(\.[0-9]+)?$'`;
    const expr =
      input.op === 'sum' ? sql`sum(${numeric})`
      : input.op === 'avg' ? sql`avg(${numeric})`
      : input.op === 'min' ? sql`min(${numeric})`
      : sql`max(${numeric})`;

    const [row] = await this.db
      .select({ value: sql<string | null>`${expr}` })
      .from(records)
      .where(and(where, guard));
    return {
      op: input.op,
      field: input.field,
      value: row?.value == null ? null : Number(row.value),
      filtered: Boolean(input.filter || input.q),
      exact: true,
    };
  }

  async query(
    databaseId: string,
    input: QueryRecordsInput,
    currentUserId: string,
    membership?: Membership,
  ) {
    const defs = await this.fieldDefs(databaseId);
    const byApiName = new Map(defs.map((d) => [d.api_name, d]));
    // #351: overlay the canonical system-field registry so built-in columns
    // (number, updated_by, …) are addressable in filter+sort by their canonical
    // api_names — ADDITIVELY, so a real user/stored field of the same name (e.g. a
    // database with its own `number` field) always wins and is never shadowed.
    for (const def of systemFieldDefsFor(byApiName.keys())) byApiName.set(def.api_name, def);
    const nullsFirst = input.nulls === 'first';

    const SORTABLE = new Set([
      'id', 'title', 'text', 'number', 'date', 'url', 'email', 'select', 'workflow',
      // MN-267: rollup is now materialized too (recomputeRollupsForRelationField,
      // invalidated via RollupInvalidationSubscriber on the related record's
      // change or the relation's own link-set change) — reuses computed_values/
      // fieldExpr()/the keyset cursor exactly like formula does (MN-260).
      // #351: updated_by joins created_at/updated_at/created_by as a sortable
      // system column (records.updated_by), via the registry-driven overlay above.
      'checkbox', 'created_at', 'updated_at', 'created_by', 'updated_by', 'user', 'formula', 'rollup',
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
      // #300: first/last rollups are materialized and invalidated now, so the
      // #286 refusal here is gone. The refusal was correct while the premise
      // held — sorting by a value that was never stored orders the page by null
      // and reads as a sort that was ignored.
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
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs, membership),
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  /** Simple list: manual (position) order, optional q title search, keyset cursor. */
  async list(
    databaseId: string,
    opts: { limit: number; cursor?: string; q?: string },
    membership?: Membership,
  ) {
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
      data: await this.attachLinks(page.map((r) => this.project(r, defs)), defs, membership),
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
      /*
       * #300 — a relation ref (`count({Issues})`) is no longer excluded.
       *
       * #298 kept it out for the right reason: a cross-record value frozen at
       * this record's own write time is stale the moment a linked record
       * changes. What changed is not the reasoning but the plumbing —
       * invalidateRollupsForChange now recomputes these on exactly the events
       * that can move them, the same guarantee that earned rollups (MN-267)
       * their place here.
       *
       * A LOOKUP is still excluded above: lookups are resolved purely at read
       * time and nothing recomputes a materialized copy of one.
       */
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
  if (def.type === 'updated_by') return row.updatedBy;
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
