/**
 * Pure state logic for the form-fields sidebar builder (#224). Kept dependency-free
 * (no React) so it's directly unit-testable — see form-fields.unit.test.ts.
 */

export interface FormFieldCfg {
  field_id: string;
  required?: boolean;
  label?: string;
  help?: string;
}

/**
 * Field types a form (public or in-app) can render/accept — mirrors the API's
 * SUPPORTED set in apps/api/src/forms/forms.service.ts, minus `rich_text`.
 * `rich_text` is technically accepted server-side but neither the public form
 * renderer nor the old in-app builder ever produced a valid block-array value
 * for it (a plain-string submit 422s) — excluded here so the new sidebar never
 * offers a type that's a guaranteed dead end. Kept in one place so the sidebar
 * never offers a type the backend would silently drop.
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
  'multi_select',
  'user',
  'relation',
]);

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
