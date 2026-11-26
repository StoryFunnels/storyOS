/**
 * Ticket #877 — the pure halves of the attach_pdf action: a safe file name, and a record drawn as the BlockNote blocks the
 * document export already renders. No database, no renderer; the action (attach-pdf.action.ts) supplies the data.
 *
 * Blocks rather than a second HTML writer: `blocksToHtml` is the one place that decides how content becomes the self-contained
 * page the renderer gets (escaping, safe links, no external references), so a record takes the same road a document does.
 */

/** The longest base name (before `.pdf`) we keep. Attachment filenames are cut at 255 on upload; this leaves room and stays readable. */
export const MAX_PDF_BASENAME = 120;

const FALLBACK_BASENAME = 'document';

/**
 * A rendered {Field}-templated name, made safe to store and to put in a Content-Disposition header: no path separators or
 * traversal, no control characters, no characters Windows and macOS refuse in a name, capped, always ending `.pdf`.
 *
 * The input is DATA (a record's title can be anything a collaborator typed), so this assumes hostility and never throws.
 */
export function safePdfFilename(raw: string): string {
  let base = raw
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, ' ')
    // path separators and the characters a filesystem or a header-quoting refuses
    .replace(/[\\/:*?"<>|]/g, ' ')
    // bidi overrides and zero-width characters: they make `invoice.pdf` read as something else
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A trailing `.pdf` is ours to add exactly once, whatever the template did.
  base = base.replace(/(\.pdf)+$/i, '').trim();
  // `..` and leading/trailing dots: never a traversal, never a hidden file, never a trailing-dot name Windows rewrites.
  // (Separators became spaces above, so "../x" arrives as ".. x": strip dots AND spaces from both ends.)
  base = base.replace(/\.{2,}/g, '.').replace(/^[.\s]+|[.\s]+$/g, '');
  if (base.length > MAX_PDF_BASENAME) base = base.slice(0, MAX_PDF_BASENAME).trim();
  // Slicing may have split a surrogate pair.
  base = base.replace(/[\ud800-\udbff]$/, '');
  if (!base) base = FALLBACK_BASENAME;
  return `${base}.pdf`;
}

/** The template an author gets when they leave `filename_template` out. */
export const DEFAULT_FILENAME_TEMPLATE = '{title} · {date}';

/** `{date}` (and only that exact token) is today in UTC; everything else is the action service's own {Field} interpolation. */
export function withDateToken(template: string, now: Date = new Date()): string {
  return template.replace(/\{date\}/g, now.toISOString().slice(0, 10));
}

export interface PdfFieldDef {
  id: string;
  apiName: string;
  displayName: string;
  type: string;
  position: number;
  isSystem: boolean;
  config: Record<string, unknown>;
}

export interface RecordPdfInput {
  fields: PdfFieldDef[];
  /** Values keyed by api_name, as RecordsService.get projects them for the READER. */
  values: Record<string, unknown>;
  /** option id → label, for select / multi-select / workflow fields. */
  optionLabels: ReadonlyMap<string, string>;
  /** user id → display name, for person fields. */
  userNames: ReadonlyMap<string, string>;
  /** The record's description document (BlockNote blocks), if it has one. */
  description: unknown;
}

const MAX_VALUE_CHARS = 2000;

function labelOf(item: unknown): string | null {
  if (item === null || item === undefined) return null;
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);
  if (typeof item === 'object') {
    const o = item as Record<string, unknown>;
    for (const key of ['title', 'label', 'name', 'filename']) {
      if (typeof o[key] === 'string' && o[key]) return o[key] as string;
    }
  }
  return null;
}

/** One field value as the text a reader would see in the record panel, or null when there is nothing to show. */
export function fieldValueText(field: PdfFieldDef, value: unknown, input: Pick<RecordPdfInput, 'optionLabels' | 'userNames'>): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  let text: string | null;
  if (field.type === 'checkbox') {
    text = value === true ? 'Yes' : value === false ? 'No' : String(value);
  } else if (field.type === 'select' || field.type === 'multi_select' || field.type === 'workflow') {
    const ids = Array.isArray(value) ? value : [value];
    const labels = ids.map((id) => (typeof id === 'string' ? input.optionLabels.get(id) : undefined)).filter((l): l is string => Boolean(l));
    text = labels.length ? labels.join(', ') : null;
  } else if (field.type === 'user') {
    const ids = Array.isArray(value) ? value : [value];
    const names = ids.map((id) => (typeof id === 'string' ? input.userNames.get(id) : undefined)).filter((n): n is string => Boolean(n));
    text = names.length ? names.join(', ') : null;
  } else if (Array.isArray(value)) {
    const parts = value.map(labelOf).filter((p): p is string => p !== null && p !== '');
    text = parts.length ? parts.join(', ') : null;
  } else if (typeof value === 'object') {
    text = labelOf(value) ?? JSON.stringify(value);
  } else {
    text = String(value);
  }
  if (text === null || text === '') return null;
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

const t = (text: string, bold = false) => ({ type: 'text' as const, text, styles: bold ? { bold: true } : {} });

/**
 * The record as blocks: its fields in panel order (hidden fields stay out, empty ones are left out), then its description
 * under a heading. The title is NOT a block; `blocksToHtml` draws it as the page title.
 */
export function recordToBlocks(input: RecordPdfInput): unknown[] {
  const order = (f: PdfFieldDef) => (typeof f.config['entity_order'] === 'number' ? (f.config['entity_order'] as number) : f.position);
  const shown = input.fields
    .filter((f) => f.apiName !== 'name' && !f.isSystem && f.config['entity_hidden'] !== true)
    .sort((a, b) => order(a) - order(b) || a.position - b.position);
  const blocks: unknown[] = [];
  for (const field of shown) {
    const text = fieldValueText(field, input.values[field.apiName], input);
    if (text === null) continue;
    blocks.push({ type: 'paragraph', content: [t(`${field.displayName}: `, true), t(text)] });
  }
  if (Array.isArray(input.description) && input.description.length > 0) {
    blocks.push({ type: 'heading', props: { level: 2 }, content: [t('Description')] });
    blocks.push(...input.description);
  }
  return blocks;
}
