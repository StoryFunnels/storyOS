/**
 * #1094 — "New space" opens what it just made, WITH THE NAME IN EDIT MODE, selected, so a space takes one click and then typing.
 *
 * Same one-shot pattern as `new-doc-focus.ts`: the creator marks the id before navigating; the space page consumes the mark
 * once. A flag rather than a query param so a reload or the back button never re-focuses, and rather than "edit whenever the
 * name is Untitled space" so opening an old untitled space (or a space a pack or template made) does not steal focus.
 */
const KEY = 'storyos-new-space';

/** What a space made by one click is called until the person types over it. Repeats are fine: the API makes the slug unique. */
export const UNTITLED_SPACE = 'Untitled space';

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function markNewSpace(id: string): void {
  try {
    store()?.setItem(KEY, id);
  } catch {
    /* storage blocked: the space still opens, its name is just not in edit mode */
  }
}

/** True exactly once for an id that was marked, then false. */
export function consumeNewSpace(id: string): boolean {
  try {
    const s = store();
    if (!s || s.getItem(KEY) !== id) return false;
    s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
