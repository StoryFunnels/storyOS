import type { SourceFieldDirection, SourceFieldMapping } from '@storyos/schemas';

/**
 * #280 — a mapping entry, normalized. `sources.fieldMapping` stores either
 * the legacy bare-uuid shorthand (direction `in`, permanent — not deprecated,
 * see sources.ts's own comment) or the `{field_id, direction}` object form;
 * everything downstream of this function deals with one shape only.
 */
export interface NormalizedFieldMappingEntry {
  fieldId: string;
  direction: SourceFieldDirection;
}

/** One entry, normalized — `null` for a malformed value (defensive: stored
 * jsonb predates any schema on write, in principle, though the API validates
 * on the way in). */
export function normalizeMappingEntry(raw: SourceFieldMapping[string] | undefined): NormalizedFieldMappingEntry | null {
  if (typeof raw === 'string') return { fieldId: raw, direction: 'in' };
  if (raw && typeof raw === 'object' && typeof raw.field_id === 'string') {
    return { fieldId: raw.field_id, direction: raw.direction ?? 'in' };
  }
  return null;
}

/** The whole mapping, normalized — external_key -> {fieldId, direction}. */
export function normalizeFieldMapping(mapping: SourceFieldMapping): Record<string, NormalizedFieldMappingEntry> {
  const out: Record<string, NormalizedFieldMappingEntry> = {};
  for (const [externalKey, raw] of Object.entries(mapping)) {
    const entry = normalizeMappingEntry(raw);
    if (entry) out[externalKey] = entry;
  }
  return out;
}

/** Every field_id the mapping names, regardless of direction — the shape
 * every EXISTING caller (external_key_field_id validation, "does this
 * mapping include field X") wants, now that a value isn't always a bare id. */
export function mappedFieldIds(mapping: SourceFieldMapping): string[] {
  return Object.values(normalizeFieldMapping(mapping)).map((e) => e.fieldId);
}
