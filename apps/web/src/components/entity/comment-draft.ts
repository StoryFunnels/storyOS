/**
 * Ticket #1277 follow-up — a half-typed comment must survive the record page crossing 900px.
 *
 * The Activity / Comments / About panel is mounted by exactly ONE of two layouts (the side column from 900px, the stacked section
 * below it), so crossing the breakpoint unmounts one `CommentComposer` and mounts another, and the BlockNote editor's document died
 * with the old instance. The draft therefore lives in a store owned by the record page (which does not remount), keyed by record, and
 * each composer seeds itself from it on mount and writes to it on change. A successful post clears it.
 *
 * `doc` is BlockNote's document (opaque here); emptiness is decided by the caller, because only the caller knows BlockNote's
 * "an empty paragraph is empty" rule (`isDocEmpty`). Passing `null` clears.
 */
export interface CommentDraftStore {
  get(key: string): unknown[] | undefined;
  /** Store a non-empty draft; `null` (or an empty list) drops it. */
  set(key: string, doc: unknown[] | null): void;
}

export function createCommentDraftStore(): CommentDraftStore {
  const drafts = new Map<string, unknown[]>();
  return {
    get: (key) => drafts.get(key),
    set(key, doc) {
      if (!doc || doc.length === 0) drafts.delete(key);
      else drafts.set(key, doc);
    },
  };
}
