import { markdownToBlocks } from '@storyos/schemas/markdown';
import {
  coerceFieldValue,
  IMPORTABLE_FIELD_TYPES,
  type CreatableFieldType,
  type FieldDef,
} from '@storyos/schemas';

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
 * Spreadsheet-shaped text that a strict validator would reject but a human
 * plainly meant: "1 234,5" for a number, "31/12/2026" for a date, "yes" for a
 * checkbox. Applied BEFORE validation, never instead of it.
 *
 * Deliberately narrow. This is where being generous is safe, because whatever it
 * produces still has to satisfy the real validator below.
 */
function fromSpreadsheetText(type: string, value: string, field?: FieldDef): unknown {
  switch (type) {
    case 'rich_text': {
      /**
       * #375 made rich_text importable and #371 started validating every cell
       * against the REAL validator — which wants an array of BlockNote blocks,
       * not a string. So every prose column failed and was dropped: a 148-row
       * file reported 736 warnings, all "is not a valid rich_text".
       *
       * `markdownToBlocks` already exists and the MCP already does exactly this
       * for rich_text fields. Reuse it rather than hand-rolling a second block
       * shape — a CSV cell with line breaks or markdown becomes real paragraphs.
       */
      return markdownToBlocks(value);
    }
    case 'user': {
      // A MULTI user field wants an array; a CSV cell is one string. Same class
      // of bug as rich_text above, in a type nobody has reported yet because
      // #375 only just made it importable.
      //
      // A SINGLE user field is left as a string on purpose: RecordsService
      // resolves an id, email or name before validating, so passing the raw
      // value through is what lets "ada@example.com" work at all.
      if (field?.config?.['multi'] === true) {
        return value.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
      }
      return value;
    }
    case 'number': {
      // Returns undefined, not the raw string, when it cannot be a number. This
      // is load-bearing WITHOUT a FieldDef — a caller inferring a type for a
      // column that does not exist yet has no validator to fall back on, and
      // MN-052's contract is that an unparseable number drops with a warning.
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
    case 'url': {
      // A spreadsheet's website column is usually "acme.com", and the validator
      // requires a scheme. Adding https:// imports the cell instead of dropping
      // it — the founder's Companies CSV is exactly this shape. Only when it
      // looks like a bare domain: anything else is left for the validator to
      // judge, rather than guessed at.
      if (/^https?:\/\//i.test(value)) return value;
      return /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value) ? `https://${value}` : value;
    }
    default:
      return value;
  }
}

/**
 * Coerce a raw source-side scalar into the shape a StoryOS field accepts.
 * Returns `undefined` when the cell can't be coerced — the caller turns that
 * into a per-record warning and drops just that cell, never the whole record
 * (MN-052's per-cell degradation contract).
 *
 * #371 — validation now runs through `coerceFieldValue`, THE validator the
 * record write itself uses. Previously this switched over number/checkbox/date
 * and let everything else through with `default: return value`, so a `url` or
 * `email` cell the server would reject sailed past here and failed the entire
 * batch. url and email were the only types that detonated instead of degrading,
 * and one bad LinkedIn cell could kill a 148-row file.
 *
 * Delegating rather than adding two more cases is the point: a field type added
 * to StoryOS later cannot opt out of validation here by being forgotten, and
 * this file can no longer drift from the validator's own url/email regexes —
 * which it had already duplicated.
 */
export function coerceScalar(type: string, raw: string, field?: FieldDef): unknown {
  const value = raw.trim();
  if (!value) return undefined;

  const shaped = fromSpreadsheetText(type, value, field);
  // Unshapeable by the spreadsheet rules alone — already a warning, whether or
  // not a field is available to validate against.
  if (shaped === undefined) return undefined;

  // Without a FieldDef there is nothing authoritative to check against — the
  // caller is inferring a type for a column that does not exist yet. Return the
  // spreadsheet-shaped value; the commit path validates it for real.
  if (!field) return shaped;

  const { value: ok, error } = coerceFieldValue(field, shaped);
  // A warning, never an exception. This is the contract the whole import rests
  // on: no single cell may fail the run.
  return error ? undefined : ok;
}

/**
 * #375 — re-exported from the shared schema, not re-listed.
 *
 * This was a hardcoded array of seven, with a comment claiming it "matches the
 * wizard's ＋ New field list" — a hand-maintained mirror of a hand-maintained
 * mirror. Both are now derived from `creatableFieldTypeSchema` minus a named
 * exclusion set, so a field type added to StoryOS appears in import
 * automatically instead of silently not existing.
 */
export const NEW_FIELD_TYPES: readonly CreatableFieldType[] = IMPORTABLE_FIELD_TYPES;
