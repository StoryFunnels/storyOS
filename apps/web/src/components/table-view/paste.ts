import type { Field } from './use-table-data';
import { cellToText } from './cell-text';

/**
 * Cell paste coercion (MN-015, fixed by MN-119) — pure, so the rules are readable
 * and reviewable without a running grid.
 *
 * The original blocked `user` and `relation` outright ("not safely pasteable"),
 * which killed the feature's most-used case: filling an assignee down a column.
 * The caution was only justified for select/multi_select, whose option ids are
 * per-field and so must round-trip through labels.
 */

/** Refused — distinct from `null`, which is a legitimate "clear the cell". */
export const PASTE_WRONG_TARGET = Symbol('paste-wrong-target');

export interface CopiedCell {
  field: Field;
  value: unknown;
}

export function coercePaste(target: Field, text: string, copied: CopiedCell | null): unknown {
  const optId = (label: string) =>
    target.options?.find((o) => o.label.toLowerCase() === label.trim().toLowerCase())?.id;

  // Same FIELD: exact for every type — the ids are the same ids by definition.
  if (copied && copied.field.id === target.id) return copied.value;

  // Same TYPE, scalar: the value carries no field-specific identity.
  if (
    copied &&
    copied.field.type === target.type &&
    !['select', 'multi_select', 'relation', 'user'].includes(target.type)
  ) {
    return copied.value;
  }

  // user -> user: user ids are workspace-global, so this is trivially safe.
  // Reshape for the target's arity (single vs multi).
  if (copied && copied.field.type === 'user' && target.type === 'user') {
    const ids = (Array.isArray(copied.value) ? copied.value : [copied.value]).filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    return target.config?.['multi'] === true ? ids : (ids[0] ?? null);
  }

  // relation -> relation: only when both point at the same database, or the ids
  // mean nothing in the target. Chips are {id,title}; the API takes ids (MN-080).
  if (copied && copied.field.type === 'relation' && target.type === 'relation') {
    const from = copied.field.relation?.target_database_id;
    const to = target.relation?.target_database_id;
    if (!from || !to || from !== to) return PASTE_WRONG_TARGET;
    const chips = (copied.value as Array<{ id: string }> | null) ?? [];
    return chips.map((c) => c.id);
  }

  const t = (copied ? cellToText(copied.field, copied.value) : text).trim();
  switch (target.type) {
    case 'number':
    case 'currency':
    case 'percent': {
      if (t === '') return null;
      const n = Number(t.replace(/[,$%\s]/g, ''));
      return Number.isNaN(n) ? undefined : n;
    }
    case 'checkbox':
      return /^(true|1|yes|✓|checked|done)$/i.test(t);
    case 'select':
      return t === '' ? null : (optId(t) ?? undefined);
    case 'multi_select':
      return t
        .split(',')
        .map((s) => optId(s))
        .filter((x): x is string => Boolean(x));
    case 'rich_text':
      return t === '' ? null : [{ type: 'paragraph', content: [{ type: 'text', text: t }] }];
    case 'user':
      // External text: the API resolves a name/email to a real user id and names
      // the candidates if it can't (MN-118) — better than refusing on a guess here.
      return t === '' ? null : t;
    case 'relation':
      // A title can't become a record id client-side; use the record picker.
      return PASTE_WRONG_TARGET;
    default:
      return t; // text, title, url, email, date
  }
}
