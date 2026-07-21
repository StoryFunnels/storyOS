import { UnprocessableEntityException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { inferFieldType } from '../migration-framework/field-type-mapping';
import type { SourceAdapter, SourceField, SourceRecord } from '../migration-framework/types';

export interface CsvSourceConfig {
  buffer: Buffer;
}

/**
 * CSV source adapter (MN-052) — the framework's `SourceAdapter` implemented for
 * the simplest possible source: no auth, `connect()` just parses the upload.
 * Delimiter sniffing, BOM stripping and quoted-newline handling all come from
 * `csv-parse`, matching the parser MN-052 already shipped.
 */
export class CsvSourceAdapter implements SourceAdapter<CsvSourceConfig> {
  readonly key = 'csv';

  private headers: string[] = [];
  private rows: string[][] = [];

  connect(config: CsvSourceConfig): void {
    const text = config.buffer.toString('utf8').replace(/^\uFEFF/, '');
    const firstLine = text.slice(0, text.indexOf('\n') + 1 || undefined);
    const delimiter = [',', ';', '\t'].reduce((best, d) =>
      firstLine.split(d).length > firstLine.split(best).length ? d : best,
    );
    let parsed: string[][];
    try {
      parsed = parse(text, { delimiter, relax_column_count: true, skip_empty_lines: true }) as string[][];
    } catch (error) {
      throw new UnprocessableEntityException(`Could not parse CSV: ${(error as Error).message}`);
    }
    if (parsed.length === 0) throw new UnprocessableEntityException('The CSV is empty');
    const [headers, ...rows] = parsed;
    this.headers = headers!.map((h) => h.trim());
    this.rows = rows;
  }

  /** Column headers + inferred type, over the first 1000 rows (MN-052's rule). */
  readSchema(): SourceField[] {
    return this.headers.map((column, i) => {
      const sample = this.rows.slice(0, 1000).map((r) => r[i] ?? '');
      const inferred = inferFieldType(sample);
      return { key: column, label: column, sourceType: inferred.type, options: inferred.options };
    });
  }

  /** Every row, values keyed by column header — relations are left as raw cell
   * text for the framework's relation-resolver to split/match by title. */
  readRecords(): Promise<SourceRecord[]> {
    const titleColumn = this.headers[0] ?? 'title';
    return Promise.resolve(
      this.rows.map((row, i) => {
        const fields: Record<string, unknown> = {};
        this.headers.forEach((column, ci) => {
          fields[column] = row[ci] ?? '';
        });
        return {
          sourceId: String(i),
          title: (row[this.headers.indexOf(titleColumn)] ?? '').trim(),
          fields,
        };
      }),
    );
  }

  get parsedHeaders(): string[] {
    return this.headers;
  }

  get parsedRows(): string[][] {
    return this.rows;
  }
}
