import { z } from 'zod';

/**
 * #263 — a form field's visibility rule: ONE condition against an earlier answer.
 * Deliberately not a logic graph; the ticket asks for "a small rule row per field".
 *
 * This lives in `schemas` rather than in the web app or the forms service because
 * both sides must agree: the renderer hides a field, and the server must then
 * refuse a value for that hidden field. Two copies of "is this field visible?"
 * is precisely the drift `docs/architecture/field-surfaces.md` exists to prevent.
 */
export const FORM_VISIBILITY_OPS = ['eq', 'neq', 'is_empty', 'not_empty', 'in'] as const;
export type FormVisibilityOp = (typeof FORM_VISIBILITY_OPS)[number];

/** Stored shape — references the controlling field by internal id. */
export const formVisibilityRuleSchema = z.object({
  /** The controlling field; must appear EARLIER in the form's field order. */
  field_id: z.uuid(),
  op: z.enum(FORM_VISIBILITY_OPS),
  /** Ignored by is_empty/not_empty. `in` takes an array. */
  value: z.unknown().optional(),
});
export type FormVisibilityRule = z.infer<typeof formVisibilityRuleSchema>;

/**
 * Rendered shape — the same rule keyed by `api_name`, which is what the PUBLIC
 * form definition exposes so a visitor's browser can evaluate it without ever
 * learning internal field ids.
 */
export interface PublicFormVisibilityRule {
  field: string;
  op: FormVisibilityOp;
  value?: unknown;
}

/**
 * Blank for visibility purposes. A form value arrives as '' from an untouched
 * text input and as [] from an untouched multi-select, and both mean "unanswered"
 * — so `is_empty` has to treat them the same way a human reading the form would.
 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Loose equality across the shapes one answer can take. A single-select may submit
 * either a bare option string or a one-element array depending on the surface, and
 * a number field may submit 3 or "3"; a rule written once must match both rather
 * than silently never firing.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  if (Array.isArray(a)) return a.length === 1 && sameValue(a[0], b);
  if (Array.isArray(b)) return b.length === 1 && sameValue(a, b[0]);
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b);
  return a === b;
}

/**
 * Is a field carrying this rule visible, given the answers so far?
 *
 * No rule means visible — an unconfigured field is not a hidden field (#305's
 * lesson: unconfigured is not invalid). A rule whose controlling answer is absent
 * evaluates against blank rather than throwing, because "not answered yet" is a
 * normal state while someone is filling the form in.
 */
export function isFormFieldVisible(
  rule: PublicFormVisibilityRule | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!rule) return true;
  const actual = answers[rule.field];
  switch (rule.op) {
    case 'is_empty':
      return isBlank(actual);
    case 'not_empty':
      return !isBlank(actual);
    case 'eq':
      return sameValue(actual, rule.value);
    case 'neq':
      return !sameValue(actual, rule.value);
    case 'in': {
      const set = Array.isArray(rule.value) ? rule.value : [rule.value];
      if (Array.isArray(actual)) return actual.some((a) => set.some((v) => sameValue(a, v)));
      return set.some((v) => sameValue(actual, v));
    }
    default:
      return true;
  }
}

/**
 * The visible subset of a form's fields, evaluated in ORDER so a rule can only
 * ever depend on an earlier answer. A field whose controlling field is itself
 * hidden is hidden too — otherwise a two-step branch would leak its second step
 * once the first was dismissed.
 */
export function visibleFormFields<T extends { api_name: string; visible_when?: PublicFormVisibilityRule }>(
  formFields: T[],
  answers: Record<string, unknown>,
): T[] {
  const visible: T[] = [];
  const shown = new Set<string>();
  for (const field of formFields) {
    const rule = field.visible_when;
    const controllerOk = !rule || shown.has(rule.field);
    if (controllerOk && isFormFieldVisible(rule, answers)) {
      visible.push(field);
      shown.add(field.api_name);
    }
  }
  return visible;
}
