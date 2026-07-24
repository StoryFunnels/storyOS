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

/**
 * MN-292: the fill-down source grid for a range paste. `pasteRange` used to
 * look only at the multi-cell range copy and silently drop a plain single-
 * cell copy (`copyCell`, not `copyRange`) the moment a range was selected
 * afterwards (e.g. copy one relation/select cell, shift+arrow down to select
 * the rows below, paste to fill them all) — falling back to lossy clipboard
 * text instead. That's a guaranteed no-op for relation targets (`coercePaste`
 * deliberately refuses a plain-text relation paste below) and a fragile
 * label-text match for select targets. Folding the single-cell copy into a
 * 1x1 grid here gives a range fill-down the same full field fidelity a
 * single-cell paste already has.
 */
export function resolvePasteSource(
  rangeCopy: CopiedCell[][] | null,
  singleCopy: CopiedCell | null,
): CopiedCell[][] | null {
  return rangeCopy ?? (singleCopy ? [[singleCopy]] : null);
}

export function coercePaste(target: Field, text: string, copied: CopiedCell | null): unknown {
  const optId = (label: string) =>
    target.options?.find((o) => o.label.toLowerCase() === label.trim().toLowerCase())?.id;

  // Same FIELD: exact for every type — the ids are the same ids by definition.
  //
  // EXCEPT relation: `copied.value` for a relation cell is the display shape,
  // {id,title}[] chips (fieldValue/cells.tsx reads row.values[apiName]
  // straight from the server's resolved response) — never bare ids, even
  // when the source and target are literally the same field/column. Sending
  // chip objects as a values payload trips the backend's relation-value
  // validator ("expected an array of record ids or numbers"), because it
  // only accepts string/number entries, not objects. This is the single most
  // common relation-paste case (fill a relation column down/across several
  // rows in the SAME column) and was the one path the dedicated relation →
  // relation handling below never covered — that logic only ran when
  // `copied.field.id !== target.id`. Falling through to it here is safe: for
  // a same-field copy, `from === to` trivially, so it only ever extracts ids
  // or cleanly refuses, exactly like a cross-field same-database paste does.
  if (copied && copied.field.id === target.id && target.type !== 'relation') return copied.value;

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
  //
  // MN-291: `copied.value` is supposed to always be real {id,title} chips (what
  // the server attaches when it resolves a relation field), but a relation
  // paste's own optimistic cache update writes the mutation payload straight
  // into the cache — a plain array of id strings, not chip objects — until the
  // mutation settles and a refetch corrects it. Copy that same cell during
  // that window and `copied.value` is `string[]`, not `{id}[]`; blindly
  // mapping `.id` over it yields `[undefined, ...]`, which JSON-serializes to
  // `[null, ...]` on the wire and trips the backend's raw "expected an array
  // of record ids or numbers" validation instead of either succeeding or
  // refusing cleanly. Filter to real, non-empty string ids so only a
  // well-shaped value (or a clean refusal) ever reaches the mutation; a
  // non-empty source that yields nothing valid refuses outright rather than
  // silently sending a partial/empty relation set.
  if (copied && copied.field.type === 'relation' && target.type === 'relation') {
    const from = copied.field.relation?.target_database_id;
    const to = target.relation?.target_database_id;
    if (!from || !to || from !== to) return PASTE_WRONG_TARGET;
    const raw = copied.value;
    if (raw != null && !Array.isArray(raw)) return PASTE_WRONG_TARGET;
    const chips = (raw as unknown[] | null) ?? [];
    const ids = chips
      .map((c) => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0 && chips.length > 0) return PASTE_WRONG_TARGET;
    return ids;
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
