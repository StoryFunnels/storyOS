import type { SelectOption } from './use-table-data';

/**
 * Pure cell → plain-text helpers, split out of cells.tsx so they can be imported
 * (and unit-tested) without dragging in React and the whole component tree — the
 * reason paste.ts's logic was untestable before (MN-135).
 */

/** Plain text of a BlockNote document, for grid previews. */
export function richTextPreview(blocks: unknown, max = 200): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (out.join(' ').length > max) return;
      if (typeof node !== 'object' || node === null) continue;
      const block = node as { content?: unknown; children?: unknown[]; text?: unknown };
      if (typeof block.text === 'string') out.push(block.text);
      if (Array.isArray(block.content)) walk(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ').trim().slice(0, max);
}

/** Plain-text rendering of a cell value for the clipboard (MN-015 copy/paste). */
export function cellToText(field: { type: string; options?: SelectOption[] }, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  switch (field.type) {
    case 'rich_text':
      return richTextPreview(value, 100000);
    case 'select':
      return field.options?.find((o) => o.id === value)?.label ?? String(value);
    case 'multi_select': {
      const ids = Array.isArray(value) ? value : [value];
      return ids.map((id) => field.options?.find((o) => o.id === id)?.label ?? String(id)).join(', ');
    }
    case 'checkbox':
      return value === true ? 'true' : 'false';
    case 'relation': {
      const chips = (value as Array<{ title?: string }>) ?? [];
      return chips.map((c) => c.title ?? '').filter(Boolean).join(', ');
    }
    case 'date': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
    }
    default:
      return String(value);
  }
}
