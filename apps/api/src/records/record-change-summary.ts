/**
 * #236 — a human "what changed" line for a record_changed notification, e.g.
 *   Status: Todo → Done · Priority: Low → High
 * Built from the changed fields plus the pre/post value maps (both keyed by
 * field id, exactly as stored). Select/workflow option ids resolve to labels
 * via `optionLabels`; everything else is stringified defensively. Capped so a
 * bulk edit produces a preview, not a wall of text.
 */
export interface ChangeSummaryField {
  id: string;
  label: string;
  type: string;
}

const EMPTY = 'empty';

function formatValue(type: string, value: unknown, optionLabels: ReadonlyMap<string, string>): string {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return EMPTY;
  }
  if ((type === 'select' || type === 'workflow') && typeof value === 'string') {
    return optionLabels.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return optionLabels.get(v) ?? v; // multi_select ids
        if (v && typeof v === 'object') return (v as { title?: string }).title ?? ''; // relation chips
        return String(v);
      })
      .filter(Boolean)
      .join(', ');
  }
  if (typeof value === 'object') return (value as { title?: string }).title ?? JSON.stringify(value);
  return String(value);
}

export function summarizeChanges(
  changed: ChangeSummaryField[],
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  optionLabels: ReadonlyMap<string, string>,
  opts: { max?: number } = {},
): string {
  const max = opts.max ?? 5;
  const parts: string[] = [];
  for (const field of changed) {
    const from = formatValue(field.type, before[field.id], optionLabels);
    const to = formatValue(field.type, after[field.id], optionLabels);
    if (from === to) continue; // e.g. a relation-only touch with no value delta
    parts.push(`${field.label}: ${from} → ${to}`);
  }
  if (parts.length === 0) return '';
  if (parts.length <= max) return parts.join(' · ');
  return `${parts.slice(0, max).join(' · ')} · +${parts.length - max} more`;
}
