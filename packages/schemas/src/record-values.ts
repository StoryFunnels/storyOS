import { z } from 'zod';

/**
 * The record-value validator (ADR-0002): Postgres stores anything, so THIS is
 * the schema enforcer. Pure function — shared by the API write path and any
 * client that wants pre-flight validation.
 *
 * Input values are keyed by field api_name (the public contract). Output
 * values are keyed by field id (the storage contract). The title field maps
 * to the promoted `title` column, not into values.
 */

export interface FieldDef {
  id: string;
  api_name: string;
  type: string; // field_type enum
  config: Record<string, unknown>;
  /** Valid option ids for select/multi_select fields. */
  option_ids?: string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidatedRecordValues {
  /** Storage payload keyed by field id. Explicit nulls mean "clear this key". */
  values: Record<string, unknown>;
  /** New title, when the title field was present in the input. */
  title?: string;
  issues: ValidationIssue[];
}

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const urlRe = /^https?:\/\/\S+$/i;
const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;

export function validateRecordValues(
  fields: FieldDef[],
  input: Record<string, unknown>,
): ValidatedRecordValues {
  const byApiName = new Map(fields.map((f) => [f.api_name, f]));
  const result: ValidatedRecordValues = { values: {}, issues: [] };

  for (const [key, raw] of Object.entries(input)) {
    const field = byApiName.get(key);
    if (!field) {
      result.issues.push({ path: `values.${key}`, message: `unknown field "${key}"` });
      continue;
    }
    if (field.type === 'created_at' || field.type === 'updated_at' || field.type === 'created_by') {
      result.issues.push({ path: `values.${key}`, message: `"${key}" is read-only` });
      continue;
    }
    if (field.type === 'relation') {
      result.issues.push({
        path: `values.${key}`,
        message: `relation values are set via the links endpoints, not values`,
      });
      continue;
    }
    if (field.type === 'title') {
      if (typeof raw !== 'string') {
        result.issues.push({ path: `values.${key}`, message: 'title must be a string' });
      } else {
        result.title = raw.slice(0, 500);
      }
      continue;
    }

    if (raw === null) {
      result.values[field.id] = null; // explicit clear
      continue;
    }

    const { value, error } = coerce(field, raw);
    if (error) result.issues.push({ path: `values.${key}`, message: error });
    else result.values[field.id] = value;
  }

  return result;
}

function coerce(field: FieldDef, raw: unknown): { value?: unknown; error?: string } {
  switch (field.type) {
    case 'text': {
      if (typeof raw !== 'string') return { error: 'expected a string' };
      return { value: raw };
    }
    case 'lookup':
      return { error: 'lookup values are computed from the related record and cannot be written' };
    case 'rich_text': {
      // BlockNote document: an array of block objects, size-capped.
      if (
        !Array.isArray(raw) ||
        raw.some((b) => typeof b !== 'object' || b === null || typeof (b as { type?: unknown }).type !== 'string')
      ) {
        return { error: 'expected an array of rich-text blocks' };
      }
      if (JSON.stringify(raw).length > 64_000) return { error: 'rich text too large (64KB max)' };
      return { value: raw };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { error: 'expected a number' };
      return { value: n };
    }
    case 'checkbox': {
      if (typeof raw !== 'boolean') return { error: 'expected a boolean' };
      return { value: raw };
    }
    case 'date': {
      if (typeof raw !== 'string') return { error: 'expected an ISO date string' };
      const includeTime = field.config['include_time'] === true;
      if (!includeTime) {
        if (dateOnlyRe.test(raw)) return { value: raw };
        const ms = Date.parse(raw);
        if (Number.isNaN(ms)) return { error: 'invalid date' };
        return { value: new Date(ms).toISOString().slice(0, 10) };
      }
      const ms = Date.parse(raw);
      if (Number.isNaN(ms)) return { error: 'invalid date' };
      return { value: new Date(ms).toISOString() };
    }
    case 'url': {
      if (typeof raw !== 'string' || !urlRe.test(raw)) return { error: 'expected an http(s) URL' };
      return { value: raw };
    }
    case 'email': {
      if (typeof raw !== 'string' || !emailRe.test(raw)) return { error: 'expected an email address' };
      return { value: raw };
    }
    case 'select': {
      if (typeof raw !== 'string') return { error: 'expected an option id' };
      if (!field.option_ids?.includes(raw)) return { error: 'unknown option id' };
      return { value: raw };
    }
    case 'multi_select': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
        return { error: 'expected an array of option ids' };
      }
      const unknown = raw.find((v) => !field.option_ids?.includes(v as string));
      if (unknown) return { error: `unknown option id "${unknown}"` };
      return { value: [...new Set(raw)] };
    }
    case 'user': {
      const multi = field.config['multi'] === true;
      if (multi) {
        if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
          return { error: 'expected an array of user ids' };
        }
        return { value: [...new Set(raw)] };
      }
      if (typeof raw !== 'string') return { error: 'expected a user id' };
      return { value: raw };
    }
    default:
      return { error: `unsupported field type "${field.type}"` };
  }
}

export const createRecordSchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
});

export const createRecordsBatchSchema = z.object({
  records: z.array(createRecordSchema).min(1).max(100),
});

export const updateRecordSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export const moveRecordSchema = z
  .object({
    before_record_id: z.uuid().optional(),
    after_record_id: z.uuid().optional(),
    /** Optional value patch applied atomically with the move (kanban drops). */
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((v) => Boolean(v.before_record_id) !== Boolean(v.after_record_id) || (!v.before_record_id && !v.after_record_id && Boolean(v.values)), {
    message: 'provide exactly one of before_record_id / after_record_id (or only values)',
    path: ['before_record_id'],
  });
