import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, selectOptions } from '../db/schema';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { ChunkedApplyService } from '../migration-framework/chunked-apply.service';
import { DryRunBuilder } from '../migration-framework/dry-run';
import { coerceScalar, inferFieldType } from '../migration-framework/field-type-mapping';
import type { FieldDef } from '@storyos/schemas';
import { buildTitleIndex, resolveTargetsByTitle, splitTargets } from '../migration-framework/relation-resolver';
import { RelationLinkerService } from '../migration-framework/relation-linker.service';
import { buildLabelIndex } from '../migration-framework/select-options';
import { CsvSourceAdapter } from './csv-source-adapter';

export interface ColumnMapping {
  column: string;
  to:
    | { kind: 'title' }
    | { kind: 'existing'; field_id: string }
    | { kind: 'new'; display_name: string; type: string }
    | { kind: 'relation'; field_id: string }
    | { kind: 'skip' };
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
      if (m.to.kind === 'existing' || m.to.kind === 'relation') {
        const field = fieldById.get(m.to.field_id);
        if (!field) throw new UnprocessableEntityException(`Unknown field for column "${m.column}"`);
        if (m.to.kind === 'relation' && field.type !== 'relation') {
          throw new UnprocessableEntityException(`Column "${m.column}" maps to a non-relation field`);
        }
      }
      if (m.to.kind === 'new') newFields.push({ column: m.column, ...m.to });
    }

    // Relation title → id indexes (one per relation column) — the framework's
    // "resolve by target title" trick (buildTitleIndex/resolveTargetsByTitle).
    const relationMaps = new Map<string, Map<string, string | null>>();
    for (const m of mapping) {
      if (m.to.kind !== 'relation') continue;
      const field = fieldById.get(m.to.field_id)!;
      const relConfig = field.config as { relation_id: string; side: 'a' | 'b' };
      const relation = await this.relationsService.getById(relConfig.relation_id);
      const targetDbId = relConfig.side === 'a' ? relation.databaseBId : relation.databaseAId;
      const targets = await this.db.query.records.findMany({
        where: and(eq(records.databaseId, targetDbId), isNull(records.deletedAt)),
        columns: { id: true, title: true },
      });
      relationMaps.set(m.to.field_id, buildTitleIndex(targets));
    }

    if (dryRun) {
      const report = new DryRunBuilder();
      report.newFields = newFields;
      rows.forEach((row, rowIndex) => {
        const titleIdx = headers.indexOf(titleColumns[0]!.column);
        const title = (row[titleIdx] ?? '').trim();
        if (!title) {
          report.addWarning({ row: rowIndex + 2, column: titleColumns[0]!.column, message: 'empty title — row skipped' });
          return;
        }
        report.willCreate++;
        const preview: Record<string, unknown> = { name: title };
        headers.forEach((column, i) => {
          const to = byColumn.get(column);
          if (!to || to.kind === 'skip' || to.kind === 'title') return;
          const raw = (row[i] ?? '').trim();
          if (!raw) return;
          if (to.kind === 'relation') {
            const { warnings } = resolveTargetsByTitle(relationMaps.get(to.field_id)!, raw);
            for (const message of warnings) report.addWarning({ row: rowIndex + 2, column, message });
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
    const titleIdx = headers.indexOf(titleColumns[0]!.column);
    const pendingLinks: Array<{ recordIndex: number; fieldId: string; targetId: string }> = [];
    const payloads: Array<Record<string, unknown>> = [];
    rows.forEach((row, rowIndex) => {
      const title = (row[titleIdx] ?? '').trim();
      if (!title) {
        warnings.push({ row: rowIndex + 2, column: titleColumns[0]!.column, message: 'empty title — row skipped' });
        return;
      }
      const values: Record<string, unknown> = { name: title };
      headers.forEach((column, i) => {
        const to = byColumn.get(column);
        if (!to || to.kind === 'skip' || to.kind === 'title') return;
        const raw = (row[i] ?? '').trim();
        if (!raw) return;
        if (to.kind === 'relation') {
          // A cell can name several targets — that's how export writes a
          // many-to-many, so import must read it back the same way (MN-075).
          const { hits, warnings: misses } = resolveTargetsByTitle(relationMaps.get(to.field_id)!, raw);
          for (const message of misses) warnings.push({ row: rowIndex + 2, column, message });
          for (const targetId of hits) pendingLinks.push({ recordIndex: payloads.length, fieldId: to.field_id, targetId });
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
      payloads.push(values);
    });

      createdIds = await this.chunkedApply.createChunked(membership.workspaceId, databaseId, payloads, actorId);
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
      warnings: warnings.slice(0, 100),
      warnings_total: warnings.length,
    };
  }
}
