/**
 * #571 — renders an AI field's prompt against ONE record, resolving
 * `{Field Name}` tokens the same way automation actions' `interpolate()`
 * does (actions.service.ts), but deliberately narrower: an AI field's prompt
 * has no batch index, no changes summary, no inbound webhook payload, and no
 * `{linked.Field}` reach — v1 is own-record fields only (FieldsService.
 * assertAiFieldConfig's own doc explains why: the record bag built here has
 * no relation-field scope to walk into). A SEPARATE small function rather
 * than importing automations' private `interpolate()` — reuse the SHAPE
 * (the regex, the display-name lookup), not a module with automation-only
 * concepts baked into its signature.
 */

export interface AiPromptRecord {
  title: string;
  number: number | null;
  values: Record<string, unknown>;
}

/** display name -> api name, built from a database's live field rows (which
 * carry displayName — FieldDef, the query-compiler's shape, does not). */
export function renderAiPrompt(
  prompt: string,
  record: AiPromptRecord,
  displayToApi: Map<string, string>,
): string {
  return prompt.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const trimmed = name.trim();
    if (trimmed.toLowerCase() === 'name' || trimmed.toLowerCase() === 'title') {
      return record.title || '—';
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'number' || lower === 'id') {
      return record.number === null || record.number === undefined ? '—' : String(record.number);
    }
    const apiName = displayToApi.get(trimmed) ?? trimmed;
    const value = record.values[apiName];
    if (value === undefined || value === null) return '—';
    if (Array.isArray(value)) {
      return value
        .map((v) => (typeof v === 'object' && v ? ((v as { title?: string }).title ?? '') : String(v)))
        .join(', ');
    }
    return String(value);
  });
}
