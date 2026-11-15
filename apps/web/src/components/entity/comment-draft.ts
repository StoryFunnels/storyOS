/**
 * Ticket #1277 — a half-typed comment survives (a) the record page crossing 900px and (b) navigating away and back.
 *
 * (a) The Activity / Comments / About panel is mounted by exactly ONE of two layouts (the side column from 900px, the stacked section
 * below it), so crossing the breakpoint unmounts one `CommentComposer` and mounts another, and the BlockNote editor's document died
 * with the old instance. (b) The record page itself unmounts on navigation, so a store owned by the page lost the draft too.
 *
 * So the store is a MODULE singleton (`commentDrafts`): in memory only for the session, keyed by `workspace/database/record`, so a
 * draft can never surface on another record. It is never written to disk or localStorage — a draft can contain anything.
 * It is cleared by a successful post (`set(key, null)`), by an identity change (sign-out, expired or swapped session: `clear()`,
 * called from `IdentitySync`) and when the user is looking at a different workspace (`dropOutside`).
 *
 * `doc` is BlockNote's document (opaque here); emptiness is decided by the caller, because only the caller knows BlockNote's
 * "an empty paragraph is empty" rule (`isDocEmpty`). Passing `null` clears.
 *
 * Focus: a remount from the breakpoint crossing must not drop keyboard focus, but must never STEAL it either. The unmounting composer
 * calls `handOffFocus` only if it held focus at that moment; the mounting one calls `takeFocusHandoff`, which is true once and only
 * within `FOCUS_HANDOFF_WINDOW_MS`. Coming back to a record later, or a composer that was not focused, gets nothing.
 */
export const FOCUS_HANDOFF_WINDOW_MS = 1500;

/**
 * Does this composer hold keyboard focus, for the purpose of handing it to its successor when it unmounts?
 *
 * Reading `document.activeElement` in the cleanup does not work: by then focus is already on <body>. The blur arrives EARLIER and
 * for a reason the composer must tell apart from the user clicking away. Observed live crossing 900px: the browser first hides the
 * outgoing layout (display:none, a blur with the composer box having no layout rects), and only ~70ms later does React swap in
 * the other layout and unmount it. So a blur counts as the layout's doing, not the user's, if either
 *   - the box is hidden when the blur lands (`hidden`), or
 *   - the composer is unmounted in the same event-loop turn as the blur, in either order (a blur delivered inside the unmounting commit).
 * A user's blur — clicking elsewhere, Tab — lands on a visible, still-mounted composer and clears it. `blur()` returns the deferred
 * second check, to be run in a microtask.
 */
export function createFocusTracker() {
  let holds = false;
  let unmounted = false;
  // A blur landed and its turn of the event loop has not finished: an unmount in the same turn is the same teardown.
  let blurPending = false;
  return {
    get holds() {
      return holds;
    },
    focus() {
      holds = true;
    },
    /** Focus is on its way (handed over, not yet landed): counts as held so a further remount inherits it. */
    expectFocus() {
      holds = true;
    },
    /** The focus never landed; do not pass on what nobody had. */
    giveUp() {
      holds = false;
    },
    mount() {
      unmounted = false;
    },
    unmount() {
      unmounted = true;
      if (blurPending) holds = true; // blur first, unmount in the same turn: the blur was the teardown's
    },
    /**
     * `hidden`: the box had no layout when the blur landed (the layout switch hid it). Returns the end-of-turn step, to be run in
     * a microtask, after which an unmount is no longer "the same turn" as this blur.
     */
    blur(opts: { hidden: boolean }) {
      holds = opts.hidden || unmounted; // unmount first, blur second (inside the unmounting commit): also the teardown's
      blurPending = true;
      return () => {
        blurPending = false;
      };
    },
  };
}

export interface CommentDraftStore {
  get(key: string): unknown[] | undefined;
  /** Store a non-empty draft; `null` (or an empty list) drops it. */
  set(key: string, doc: unknown[] | null): void;
  /** Drop every draft (identity change). */
  clear(): void;
  /** Drop every draft whose key is not inside `workspaceId` (the user moved to another workspace). */
  dropOutside(workspaceId: string): void;
  /** Called by a composer being unmounted WHILE it holds keyboard focus. */
  handOffFocus(key: string, now?: number): void;
  /** True at most once per hand-off, and only if it happened within the window. */
  takeFocusHandoff(key: string, now?: number): boolean;
}

export function createCommentDraftStore(): CommentDraftStore {
  const drafts = new Map<string, unknown[]>();
  const handoffs = new Map<string, number>();
  return {
    get: (key) => drafts.get(key),
    set(key, doc) {
      if (!doc || doc.length === 0) drafts.delete(key);
      else drafts.set(key, doc);
    },
    clear() {
      drafts.clear();
      handoffs.clear();
    },
    dropOutside(workspaceId) {
      const prefix = `${workspaceId}/`;
      for (const k of [...drafts.keys()]) if (!k.startsWith(prefix)) drafts.delete(k);
      for (const k of [...handoffs.keys()]) if (!k.startsWith(prefix)) handoffs.delete(k);
    },
    handOffFocus(key, now = Date.now()) {
      handoffs.set(key, now);
    },
    takeFocusHandoff(key, now = Date.now()) {
      const at = handoffs.get(key);
      handoffs.delete(key);
      return at !== undefined && now - at >= 0 && now - at <= FOCUS_HANDOFF_WINDOW_MS;
    },
  };
}

/** The session's one store. Module scope on purpose: the record page unmounts on navigation, this must not. */
export const commentDrafts: CommentDraftStore = createCommentDraftStore();
