import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { parse } from 'csv-parse/sync';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { fields, records } from '../db/schema';
import { FieldsService } from '../fields/fields.service';
import { RecordsService } from '../records/records.service';
import { RelationsService } from '../relations/relations.service';
import type { Membership } from '../workspaces/workspace-access.guard';

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

const INFERABLE_DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})/;
const BOOLS = new Set(['true', 'false', 'yes', 'no', '1', '0']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

/** CSV import (MN-052): parse → infer → map → dry-run → chunked commit. */
@Injectable()
export class ImportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly fieldsService: FieldsService,
    private readonly recordsService: RecordsService,
    private readonly relationsService: RelationsService,
  ) {}

  parseCsv(buffer: Buffer): { headers: string[]; rows: string[][] } {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
    const delimiter = [',', ';', '\t'].reduce((best, d) =>
      (firstLine.split(d).length > firstLine.split(best).length ? d : best),
    );
    let parsed: string[][];
    try {
      parsed = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: true }) as string[][];
    } catch (error) {
      throw new UnprocessableEntityException(`Could not parse CSV: ${(error as Error).message}`);
    }
    if (parsed.length === 0) throw new UnprocessableEntityException('The CSV is empty');
    const [headers, ...rows] = parsed;
    return { headers: headers!.map((h) => h.trim()), rows };
  }

  /** Suggested type per column from the first 1000 rows (MN-052 inference rules). */
  inferTypes(headers: string[], rows: string[][]): Array<{ column: string; type: string; options?: string[] }> {
    return headers.map((column, i) => {
      const sample = rows.slice(0, 1000).map((r) => (r[i] ?? '').trim()).filter(Boolean);
      if (sample.length === 0) return { column, type: 'text' };
      const share = (pred: (v: string) => boolean) => sample.filter(pred).length / sample.length;
      if (share((v) => BOOLS.has(v.toLowerCase())) >= 0.95) return { column, type: 'checkbox' };
      if (share((v) => Number.isFinite(Number(v.replace(',', '.')))) >= 0.98) return { column, type: 'number' };
      if (share((v) => INFERABLE_DATE.test(v)) >= 0.95) return { column, type: 'date' };
      if (share((v) => EMAIL.test(v)) >= 0.9) return { column, type: 'email' };
      if (share((v) => URL_RE.test(v)) >= 0.9) return { column, type: 'url' };
      const distinct = [...new Set(sample)];
      if (distinct.length <= 24 && sample.length >= distinct.length * 2) {
        return { column, type: 'select', options: distinct };
      }
      return { column, type: 'text' };
    });
  }

  private coerceCell(type: string, raw: string): unknown {
    const value = raw.trim();
    if (!value) return undefined;
    switch (type) {
      case 'number': {
        const n = Number(value.replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(n) ? n : undefined;
      }
      case 'checkbox':
        return ['true', 'yes', '1'].includes(value.toLowerCase());
      case 'date': {
        const m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(value);
        if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
        return INFERABLE_DATE.test(value) ? value.slice(0, 10) : undefined;
      }
      default:
        return value;
    }
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
    const warnings: Warning[] = [];
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

    // Relation title → id maps (one per relation column).
    const relationMaps = new Map<string, Map<string, string | null>>(); // field_id -> titleLower -> id|null(ambiguous)
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
      const map = new Map<string, string | null>();
      for (const t of targets) {
        const key = t.title.toLowerCase();
        map.set(key, map.has(key) ? null : t.id); // null marks ambiguity
      }
      relationMaps.set(m.to.field_id, map);
    }

    if (dryRun) {
      // Walk rows collecting per-cell warnings without writing.
      let creates = 0;
      const sample: Array<Record<string, unknown>> = [];
      rows.forEach((row, rowIndex) => {
        const titleIdx = headers.indexOf(titleColumns[0]!.column);
        const title = (row[titleIdx] ?? '').trim();
        if (!title) {
          warnings.push({ row: rowIndex + 2, column: titleColumns[0]!.column, message: 'empty title — row skipped' });
          return;
        }
        creates++;
        const preview: Record<string, unknown> = { name: title };
        headers.forEach((column, i) => {
          const to = byColumn.get(column);
          if (!to || to.kind === 'skip' || to.kind === 'title') return;
          const raw = (row[i] ?? '').trim();
          if (!raw) return;
          if (to.kind === 'relation') {
            const hit = relationMaps.get(to.field_id)!.get(raw.toLowerCase());
            if (hit === undefined) warnings.push({ row: rowIndex + 2, column, message: `no record titled "${raw}"` });
            else if (hit === null) warnings.push({ row: rowIndex + 2, column, message: `"${raw}" is ambiguous` });
            else if (sample.length < 5) preview[column] = raw;
            return;
          }
          const type = to.kind === 'new' ? to.type : fieldById.get(to.field_id)!.type;
          const coerced = this.coerceCell(type, raw);
          if (coerced === undefined) warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" is not a valid ${type}` });
          else if (sample.length < 5) preview[column] = coerced;
        });
        if (sample.length < 5) sample.push(preview);
      });
      return { dry_run: true, rows: rows.length, will_create: creates, new_fields: newFields, warnings: warnings.slice(0, 100), warnings_total: warnings.length, sample };
    }

    // Commit: create new fields, then records in chunks, then links.
    const columnField = new Map<string, { apiName: string; type: string; id: string }>();
    const selectLabelMaps = new Map<string, Map<string, string>>();
    for (const m of mapping) {
      if (m.to.kind === 'existing') {
        const f = fieldById.get(m.to.field_id)!;
        columnField.set(m.column, { apiName: f.apiName, type: f.type, id: f.id });
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
          selectLabelMaps.set(m.column, new Map(created.options.map((o) => [o.label.toLowerCase(), o.id])));
        }
      }
    }
    const titleIdx = headers.indexOf(titleColumns[0]!.column);
    const createdIds: string[] = [];
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
          const hit = relationMaps.get(to.field_id)!.get(raw.toLowerCase());
          if (hit === undefined || hit === null) {
            warnings.push({ row: rowIndex + 2, column, message: hit === null ? `"${raw}" is ambiguous` : `no record titled "${raw}"` });
          } else {
            pendingLinks.push({ recordIndex: payloads.length, fieldId: to.field_id, targetId: hit });
          }
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
        const coerced = this.coerceCell(meta.type, raw);
        if (coerced === undefined) {
          warnings.push({ row: rowIndex + 2, column, message: `"${raw.slice(0, 30)}" dropped — not a valid ${meta.type}` });
        } else {
          values[meta.apiName] = coerced;
        }
      });
      payloads.push(values);
    });

    for (let offset = 0; offset < payloads.length; offset += 500) {
      const chunk = payloads.slice(offset, offset + 500);
      const created = await this.recordsService.createBatch(membership.workspaceId, databaseId, chunk, actorId, 0, { suppressAutomations: true });
      created.forEach((r) => createdIds.push(r.id));
    }
    for (const link of pendingLinks) {
      const recordId = createdIds[link.recordIndex];
      if (!recordId) continue;
      await this.relationsService
        .addLinks(membership.workspaceId, databaseId, recordId, link.fieldId, [link.targetId], actorId)
        .catch((error: Error) => warnings.push({ row: 0, column: '', message: `link failed: ${error.message}` }));
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
