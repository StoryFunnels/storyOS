/**
 * Ticket #1311 — what the delete confirm says about a field's data, from the usage endpoint
 * (`GET .../fields/:field/usage` → `{ records_with_value, storage, complete }`, ticket #1308).
 *
 * One pure function so every branch is testable. The rules it holds, each of which is a way a confirm can lie:
 *  - A count is only ever said when the usage call answered. Unknown is silence, never "0".
 *  - `storage` computed_values / derived_from_links: nothing is stored on the records, so nothing "will be lost".
 *  - `complete: false`: the count covers only what the viewer can see. It is a floor ("at least N"), never the total, and a zero is
 *    never confident ("you may not be able to see").
 */
export interface FieldUsage {
  count: number;
  storage: string;
  complete: boolean;
}

export type FieldDeleteKind = 'field' | 'relation';

/** Reads the usage response; anything that is not the full documented shape is "unknown" (null), not a zero. */
export function parseFieldUsage(data: unknown): FieldUsage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.records_with_value !== 'number' || typeof d.storage !== 'string' || typeof d.complete !== 'boolean') return null;
  return { count: d.records_with_value, storage: d.storage, complete: d.complete };
}

/** Storage kinds where the value lives on the record or its links, so deleting the field destroys it. */
const DESTROYS_DATA = new Set(['record_values', 'title', 'system_column', 'record_links']);

export function fieldDeleteMessage({
  kind,
  usage,
  otherDatabaseName,
}: {
  kind: FieldDeleteKind;
  /** null = the usage call failed or answered something unreadable. */
  usage: FieldUsage | null;
  /** Relations only: the database holding the inverse field. */
  otherDatabaseName?: string;
}): string | undefined {
  if (kind === 'relation') {
    const other = otherDatabaseName ?? 'the other database';
    const base = `This removes the relation, BOTH paired fields (this one and its inverse on ${other}), and every link between records. This can't be undone.`;
    if (!usage || usage.storage !== 'record_links') return base;
    if (usage.complete) {
      return usage.count > 0
        ? `${base} ${usage.count} record(s) here hold links, and those links will be deleted.`
        : `${base} No record here holds a link through it.`;
    }
    return usage.count > 0
      ? `${base} At least ${usage.count} record(s) that you can see hold links; you can't see them all, so there may be more.`
      : `${base} You can't see every record on the other side, so links may exist that this can't count.`;
  }

  if (!usage) return undefined;
  if (usage.storage === 'computed_values') {
    return `This field's value is recalculated from other fields, not stored on the records, so deleting it removes no record data. Delete anyway?`;
  }
  if (usage.storage === 'derived_from_links') {
    return `This field's value is read from linked records, not stored on the records, so deleting it removes no record data. Delete anyway?`;
  }
  if (!DESTROYS_DATA.has(usage.storage)) return undefined;
  if (usage.complete) {
    return usage.count > 0 ? `This field has values on ${usage.count} record(s). They'll be lost. Delete anyway?` : undefined;
  }
  return usage.count > 0
    ? `This field has values on at least ${usage.count} record(s) that you can see; you can't see them all, so there may be more. They'll be lost. Delete anyway?`
    : `You can't see every record, so this field may hold values you can't see. They'll be lost. Delete anyway?`;
}
