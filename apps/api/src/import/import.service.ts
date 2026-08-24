import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, records, selectOptions } from '../db/schema';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { ChunkedApplyService } from '../migration-framework/chunked-apply.service';
import { DryRunBuilder } from '../migration-framework/dry-run';
import { coerceScalar, inferFieldType } from '../migration-framework/field-type-mapping';
import type { FieldDef } from '@storyos/schemas';
import {
  buildMatchIndex,
  buildTitleIndex,
  isMatchableKeyType,
  matchKey,
  resolveTargets,
  splitTargets,
} from '../migration-framework/relation-resolver';
import { RelationLinkerService } from '../migration-framework/relation-linker.service';
import { buildLabelIndex } from '../migration-framework/select-options';
import { CsvSourceAdapter } from './csv-source-adapter';

export interface ColumnMapping {
  column: string;
  to:
    | { kind: 'title' }
    | { kind: 'existing'; field_id: string }
    | { kind: 'new'; display_name: string; type: string }
    /**
     * #377 — a relation column. Either maps to an EXISTING relation field
     * (`field_id`), or names a TARGET DATABASE and creates the relation
     * (`target_database_id`). A brand-new database has no relation fields, so
     * the option simply was not rendered — which is what the founder hit
     * importing into a fresh Leads table, and why the natural attempt (import
     * both CSVs) silently produced two unconnected tables.
     *
     * `match_field_id` chooses WHICH field on the target is matched. Omitted =
     * the title, the previous and only behaviour. The founder's CSV carries both
     * `company_id` (stable) and `company_name` (a display name), and only the
     * fragile one was usable.
     */
    | { kind: 'relation'; field_id?: string; target_database_id?: string; field_name?: string; match_field_id?: string }
    | { kind: 'skip' };
}

/**
 * #378 — how an incoming row relates to a record that already exists.
 *
 * Import was create-only, which made it a one-shot migration tool rather than a
 * way to keep data current. Real data arrives as an updated export, a corrected
 * file, a weekly refresh — and without a key the second import silently
 * duplicates, usually discovered much later when counts stop making sense.
 */
export interface UpsertOptions {
  /** CSV column holding the key. */
  column: string;
  /** Field on THIS database the key matches. Omitted = the record title. */
  match_field_id?: string;
  /** Default 'update': the reason someone sets a key at all. */
  on_match?: 'update' | 'skip' | 'create';
  on_no_match?: 'create' | 'skip';
}

interface Warning {
  row: number;
  column: string;
  message: string;
}

/** Re-exported for callers that only need the relation-cell-splitting rule (MN-075). */
export { splitTargets };

/**
 * CSV import (MN-052): parse → infer → map → dry-run → chunked commit — now
 * built on the shared migration framework (#198 / MN-236, ADR-0013) instead of
 * hand-rolling type inference, relation-by-title matching and chunked commit
 * inline. See docs/decisions/ADR-0013-migration-framework.md.
 */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fieldsService: FieldsService,
    private readonly relationsService: RelationsService,
    private readonly chunkedApply: ChunkedApplyService,
    private readonly relationLinker: RelationLinkerService,
    // #372 — needed to UNDO the records a failed run created.
    private readonly records: RecordsService,
  ) {}

  parseCsv(buffer: Buffer): { headers: string[]; rows: string[][] } {
    const adapter = new CsvSourceAdapter();
    adapter.connect({ buffer });
    return { headers: adapter.parsedHeaders, rows: adapter.parsedRows };
  }

  /** Suggested type per column from the first 1000 rows (MN-052 inference rules,
   * generalized into migration-framework/field-type-mapping). */
  inferTypes(headers: string[], rows: string[][]): Array<{ column: string; type: string; options?: string[] }> {
    return headers.map((column, i) => {
      const sample = rows.slice(0, 1000).map((r) => r[i] ?? '');
      const inferred = inferFieldType(sample);
      return { column, type: inferred.type, options: inferred.options };
    });
  }

  async run(
    membership: Membership,
    databaseId: string,
    buffer: Buffer,
    mapping: ColumnMapping[],
    dryRun: boolean,
    actorId: string,
    upsert?: UpsertOptions,
  ) {
    const { headers, rows } = this.parseCsv(buffer);
    const byColumn = new Map(mapping.map((m) => [m.column, m.to]));
    const titleColumns = mapping.filter((m) => m.to.kind === 'title');
    if (titleColumns.length !== 1) {
      throw new UnprocessableEntityException('Exactly one column must map to the record title');
    }
    for (const m of mapping) {
      if (!headers.includes(m.column)) {
        throw new UnprocessableEntityException(`Mapped column "${m.column}" is not in the CSV`);
      }
    }

    // Resolve field metadata for existing/relation targets; create new fields at commit.
    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    const fieldById = new Map(live.map((f) => [f.id, f]));
    /**
     * #371 — the FieldDef `coerceScalar` validates against. Passing it is what
     * makes a bad url/email cell a WARNING instead of an exception that kills the
     * whole batch: without a def there is nothing authoritative to check, so the
     * value would sail through to the record write exactly as it used to.
     *
     * A NEW field has no row yet, so there is nothing to build one from — those
     * are checked at the commit, once the field exists.
     */
    const defOf = (fieldId: string): FieldDef | undefined => {
      const f = fieldById.get(fieldId);
      if (!f) return undefined;
      return {
        id: f.id,
        api_name: f.apiName,
        type: f.type,
        config: (f.config ?? {}) as Record<string, unknown>,
      };
    };
    const newFields: Array<{ column: string; display_name: string; type: string }> = [];
    for (const m of mapping) {
      if (m.to.kind === 'existing') {
        if (!fieldById.get(m.to.field_id)) {
          throw new UnprocessableEntityException(`Unknown field for column "${m.column}"`);
        }
      }
      if (m.to.kind === 'relation') {
        // #377 — one of the two, not both, not neither.
        if (!m.to.field_id && !m.to.target_database_id) {
          throw new UnprocessableEntityException(
            `Column "${m.column}" maps to a relation but names neither an existing relation field nor a target database.`,
          );
        }
        if (m.to.field_id) {
          const field = fieldById.get(m.to.field_id);
          if (!field) throw new UnprocessableEntityException(`Unknown field for column "${m.column}"`);
          if (field.type !== 'relation') {
            throw new UnprocessableEntityException(`Column "${m.column}" maps to a non-relation field`);
          }
        }
      }
      if (m.to.kind === 'new') newFields.push({ column: m.column, ...m.to });
    }

    /**
     * #377 — one plan per relation COLUMN, not per field id.
     *
     * Keyed by column because a relation the import CREATES has no field id
     * until commit, and the dry run has to resolve links before anything is
     * created. Carries the match index and the label the warnings use, so
     * "no record with company_id X" reads correctly instead of the misleading
     * "no record titled X".
     */
    interface RelationPlan {
      targetDbId: string;
      /** Existing relation field, if the column maps to one. */
      fieldId?: string;
      /** Name for a relation this import will create. */
      fieldName?: string;
      matchLabel: string;
      index: Map<string, string | null>;
    }
    const relationPlans = new Map<string, RelationPlan>();
    for (const m of mapping) {
      if (m.to.kind !== 'relation') continue;

      let targetDbId: string;
      if (m.to.field_id) {
        const field = fieldById.get(m.to.field_id)!;
        const relConfig = field.config as { relation_id: string; side: 'a' | 'b' };
        const relation = await this.relationsService.getById(relConfig.relation_id);
        targetDbId = relConfig.side === 'a' ? relation.databaseBId : relation.databaseAId;
      } else {
        targetDbId = m.to.target_database_id!;
        const target = await this.db.query.databases.findFirst({
          where: and(eq(databases.id, targetDbId), eq(databases.workspaceId, membership.workspaceId)),
          columns: { id: true },
        });
        if (!target) {
          throw new UnprocessableEntityException(`Column "${m.column}" names a target database that does not exist.`);
        }
      }

      // Which field on the target is matched. Omitted = the title.
      let matchLabel = 'titled';
      let index: Map<string, string | null>;
      if (m.to.match_field_id) {
        const keyField = await this.db.query.fields.findFirst({
          where: and(eq(fields.id, m.to.match_field_id), eq(fields.databaseId, targetDbId), isNull(fields.deletedAt)),
        });
        if (!keyField) {
          throw new UnprocessableEntityException(
            `Column "${m.column}" matches on a field that is not on the target database.`,
          );
        }
        // Only fields that can IDENTIFY a record. Matching on a checkbox would
        // make every row ambiguous.
        if (!isMatchableKeyType(keyField.type)) {
          throw new UnprocessableEntityException(
            `Column "${m.column}" cannot match on a ${keyField.type} field — use a text, number, email, url or id field, or the record title.`,
          );
        }
        matchLabel = `with ${keyField.apiName}`;
        if (keyField.type === 'title') {
          const targets = await this.db.query.records.findMany({
            where: and(eq(records.databaseId, targetDbId), isNull(records.deletedAt)),
            columns: { id: true, title: true },
          });
          index = buildTitleIndex(targets);
        } else {
          const targets = await this.db.query.records.findMany({
            where: and(eq(records.databaseId, targetDbId), isNull(records.deletedAt)),
            columns: { id: true, values: true },
          });
          index = buildMatchIndex(
            targets.map((t) => ({ id: t.id, key: (t.values as Record<string, unknown>)?.[keyField.id] })),
          );
        }
      } else {
        const targets = await this.db.query.records.findMany({
          where: and(eq(records.databaseId, targetDbId), isNull(records.deletedAt)),
          columns: { id: true, title: true },
        });
        index = buildTitleIndex(targets);
      }

      relationPlans.set(m.column, {
        targetDbId,
        fieldId: m.to.field_id,
        fieldName: m.to.field_name,
        matchLabel,
        index,
      });
    }

    /**
     * #378 — index of EXISTING records in this database, by the chosen key.
     *
     * Reuses #377's buildMatchIndex/matchKey, as both tickets require: the two
     * must be tolerant in the same way, and one implementation cannot drift from
     * itself. `null` in the index marks a duplicate key, which is REPORTED per
     * row and never resolved — picking one of two matches overwrites the wrong
     * record, silently.
     */
    let upsertIndex: Map<string, string | null> | undefined;
    let upsertKeyLabel = 'titled';
    if (upsert) {
      if (!headers.includes(upsert.column)) {
        throw new UnprocessableEntityException(`Key column "${upsert.column}" is not in the CSV`);
      }
      if (upsert.match_field_id) {
        const keyField = await this.db.query.fields.findFirst({
          where: and(eq(fields.id, upsert.match_field_id), eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
        });
        if (!keyField) throw new UnprocessableEntityException('The key field is not on this database.');
        if (!isMatchableKeyType(keyField.type)) {
          throw new UnprocessableEntityException(
            `Cannot match on a ${keyField.type} field — use a text, number, email, url or id field, or the record title.`,
          );
        }
        upsertKeyLabel = `with ${keyField.apiName}`;
        const existing = await this.db.query.records.findMany({
          where: and(eq(records.databaseId, databaseId), isNull(records.deletedAt)),
          columns: { id: true, title: true, values: true },
        });
        upsertIndex = buildMatchIndex(
          existing.map((r) => ({
            id: r.id,
            key: keyField.type === 'title' ? r.title : (r.values as Record<string, unknown>)?.[keyField.id],
          })),
        );
      } else {
        const existing = await this.db.query.records.findMany({
          where: and(eq(records.databaseId, databaseId), isNull(records.deletedAt)),
          columns: { id: true, title: true },
        });
        upsertIndex = buildTitleIndex(existing);
      }
    }
    const keyColumnIndex = upsert ? headers.indexOf(upsert.column) : -1;
    const onMatch = upsert?.on_match ?? 'update';
    const onNoMatch = upsert?.on_no_match ?? 'create';

    /**
     * Which existing record this row is, if any. `undefined` = no match,
     * `null` = the key is duplicated and must not be guessed at.
     */
    const matchFor = (row: string[]): string | null | undefined => {
      if (!upsertIndex || keyColumnIndex < 0) return undefined;
      const raw = (row[keyColumnIndex] ?? '').trim();
      if (!raw) return undefined;
      return upsertIndex.get(matchKey(raw));
    };

    if (dryRun) {
      const report = new DryRunBuilder();
      report.newFields = newFields;
      // #374/#377 — relation preview counts.
      let linksToMake = 0;
      let unmatchedCells = 0;
      let updated = 0;
      let skipped = 0;
      // Relations this import would CREATE — previously impossible, so the
      // preview never had to mention them.
      const newRelations = [...relationPlans.entries()]
        .filter(([, plan]) => !plan.fieldId)
        .map(([column, plan]) => ({ column, field_name: plan.fieldName ?? column, target_database_id: plan.targetDbId }));
      rows.forEach((row, rowIndex) => {
        const titleIdx = headers.indexOf(titleColumns[0]!.column);
        const title = (row[titleIdx] ?? '').trim();
        if (!title) {
          report.addWarning({ row: rowIndex + 2, column: titleColumns[0]!.column, message: 'empty title — row skipped' });
          return;
        }
        // #378 — created / updated / skipped, before committing.
        const match = matchFor(row);
        if (match === null) {
          report.addWarning({
            row: rowIndex + 2,
            column: upsert!.column,
            message: `"${(row[keyColumnIndex] ?? '').trim()}" matches more than one record — ${upsertKeyLabel} is not unique, so this row is skipped`,
          });
          skipped++;
          return;
        }
        if (match) {
          if (onMatch === 'skip') { skipped++; return; }
          if (onMatch === 'update') updated++;
          else report.willCreate++;
        } else if (upsert && onNoMatch === 'skip') {
          skipped++;
          return;
        } else {
          report.willCreate++;
        }
        const preview: Record<string, unknown> = { name: title };
        headers.forEach((column, i) => {
          const to = byColumn.get(column);
          if (!to || to.kind === 'skip' || to.kind === 'title') return;
          const raw = (row[i] ?? '').trim();
          if (!raw) return;
          if (to.kind === 'relation') {
            const plan = relationPlans.get(column)!;
            const { hits, warnings } = resolveTargets(plan.index, raw, plan.matchLabel);
            for (const message of warnings) report.addWarning({ row: rowIndex + 2, column, message });
            // #374/#377 — the dry run must say how many links will be made and
            // how many cells matched nothing. Those numbers are the entire
            // reason to run a check before importing relations.
            linksToMake += hits.length;
            unmatchedCells += warnings.length;
            preview[column] = raw;
            return;
          }
          const type = to.kind === 'new' ? to.type : fieldById.get(to.field_id)!.type;
          /**
           * #374 — the dry run must validate what the COMMIT validates, or the
           * count it prints is a guess. A NEW field has no row yet, so its def is
           * synthesised from what the field WILL be created as: `create` is
           * called with `config: {}`, so this matches the real thing.
           *
           * Without this the dry run skipped validation for exactly the columns
           * the founder was importing (22 new fields), printed "148 of 148 will
           * import", and the commit then failed on the first bad url.
           */
          /**
           * Select-like columns are NOT validated here, because the commit does
           * not validate them here either — it resolves them through a label→id
           * map before `coerceScalar` is ever reached. Running them through the
           * validator makes the dry run disagree with the commit, which is the
           * same defect as #374 pointing the other way.
           *
           * For a NEW select the values are valid by construction anyway: its
           * options are created FROM the distinct values in this very column.
           * For an EXISTING one a value may genuinely not match an option — the
           * commit warns about that correctly, and teaching the dry run to
           * predict it needs the label maps loaded here. Left for #374's
           * remaining preview work rather than guessed at.
           *
           * Caught in the browser: a 4-row file reported 16 false warnings.
           */
          const selectish = ['select', 'multi_select', 'workflow'].includes(type);
          const def: FieldDef | undefined = selectish
            ? undefined
            : to.kind === 'new'
              ? { id: '', api_name: column, type: to.type, config: {} }
              : defOf(to.field_id);
          const coerced = coerceScalar(type, raw, def);
          if (coerced === undefined) {
            report.addWarning({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" is not a valid ${type}` });
          } else {
            preview[column] = coerced;
          }
        });
        report.addSample(preview);
      });
      const built = report.build();
      return {
        dry_run: true,
        rows: rows.length,
        will_create: built.will_create,
        new_fields: newFields,
        warnings: built.warnings,
        warnings_total: built.warnings_total,
        sample: built.sample,
        /**
         * #374 — a check step that cannot describe what it is about to do is
         * just a delay. These are the numbers the founder needed and did not
         * have: how many links will actually be built, and how many cells name
         * something that does not exist.
         */
        links_to_make: linksToMake,
        unmatched_relation_cells: unmatchedCells,
        new_relations: newRelations,
        // #378 — the three numbers a key-matched import turns on.
        will_update: updated,
        will_skip: skipped,
      };
    }

    /**
     * #375 — a multi-select cell is a delimited list. "a, b; c" must become three
     * options, not one option literally named "a, b; c" — which is what happened
     * when the value went through the single-value path.
     *
     * Comma and semicolon both, because a CSV that uses ';' as its own delimiter
     * (as StoryOS export does) tends to use ',' inside cells, and vice versa.
     */
    const splitMulti = (raw: string) =>
      raw
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean);

    // Commit: create new fields, then records in chunks, then links.
    const warnings: Warning[] = [];
    /**
     * #372 — every field THIS run created, so a failure can undo them.
     *
     * Schema mutation and record insertion are not one transaction: fields are
     * created through FieldsService (its own transaction each) and records in
     * chunks through RecordsService, deliberately, so a large import does not
     * hold one transaction open across the whole file. The consequence was that
     * a failed run committed 22 fields and zero records, and the retry then
     * collided with its own leftovers — a trap the user could not get out of
     * from inside the product.
     *
     * This is COMPENSATION, not atomicity: the writes happen and are then undone.
     * It gives the property the user actually needs — a failed import leaves the
     * database as it was — without restructuring transaction ownership across
     * two services. The honest caveat is that compensation can itself fail, so
     * that case is reported rather than swallowed.
     */
    const createdFieldIds: string[] = [];
    /**
     * #377 — the relation field each relation column writes through, resolved at
     * commit. An EXISTING relation contributes its own field id; one the import
     * CREATES contributes the id of the field it just made.
     */
    const relationFieldIdByColumn = new Map<string, string>();
    const createdRelationIds: string[] = [];
    // #378
    const updates: Array<{ recordId: string; values: Record<string, unknown> }> = [];
    let skippedRows = 0;

    /** #372 — undo everything this run wrote. Records first, then fields: the
     * inverse of the order they were created, and a field with values still on
     * it is harder to remove. Returns what it could NOT undo. */
    const rollback = async (recordIds: string[]): Promise<string[]> => {
      const failures: string[] = [];
      if (recordIds.length > 0) {
        try {
          await this.records.batchDelete(membership.workspaceId, databaseId, recordIds, actorId ?? '');
        } catch {
          failures.push(`${recordIds.length} record(s)`);
        }
      }
      for (const fieldId of createdFieldIds) {
        try {
          await this.fieldsService.remove(databaseId, fieldId);
        } catch {
          failures.push(`field ${fieldId}`);
        }
      }
      // #377 — relations created by this run are its writes too, and a relation
      // adds a field to the OTHER database as well, so leaving one behind
      // pollutes a database the user was not even importing into.
      for (const relationId of createdRelationIds) {
        try {
          await this.relationsService.remove(membership.workspaceId, relationId);
        } catch {
          failures.push(`relation ${relationId}`);
        }
      }
      return failures;
    };
    /**
     * #371 — carries the FieldDef, not just its type. A NEW field does not exist
     * in `live` (read before the fields are created), so reconstructing a def
     * from `fieldById` would return undefined for exactly the case that caused
     * this bug: the founder's import created 22 new fields, and an unvalidated
     * url cell among them killed all 148 rows.
     */
    const columnField = new Map<string, { apiName: string; type: string; id: string; def: FieldDef }>();
    const selectLabelMaps = new Map<string, Map<string, string>>();
    /**
     * The try begins HERE, before the fields are created — not just around the
     * record insert. A failure part-way through CREATING the fields strands the
     * earlier ones, which is the same defect one step sooner. (Found by test: a
     * second `workflow` field is rejected at creation time, and the first was
     * left behind.)
     */
    let createdIds: string[] = [];
    try {
    for (const m of mapping) {
      if (m.to.kind === 'existing') {
        const f = fieldById.get(m.to.field_id)!;
        columnField.set(m.column, {
          apiName: f.apiName,
          type: f.type,
          id: f.id,
          def: { id: f.id, api_name: f.apiName, type: f.type, config: (f.config ?? {}) as Record<string, unknown> },
        });
        // An EXISTING select needs its label→option map too. Without this the
        // lookup below always missed, so every value imported into an existing
        // select was silently dropped as "not a known option" — which also broke
        // the export→import round-trip (MN-075).
        if (f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow') {
          const options = await this.db.query.selectOptions.findMany({
            where: eq(selectOptions.fieldId, f.id),
          });
          selectLabelMaps.set(m.column, buildLabelIndex(options));
        }
      } else if (m.to.kind === 'new') {
        // New select columns: options = distinct values (≤100), imported by label.
        const columnIndex = headers.indexOf(m.column);
        const rawCells = rows.map((r) => (r[columnIndex] ?? '').trim()).filter(Boolean);
        // #375 — multi_select and workflow need options too. multi_select's come
        // from SPLITTING each cell, or every distinct combination becomes its own
        // option ("a, b" and "a, c" as two unrelated values).
        const optionLabels =
          m.to.type === 'multi_select'
            ? [...new Set(rawCells.flatMap(splitMulti))]
            : m.to.type === 'select' || m.to.type === 'workflow'
              ? [...new Set(rawCells)]
              : undefined;
        const options = optionLabels?.slice(0, 100).map((label) => ({ label }));
        const created = (await this.fieldsService.create(databaseId, {
          display_name: m.to.display_name,
          type: m.to.type as never,
          config: {},
          options,
        })) as { id: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> };
        createdFieldIds.push(created.id);
        columnField.set(m.column, {
          apiName: created.apiName,
          type: m.to.type,
          id: created.id,
          // Just created, so its config is the default `{}` passed above.
          def: { id: created.id, api_name: created.apiName, type: m.to.type, config: {} },
        });
        if (created.options) {
          selectLabelMaps.set(m.column, buildLabelIndex(created.options));
        }
      }
    }
    /**
     * #377 — create the relation for any column that named a target database
     * instead of an existing relation field.
     *
     * many_to_many because a CSV cell can name several targets (MN-075 writes
     * them comma-separated, and import reads them back the same way). Choosing
     * one_to_many here would silently drop every target but the first on any
     * multi-target cell.
     *
     * Inside the same try as the fields, so #372's rollback covers these too.
     */
    for (const [column, plan] of relationPlans) {
      if (plan.fieldId) {
        relationFieldIdByColumn.set(column, plan.fieldId);
        continue;
      }
      const created = await this.relationsService.create(membership, {
        database_a_id: databaseId,
        database_b_id: plan.targetDbId,
        cardinality: 'many_to_many',
        field_a_name: plan.fieldName ?? column,
      });
      createdRelationIds.push(created.id);
      relationFieldIdByColumn.set(column, created.field_a.id);
    }

    const titleIdx = headers.indexOf(titleColumns[0]!.column);
    const pendingLinks: Array<{ recordIndex: number; fieldId: string; targetId: string }> = [];
    const payloads: Array<Record<string, unknown>> = [];
    rows.forEach((row, rowIndex) => {
      const title = (row[titleIdx] ?? '').trim();
      if (!title) {
        warnings.push({ row: rowIndex + 2, column: titleColumns[0]!.column, message: 'empty title — row skipped' });
        return;
      }
      /**
       * #378 — decide before building values, so a skipped row costs nothing.
       * `null` = duplicate key: reported and skipped, never guessed at. Picking
       * one of two matches overwrites the wrong record silently, and the user
       * finds out much later if at all.
       */
      const match = matchFor(row);
      if (match === null) {
        warnings.push({
          row: rowIndex + 2,
          column: upsert!.column,
          message: `"${(row[keyColumnIndex] ?? '').trim()}" matches more than one record — ${upsertKeyLabel} is not unique, so this row was skipped`,
        });
        skippedRows++;
        return;
      }
      if (match && onMatch === 'skip') { skippedRows++; return; }
      if (!match && upsert && onNoMatch === 'skip') { skippedRows++; return; }

      const values: Record<string, unknown> = { name: title };
      headers.forEach((column, i) => {
        const to = byColumn.get(column);
        if (!to || to.kind === 'skip' || to.kind === 'title') return;
        const raw = (row[i] ?? '').trim();
        if (!raw) return;
        if (to.kind === 'relation') {
          // A cell can name several targets — that's how export writes a
          // many-to-many, so import must read it back the same way (MN-075).
          const plan = relationPlans.get(column)!;
          const fieldId = relationFieldIdByColumn.get(column);
          if (!fieldId) return;
          const { hits, warnings: misses } = resolveTargets(plan.index, raw, plan.matchLabel);
          for (const message of misses) warnings.push({ row: rowIndex + 2, column, message });
          for (const targetId of hits) pendingLinks.push({ recordIndex: payloads.length, fieldId, targetId });
          return;
        }
        const meta = columnField.get(column);
        if (!meta) return;
        if (meta.type === 'multi_select') {
          // #375 — each part resolves independently: an unknown one is a warning
          // and the REST of the cell still imports. Dropping the whole cell
          // because one tag is unrecognised is the per-cell failure this epic is
          // about, one level down.
          const labels = selectLabelMaps.get(column);
          const ids: string[] = [];
          for (const part of splitMulti(raw)) {
            const optionId = labels?.get(part.toLowerCase());
            if (optionId) ids.push(optionId);
            else warnings.push({ row: rowIndex + 2, column, message: `"${part.slice(0, 30)}" is not a known option` });
          }
          if (ids.length > 0) values[meta.apiName] = ids;
          return;
        }
        if (meta.type === 'select' || meta.type === 'workflow') {
          const optionId = selectLabelMaps.get(column)?.get(raw.toLowerCase());
          if (optionId) values[meta.apiName] = optionId;
          else warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" is not a known option` });
          return;
        }
        const coerced = coerceScalar(meta.type, raw, meta.def);
        if (coerced === undefined) {
          warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" dropped — not a valid ${meta.type}` });
        } else {
          values[meta.apiName] = coerced;
        }
      });
      /**
       * An UPDATE carries only the columns present in the file. Everything else
       * is untouched — a three-column corrections file updates three fields and
       * leaves the rest alone. The opposite is silent data loss: someone
       * re-importing a two-column file would wipe a whole database and not know
       * until they looked. `values` is built from the CSV's own columns, so this
       * property holds by construction rather than by remembering to preserve it.
       */
      if (match && onMatch === 'update') {
        updates.push({ recordId: match, values });
        return;
      }
      payloads.push(values);
    });

      createdIds = await this.chunkedApply.createChunked(membership.workspaceId, databaseId, payloads, actorId);
      /**
       * #378 — updates are NOT rolled back by #372's compensation: there is no
       * before-image to restore them to. So they run AFTER the creates, when
       * the risky part is already done. Said plainly rather than left implicit,
       * because "a failed import changes nothing" is weaker here than it is for
       * a create-only run.
       */
      for (const u of updates) {
        await this.records.update(membership.workspaceId, databaseId, u.recordId, u.values, actorId);
      }
      for (const link of pendingLinks) {
        const recordId = createdIds[link.recordIndex];
        if (!recordId) continue;
        const failure = await this.relationLinker.link(
          membership.workspaceId,
          databaseId,
          recordId,
          link.fieldId,
          [link.targetId],
          actorId,
        );
        if (failure) warnings.push({ row: 0, column: '', message: failure });
      }
    } catch (error) {
      const undoFailures = await rollback(createdIds);
      const because = error instanceof Error ? error.message : 'the import failed';
      // Compensation can itself fail. Saying so is the difference between a
      // recoverable situation and a mystery: if the rollback did not complete,
      // the user needs to know the database is NOT as it was.
      const suffix =
        undoFailures.length > 0
          ? ` The database could not be fully restored — left behind: ${undoFailures.join(', ')}. Remove them by hand before retrying.`
          : ' Nothing was imported and no fields were added, so you can fix the file and try again.';
      throw new UnprocessableEntityException({
        message: `${because}${suffix}`,
        // Preserve the original specifics (#373 renders these).
        details: (error as { response?: { details?: unknown } })?.response?.details ?? undefined,
      });
    }

    return {
      dry_run: false,
      created: createdIds.length,
      created_record_ids: createdIds,
      updated: updates.length,
      skipped: skippedRows,
      warnings: warnings.slice(0, 100),
      warnings_total: warnings.length,
    };
  }
}
