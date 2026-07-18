import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { activeFilter, type ViewConfig } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { databases, fields, selectOptions, views } from '../db/schema';
import { RecordsService } from '../records/records.service';
import {
  csvHeaderLine,
  csvRecordLine,
  exportColumns,
  type ExportField,
} from './csv';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 500;

/**
 * CSV export (MN-075) — the way OUT, matching MN-052's way in.
 *
 * A view exports exactly what it shows (its filters, sorts, column order and
 * hidden fields); a database exports everything.
 *
 * The whole thing STREAMS (MN-128): one page is in memory at a time and each page
 * is written as it's read, so memory is bounded and there is no row cap — the old
 * 50k limit silently truncated a large export, and the header that warned of it
 * couldn't be read by the browser's link download. Complete or nothing.
 */
@Injectable()
export class ExportService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly records: RecordsService,
  ) {}

  /** Resolve the database, optional view config, columns and label maps. */
  private async prepare(databaseId: string, viewId: string | undefined) {
    const database = await this.db.query.databases.findFirst({
      where: eq(databases.id, databaseId),
    });
    if (!database) throw new NotFoundException('Database not found');

    let config: ViewConfig | undefined;
    if (viewId) {
      // A malformed id must 404, not reach Postgres and 500 as an invalid uuid.
      if (!UUID_RE.test(viewId)) throw new NotFoundException('View not found');
      const view = await this.db.query.views.findFirst({
        where: and(eq(views.id, viewId), eq(views.databaseId, databaseId)),
      });
      if (!view) throw new NotFoundException('View not found');
      config = view.config as ViewConfig;
    }

    const live = await this.db.query.fields.findMany({
      where: and(eq(fields.databaseId, databaseId), isNull(fields.deletedAt)),
    });
    live.sort((a, b) => a.position - b.position);

    // The view decides which columns and in what order — the CSV is what you see.
    const hidden = new Set(config?.hidden_field_ids ?? []);
    const exportFields: ExportField[] = live
      .filter((f) => !hidden.has(f.id))
      .map((f) => ({ id: f.id, displayName: f.displayName, apiName: f.apiName, type: f.type }));

    const labels = await this.optionLabels(live.map((f) => f.id));
    const userNames = await this.userNames();
    return { database, config, exportFields, labels, userNames };
  }

  /**
   * Validate EAGERLY (resolve the db + view — 404s surface here, before any body),
   * then hand back a generator that streams the CSV line by line. Splitting it this
   * way keeps a bad view a clean 404 rather than a 200 with a broken stream, since
   * we can't change the status once bytes are flowing (MN-128).
   */
  async prepareExport(
    databaseId: string,
    viewId: string | undefined,
    currentUserId: string,
  ): Promise<{ databaseName: string; generate: () => AsyncGenerator<string> }> {
    const { database, config, exportFields, labels, userNames } = await this.prepare(
      databaseId,
      viewId,
    );
    const cols = exportColumns(exportFields);
    const query = this.records.query.bind(this.records);
    const labelize = (v: Record<string, unknown>) => this.labelizeValues(v, labels);

    return {
      databaseName: database.name,
      generate: async function* () {
        yield `${csvHeaderLine(cols)}\r\n`;
        let cursor: string | undefined;
        for (;;) {
          const page = await query(
            databaseId,
            {
              // The query API calls it `filter`; a ViewConfig calls it `filters`.
              // A view's filters may carry disabled clauses (MN-253 UI) — prune those
              // and their UI-only fields before this hits the query engine, same as
              // the web app's queryBodyFromConfig does for the on-screen query.
              filter: activeFilter(config?.filters),
              sorts: config?.sorts ?? [],
              limit: PAGE,
              cursor,
            },
            currentUserId,
          );
          if (page.data.length === 0) break;
          let chunk = '';
          for (const record of page.data) {
            chunk += `${csvRecordLine(cols, { number: record.number, title: record.title, values: labelize(record.values) }, userNames)}\r\n`;
          }
          yield chunk;
          if (!page.next_cursor) break;
          cursor = page.next_cursor;
        }
      },
    };
  }

  /** option id → label, for every select/multi_select field on the database. */
  private async optionLabels(fieldIds: string[]): Promise<Map<string, string>> {
    if (fieldIds.length === 0) return new Map();
    const options = await this.db.query.selectOptions.findMany({
      where: inArray(selectOptions.fieldId, fieldIds),
    });
    return new Map(options.map((o) => [o.id, o.label]));
  }

  private async userNames(): Promise<Map<string, string>> {
    const rows = await this.db.query.user.findMany({ columns: { id: true, name: true, email: true } });
    return new Map(rows.map((u) => [u.id, u.name || u.email]));
  }

  private labelizeValues(
    values: Record<string, unknown>,
    labels: Map<string, string>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === 'string' && labels.has(value)) out[key] = labels.get(value);
      else if (Array.isArray(value) && value.every((v) => typeof v === 'string' && labels.has(v))) {
        out[key] = value.map((v) => labels.get(v as string));
      } else out[key] = value;
    }
    return out;
  }
}
