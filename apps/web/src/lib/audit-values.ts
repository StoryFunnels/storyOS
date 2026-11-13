/**
 * Ticket #1287 — the field-change half of an audit row, with no raw id in it.
 *
 * A change names its field ("Name"), and the API already resolved a deleted field to "(deleted field)". A VALUE can still be an id:
 * a better-auth user id (an assignee; 32 letters and digits, NOT a uuid) or a uuid (a select option, a linked record). An id that is a
 * workspace member is shown as that member's name (an exact match, never a guess). An id that is nobody we know is NEVER printed and
 * NEVER explained with a made-up word ("removed", "not shown"): the whole change then reads as "Changed Phase", the clause omitted,
 * until the API sends option labels, relation titles and actor names (Marek, ticket #1287). Everything else is formatted by the one
 * Activity formatter, so an object value never reaches the page as "[object Object]".
 *
 * An empty "from" reads as "Set Name to …", not "Name: — → …" (ticket #1277's finding, the same row here).
 */
import { formatActivityValue, truncateText } from '@/components/entity/activity-format';

export const DELETED_FIELD_LABEL = 'a deleted field';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A better-auth user id: one unbroken run of letters and digits, long, with both. Ordinary words and codes ("Q4-2026") are shorter or lack a class. */
const AUTH_ID = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{20,}$/;

/** True for a string that is an identifier rather than words. */
export const isIdShaped = (v: unknown): boolean => typeof v === 'string' && (UUID.test(v) || AUTH_ID.test(v));

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function one(v: unknown, memberName: (id: string) => string | undefined): string {
  if (typeof v === 'string') {
    const member = memberName(v);
    if (member) return member;
    return truncateText(v);
  }
  return formatActivityValue(v, undefined, memberName);
}

/** True when a value holds an id that is not a member we can name: the value cannot be put in words without the API's help. */
function hasUnresolvedId(v: unknown, memberName: (id: string) => string | undefined): boolean {
  if (Array.isArray(v)) return v.some((x) => hasUnresolvedId(x, memberName));
  return isIdShaped(v) && !memberName(v as string);
}

/** A value as words, or null when it is empty. */
export function auditValueText(v: unknown, memberName: (id: string) => string | undefined): string | null {
  if (isEmpty(v)) return null;
  if (Array.isArray(v)) return v.map((x) => one(x, memberName)).join(', ');
  return one(v, memberName);
}

export interface AuditFieldChange {
  /** The field's name, or "a deleted field": never an id. */
  field: string;
  kind: 'set' | 'cleared' | 'changed';
  from: string | null;
  to: string | null;
}

export function describeFieldChange(
  field: string | undefined,
  oldValue: unknown,
  newValue: unknown,
  memberName: (id: string) => string | undefined,
): AuditFieldChange {
  const label = !field || field === '(deleted field)' ? DELETED_FIELD_LABEL : field;
  // Neither side is guessed at: "Changed Phase", the values omitted, rather than an id or a word standing in for one.
  if (hasUnresolvedId(oldValue, memberName) || hasUnresolvedId(newValue, memberName)) return { field: label, kind: 'changed', from: null, to: null };
  const from = auditValueText(oldValue, memberName);
  const to = auditValueText(newValue, memberName);
  const kind = from === null && to !== null ? 'set' : to === null && from !== null ? 'cleared' : 'changed';
  return { field: label, kind, from, to };
}

/**
 * Who an audit row says acted. The API names the member (`actor_name`); "(unknown)" is its word for one it could not resolve, and a
 * name that is itself an id is never printed. Resolve by the id through the members list when there is one, else a neutral "Someone":
 * it asserts nothing (not "removed", not "system") until the API sends the real label (ticket #1287).
 */
export function auditActorLabel(
  actorName: string | null | undefined,
  actorId: string | null | undefined,
  memberName: (id: string) => string | undefined,
): string {
  const name = typeof actorName === 'string' ? actorName.trim() : '';
  if (name && name !== '(unknown)' && !isIdShaped(name)) return name;
  if (name && isIdShaped(name)) return memberName(name) ?? 'Someone';
  return (actorId ? memberName(actorId) : undefined) ?? 'Someone';
}
