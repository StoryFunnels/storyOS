import { isFilterGroup, nodeChildren } from '@/components/views/filter-config';
import type { FilterCondition, FilterGroup, FilterNode } from '@/components/views/filter-config';

/**
 * #928 — "Assigned to me": one shared view that shows each teammate their own records, and the words for it.
 *
 * The dynamic `me` value (#191) is stored verbatim as the id `'me'` and resolved per viewer at query time, so a
 * shared view works for everyone. What was missing was a name a person would recognise: "Assignee is Me (current
 * user)" is the system describing its own filter. Everything that SAYS it — the filter chip, the New view tile, the
 * name of a published copy — reads from here, so the product cannot say it two ways. Dara's mapping (prototype
 * `ME_LABEL`, v32); a field not listed falls back to "Me as <Field>".
 */
export const ME_ID = 'me';

const ME_LABEL: Record<string, string> = {
  assignee: 'Assigned to me',
  assignees: 'Assigned to me',
  'assigned to': 'Assigned to me',
  next: 'Assigned to me',
  owner: 'Owned by me',
  lead: 'Led by me',
  author: 'Written by me',
  editor: 'Edited by me',
  reviewer: 'Reviewed by me',
  requester: 'Requested by me',
  'created by': 'Created by me',
  'last edited by': 'Last edited by me',
};

/** "Assigned to me" for an Assignee field, "Owned by me" for Owner, "Me as Account manager" for the rest. */
export function meLabel(fieldName: string): string {
  const name = fieldName.trim();
  return ME_LABEL[name.toLowerCase()] ?? `Me as ${name}`;
}

/** The negated form: "Not assigned to me", "Not me as Account manager". */
export function notMeLabel(fieldName: string): string {
  const l = meLabel(fieldName);
  return `Not ${l.charAt(0).toLowerCase()}${l.slice(1)}`;
}

/** The value is Me ALONE (`'me'` or `['me']`). "Me, Iris" stays a list and keeps its long form. */
export function isOnlyMe(value: unknown): boolean {
  return value === ME_ID || (Array.isArray(value) && value.length === 1 && value[0] === ME_ID);
}

export function includesMe(value: unknown): boolean {
  return value === ME_ID || (Array.isArray(value) && value.includes(ME_ID));
}

/**
 * What a person-field condition reads as, or null when it is not a Me-alone condition on a person field (the caller
 * then uses its ordinary description). `eq`/`has` say it; `neq`/`has_none` negate it; any other operator
 * ("is empty") is not a statement about me, so it keeps its own words.
 */
export function meConditionText(fieldName: string, op: string, value: unknown): string | null {
  if (!isOnlyMe(value)) return null;
  if (op === 'eq' || op === 'has') return meLabel(fieldName);
  if (op === 'neq' || op === 'has_none') return notMeLabel(fieldName);
  return null;
}

/** The first LIVE condition anywhere in the tree on one of `personFields` whose value includes Me — the thing that
 *  makes a view "personal per viewer". Disabled conditions hide nothing, so they do not count. */
export function findMeCondition(
  filters: FilterGroup | FilterNode | undefined,
  personFields: ReadonlySet<string>,
): FilterCondition | undefined {
  if (!filters) return undefined;
  if (isFilterGroup(filters)) {
    for (const child of nodeChildren(filters)) {
      const hit = findMeCondition(child, personFields);
      if (hit) return hit;
    }
    return undefined;
  }
  return !filters.disabled && personFields.has(filters.field) && includesMe(filters.value) ? filters : undefined;
}

/** A view in this database that is already filtered to "<field> is me" (Me alone, so a hand-built "Me, Iris" list
 *  does not count) — the New view tile opens it instead of making "Assigned to me 2". */
export function findMeView<V extends { config: { filters?: FilterGroup } }>(
  views: V[],
  fieldApiName: string,
): V | undefined {
  const isThisField = (node: FilterNode | undefined): boolean => {
    if (!node) return false;
    if (isFilterGroup(node)) return nodeChildren(node).some(isThisField);
    return !node.disabled && node.field === fieldApiName && isOnlyMe(node.value) && (node.op === 'eq' || node.op === 'has');
  };
  return views.find((v) => isThisField(v.config.filters));
}

/** `base`, then `base 2`, `base 3`… against names already taken (case-insensitive). */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * The name of the copy published in place of a Me view (Otto's call, 2026-10-21): it says whose records it holds. A
 * view named by its Me label has the person swapped in — "Assigned to me" becomes "Assigned to Dara", "Me as Reviewer"
 * becomes "Dara as Reviewer" — which reads better than "Assigned to me — Dara’s records", a name that contradicts
 * itself. Any other name is "<View> — <Name>’s records".
 */
export function publishedCopyBase(viewName: string, meFieldName: string | null, author: string): string {
  const label = meFieldName ? meLabel(meFieldName) : null;
  if (label && viewName.startsWith(label)) {
    return label.replace(/\bme$/, author).replace(/^Me as /, `${author} as `);
  }
  return `${viewName} — ${author}’s records`;
}

/** The filter with every Me replaced by `userId` and nothing pinned, for the published copy: the author's own
 *  records, no stray "Assigned to me" chip on a view that no longer means that. */
export function swapMeForUser<N extends FilterNode>(node: N, userId: string): N {
  if (isFilterGroup(node)) {
    const kids = nodeChildren(node).map((k) => swapMeForUser(k, userId));
    return ('or' in node ? { or: kids } : { and: kids }) as unknown as N;
  }
  const value = Array.isArray(node.value)
    ? node.value.map((v) => (v === ME_ID ? userId : v))
    : node.value === ME_ID
      ? userId
      : node.value;
  return { ...node, value, pinned: false } as N;
}
