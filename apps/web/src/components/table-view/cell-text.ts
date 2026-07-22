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

/** Resolves a better-auth user id to the display name shown on screen for it;
 * falls back to the raw id when no resolver is supplied (MN-294) or the id
 * isn't found (e.g. a member who's left the workspace). */
export type MemberNameResolver = (id: string) => string;

/** Plain-text rendering of a cell value for the clipboard (MN-015 copy/paste).
 *
 * `resolveMemberName` is optional — the only caller that omits it is `paste.ts`'s
 * cross-type coercion fallback, which is a pure module with no access to member
 * data; that path is unrelated to MN-294 (this ticket is about the clipboard TEXT
 * representation from `table-view.tsx`'s copy actions, which do pass a resolver).
 */
export function cellToText(
  field: { type: string; options?: SelectOption[] },
  value: unknown,
  resolveMemberName?: MemberNameResolver,
): string {
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
    // MN-294: user ids are raw better-auth ids on the wire — copy the display
    // name(s) shown on screen instead, comma-separated for multi-user (matching
    // the multi_select convention above).
    case 'user': {
      const ids = (Array.isArray(value) ? value : [value]).filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      return ids.map((id) => resolveMemberName?.(id) ?? id).join(', ');
    }
    case 'date': {
      const d = new Date(String(value));
      return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
    }
    default:
      return String(value);
  }
}
