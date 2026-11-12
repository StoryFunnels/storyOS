/**
 * Ticket #1287 — the field-change half of an audit row, with no raw id in it.
 *
 * A change names its field ("Name"), and the API already resolved a deleted field to "(deleted field)". A VALUE can still be a bare
 * member id (an assignee) or, rarely, another uuid. An id that is a workspace member is shown as that member's name (an exact match,
 * never a guess); a uuid we cannot resolve is "(not shown)", never the uuid. Everything else is formatted by the one Activity
 * formatter, so an object value never reaches the page as "[object Object]".
 *
 * An empty "from" reads as "Set Name to …", not "Name: — → …" (ticket #1277's finding, the same row here).
 */
import { formatActivityValue, truncateText } from '@/components/entity/activity-format';

export const DELETED_FIELD_LABEL = 'a deleted field';
export const NOT_SHOWN = '(not shown)';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function one(v: unknown, memberName: (id: string) => string | undefined): string {
  if (typeof v === 'string') {
    const member = memberName(v);
    if (member) return member;
    if (UUID.test(v)) return NOT_SHOWN;
    return truncateText(v);
  }
  return formatActivityValue(v, undefined, memberName);
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
  const from = auditValueText(oldValue, memberName);
  const to = auditValueText(newValue, memberName);
  const kind = from === null && to !== null ? 'set' : to === null && from !== null ? 'cleared' : 'changed';
  return { field: label, kind, from, to };
}
