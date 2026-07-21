import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records, selectOptions } from '../db/schema';
import { FieldsService } from '../fields/fields.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';
import { ChunkedApplyService } from '../migration-framework/chunked-apply.service';
import { DryRunBuilder } from '../migration-framework/dry-run';
import { coerceScalar, inferFieldType } from '../migration-framework/field-type-mapping';
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
          const coerced = coerceScalar(type, raw);
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

    // Commit: create new fields, then records in chunks, then links.
    const warnings: Warning[] = [];
    const columnField = new Map<string, { apiName: string; type: string; id: string }>();
    const selectLabelMaps = new Map<string, Map<string, string>>();
    for (const m of mapping) {
      if (m.to.kind === 'existing') {
        const f = fieldById.get(m.to.field_id)!;
        columnField.set(m.column, { apiName: f.apiName, type: f.type, id: f.id });
        // An EXISTING select needs its label→option map too. Without this the
        // lookup below always missed, so every value imported into an existing
        // select was silently dropped as "not a known option" — which also broke
        // the export→import round-trip (MN-075).
        if (f.type === 'select' || f.type === 'multi_select') {
          const options = await this.db.query.selectOptions.findMany({
            where: eq(selectOptions.fieldId, f.id),
          });
          selectLabelMaps.set(m.column, buildLabelIndex(options));
        }
      } else if (m.to.kind === 'new') {
        // New select columns: options = distinct values (≤100), imported by label.
        const columnIndex = headers.indexOf(m.column);
        const options =
          m.to.type === 'select'
            ? [...new Set(rows.map((r) => (r[columnIndex] ?? '').trim()).filter(Boolean))]
                .slice(0, 100)
                .map((label) => ({ label }))
            : undefined;
        const created = (await this.fieldsService.create(databaseId, {
          display_name: m.to.display_name,
          type: m.to.type as never,
          config: {},
          options,
        })) as { id: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> };
        columnField.set(m.column, { apiName: created.apiName, type: m.to.type, id: created.id });
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
        if (meta.type === 'select') {
          const optionId = selectLabelMaps.get(column)?.get(raw.toLowerCase());
          if (optionId) values[meta.apiName] = optionId;
          else warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" is not a known option` });
          return;
        }
        const coerced = coerceScalar(meta.type, raw);
        if (coerced === undefined) {
          warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" dropped — not a valid ${meta.type}` });
        } else {
          values[meta.apiName] = coerced;
        }
      });
      payloads.push(values);
    });

    const createdIds = await this.chunkedApply.createChunked(membership.workspaceId, databaseId, payloads, actorId);
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

    return {
      dry_run: false,
      created: createdIds.length,
      created_record_ids: createdIds,
      warnings: warnings.slice(0, 100),
      warnings_total: warnings.length,
    };
  }
}
