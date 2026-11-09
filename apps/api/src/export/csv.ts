import { blocksToMarkdown } from '@storyos/schemas';

/**
 * CSV serialization (MN-075) — the round-trip partner of the MN-052 importer.
 *
 * Pure: the caller loads records/fields/users, this decides bytes. Every rule here
 * exists so `export → import` reproduces the same data, so the encodings mirror
 * what the importer parses: relations and multi-selects as comma-separated
 * **titles/labels**, dates ISO 8601, checkboxes true/false, rich text as Markdown.
 */

export interface ExportField {
  id: string;
  displayName: string;
  apiName: string;
  type: string;
}

export interface ExportRecord {
  number: number | null;
  title: string;
  /** Keyed by api_name, already projected + link-attached (chips carry titles). */
  values: Record<string, unknown>;
}

/** Types that carry no data of their own — never exported. */
const SKIP = new Set(['button']);

/** A plain number, which a spreadsheet reads as a number even with a leading sign: `-5`, `+3.2`, `1e3`. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Ticket #1052 — formula injection (OWASP "CSV Injection"). Excel, Sheets and LibreOffice run a cell that starts with
 * `=`, `+`, `-` or `@` (and tab/CR variants) as a formula, and anyone can put text in a record: a public form submitter,
 * an import, a webhook. A leading `'` makes the spreadsheet show the text as text. Plain numbers keep their sign: `-5`
 * is data, not a formula.
 */
export function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

/** RFC 4180: quote when the cell holds a delimiter, quote or newline; "" escapes a quote. Formula-looking text is defused first. */
export function csvCell(raw: string): string {
  const value = neutralizeFormula(raw);
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

function chipTitles(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((chip) => (chip && typeof chip === 'object' ? String((chip as { title?: string }).title ?? '') : String(chip)))
    .filter(Boolean)
    .join(', ');
}

export function serializeCell(
  field: ExportField,
  record: ExportRecord,
  userNames: Map<string, string>,
): string {
  if (field.type === 'title') return record.title ?? '';
  if (field.type === 'id') return record.number === null ? '' : String(record.number);

  const raw = record.values[field.apiName];
  if (raw === undefined || raw === null) return '';

  switch (field.type) {
    case 'checkbox':
      return raw === true ? 'true' : 'false';
    case 'rich_text':
      // Markdown, not block JSON — a spreadsheet cell should be readable, and the
      // importer stores prose as text (MN-060).
      return Array.isArray(raw) ? blocksToMarkdown(raw) : String(raw);
    case 'relation':
      // Comma-separated target titles: how the importer resolves a relation cell.
      return chipTitles(raw);
    case 'multi_select':
      return Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
    case 'user': {
      const ids = Array.isArray(raw) ? raw : [raw];
      return ids.map((id) => userNames.get(String(id)) ?? String(id)).join(', ');
    }
    case 'lookup':
    case 'rollup':
      return Array.isArray(raw) ? chipTitles(raw) || raw.map(String).join(', ') : String(raw);
    default:
      return String(raw);
  }
}

/**
 * Column order and visibility are the caller's decision (a view exports exactly
 * what it shows); this just renders them.
 */
/** Columns that actually make it into the CSV — everything but the data-less ones. */
export function exportColumns(fields: ExportField[]): ExportField[] {
  return fields.filter((f) => !SKIP.has(f.type));
}

/** The header line (no trailing newline). Shared by batch + streaming export (MN-128). */
export function csvHeaderLine(cols: ExportField[]): string {
  return csvRow(cols.map((f) => f.displayName));
}

/** One record's line (no trailing newline). */
export function csvRecordLine(
  cols: ExportField[],
  record: ExportRecord,
  userNames: Map<string, string>,
): string {
  return csvRow(cols.map((f) => serializeCell(f, record, userNames)));
}

export function serializeCsv(
  fields: ExportField[],
  records: ExportRecord[],
  userNames: Map<string, string> = new Map(),
): string {
  const cols = exportColumns(fields);
  const lines = [csvHeaderLine(cols)];
  for (const record of records) {
    lines.push(csvRecordLine(cols, record, userNames));
  }
  // Trailing newline: POSIX, and Excel is happier.
  return `${lines.join('\r\n')}\r\n`;
}

/** `Tasks` + a date → `Tasks-2026-07-16.csv`; safe on every OS. */
export function csvFilename(databaseName: string, date: Date): string {
  const slug = databaseName.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'export';
  return `${slug}-${date.toISOString().slice(0, 10)}.csv`;
}
