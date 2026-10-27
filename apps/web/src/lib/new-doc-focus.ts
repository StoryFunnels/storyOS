/**
 * #1090 — "New document" opens what it just made, WITH THE TITLE FOCUSED, so a page takes one click and then typing.
 *
 * The creator marks the id before navigating; the document page consumes the mark once. A one-shot flag rather than a
 * query param so a reload or the back button never re-focuses, and rather than "focus whenever the title is Untitled"
 * so opening an old untitled document, or a document a template or pack just installed, does not steal focus (those
 * paths never call `markNewDocument`).
 */
const KEY = 'storyos-new-doc';

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function markNewDocument(id: string): void {
  try {
    store()?.setItem(KEY, id);
  } catch {
    /* storage blocked: the document still opens, it just is not focused */
  }
}

/** True exactly once for an id that was marked, then false. */
export function consumeNewDocument(id: string): boolean {
  try {
    const s = store();
    if (!s || s.getItem(KEY) !== id) return false;
    s.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
