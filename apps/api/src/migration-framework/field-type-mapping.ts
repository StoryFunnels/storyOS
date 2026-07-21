import type { CreatableFieldType } from '@storyos/schemas';

const BOOLS = new Set(['true', 'false', 'yes', 'no', '1', '0']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const INFERABLE_DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{4})/;

export interface InferredType {
  type: string;
  options?: string[];
}

/**
 * Suggest a StoryOS field type from a sample of raw string values — MN-052's
 * inference rules, generalized so any string-valued source (not just CSV) can
 * reuse the same table instead of re-deriving its own. Order matters: cheapest,
 * most specific checks first; `text` is the always-safe fallback.
 */
export function inferFieldType(sample: string[]): InferredType {
  const values = sample.map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) return { type: 'text' };
  const share = (pred: (v: string) => boolean) => values.filter(pred).length / values.length;
  if (share((v) => BOOLS.has(v.toLowerCase())) >= 0.95) return { type: 'checkbox' };
  if (share((v) => Number.isFinite(Number(v.replace(',', '.')))) >= 0.98) return { type: 'number' };
  if (share((v) => INFERABLE_DATE.test(v)) >= 0.95) return { type: 'date' };
  if (share((v) => EMAIL.test(v)) >= 0.9) return { type: 'email' };
  if (share((v) => URL_RE.test(v)) >= 0.9) return { type: 'url' };
  const distinct = [...new Set(values)];
  if (distinct.length <= 24 && values.length >= distinct.length * 2) {
    return { type: 'select', options: distinct };
  }
  return { type: 'text' };
}

/**
 * Coerce a raw source-side scalar into the shape a StoryOS field of `type`
 * accepts. Returns `undefined` when the cell can't be coerced — the caller
 * turns that into a per-record warning and drops just that cell, never the
 * whole record (MN-052's per-cell degradation contract).
 */
export function coerceScalar(type: string, raw: string): unknown {
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

/** Creatable-from-a-mapping-UI field types (matches the wizard's "＋ New field" list). */
export const NEW_FIELD_TYPES: CreatableFieldType[] = ['text', 'number', 'date', 'checkbox', 'select', 'email', 'url'];
