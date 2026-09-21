import type { FormVisibilityRule } from '@storyos/schemas';
import type { FilterNode } from './filter-config';

/**
 * Pure state logic for the form-fields sidebar builder (#224). Kept dependency-free
 * (no React) so it's directly unit-testable — see form-fields.unit.test.ts.
 */

export interface FormFieldCfg {
  field_id: string;
  required?: boolean;
  label?: string;
  help?: string;
  /** #263 — show this field only when an earlier answer matches. */
  visible_when?: FormVisibilityRule;
  /** #500 — `required` above only bites when this also holds (or is unset). */
  required_when?: FormVisibilityRule;
  /** #501 — narrows a relation field's picker; meaningful only for a
   *  `type: 'relation'` field, compiled against its TARGET database. */
  relation_filter?: FilterNode;
}

/**
 * Field types a form (public or in-app) can render/accept — mirrors the API's
 * SUPPORTED set in apps/api/src/forms/forms.service.ts exactly. `rich_text`
 * is absent from both (#758): it used to be server-accepted while neither
 * renderer ever produced a valid block-array value for it (a plain-string
 * submit 422s) and the sidebar never offered it — a guaranteed dead end,
 * removed at the source rather than merely excluded here.
 */
export const FORM_FIELD_TYPES = new Set([
  'title',
  'text',
  'number',
  'date',
  'checkbox',
  'url',
  'email',
  'select',
  // #311: State is a normal field on a form — it renders through the same option
  // control as select (which was already allowed), so this adds no new exposure.
  'workflow',
  'multi_select',
  'user',
  'relation',
  // #724 — added by #710 server-side; missing here for one release, so a form
  // could accept an attachment via the API but never actually offer the field.
  'attachment',
]);

/**
 * #724 — the server (forms.service.ts) accepts at most one configured
 * attachment field per form, silently dropping a second at render time. The
 * builder shouldn't let a second one be created in the first place — this is
 * the pure check; the caller decides how to surface the refusal.
 */
export function canAddFormField(selectedTypes: string[], fieldType: string): boolean {
  return !(fieldType === 'attachment' && selectedTypes.includes('attachment'));
}

/**
 * Which field ids make up the form, in order (#224). `config.form.fields` is the
 * sidebar builder's own source of truth; a form saved before the sidebar shipped
 * has an empty `form.fields` and falls back to the view's old Cards-popover
 * selection (`card_field_ids`) — the same fallback the public API uses, so an
 * existing shared form keeps rendering unchanged until an editor opens the
 * sidebar (at which point the first edit commits a real `form.fields` list).
 */
export function resolveFormFieldIds(formFields: FormFieldCfg[], cardFieldIds: string[]): string[] {
  return formFields.length ? formFields.map((f) => f.field_id) : cardFieldIds;
}

/**
 * Toggle a field's membership. Removing drops it (and its required/label/help)
 * from the list; adding appends it at the end with a fresh, empty config.
 */
export function toggleFieldSelection(
  currentIds: string[],
  cfgs: FormFieldCfg[],
  fieldId: string,
): FormFieldCfg[] {
  const cfgById = new Map(cfgs.map((c) => [c.field_id, c]));
  const nextIds = currentIds.includes(fieldId)
    ? currentIds.filter((id) => id !== fieldId)
    : [...currentIds, fieldId];
  return nextIds.map((id) => cfgById.get(id) ?? { field_id: id });
}

/** Drag-to-reorder: move the field at `from` to `to` within the selected list. */
export function reorderFieldSelection(
  currentIds: string[],
  cfgs: FormFieldCfg[],
  from: number,
  to: number,
): FormFieldCfg[] {
  if (from < 0 || to < 0 || from >= currentIds.length || to >= currentIds.length) return cfgs;
  const cfgById = new Map(cfgs.map((c) => [c.field_id, c]));
  const nextIds = [...currentIds];
  const [moved] = nextIds.splice(from, 1);
  if (moved === undefined) return cfgs;
  nextIds.splice(to, 0, moved);
  return nextIds.map((id) => cfgById.get(id) ?? { field_id: id });
}

/** Patch one selected field's required/label/help without disturbing order. */
export function patchFieldConfig(
  currentIds: string[],
  cfgs: FormFieldCfg[],
  fieldId: string,
  patch: Partial<Omit<FormFieldCfg, 'field_id'>>,
): FormFieldCfg[] {
  const cfgById = new Map(cfgs.map((c) => [c.field_id, c]));
  return currentIds.map((id) => {
    const cfg = cfgById.get(id) ?? { field_id: id };
    return id === fieldId ? { ...cfg, ...patch } : cfg;
  });
}
