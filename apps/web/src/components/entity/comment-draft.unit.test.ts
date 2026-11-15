import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentDraftKey, commentDrafts, createCommentDraftStore, createFocusTracker, FOCUS_HANDOFF_WINDOW_MS, onWorkspaceChange } from './comment-draft';

// Ticket #1277. The remount itself (side column <-> stacked section) needs a real DOM + BlockNote (which cannot render in node:
// `useCreateBlockNote` touches `window`), so it is checked live; these pin the store the composers share.
const doc = [{ type: 'paragraph', content: 'half a thought' }];

describe('createCommentDraftStore: drafts', () => {
  it('hands a draft written by one composer to the next one mounted for the same record', () => {
    const store = createCommentDraftStore();
    store.set('w/d/r1', doc); // the side-column composer, as the user types
    expect(store.get('w/d/r1')).toEqual(doc); // the stacked composer, mounting after the resize
  });

  it("never shows record A's draft on record B (or in another database or workspace)", () => {
    const store = createCommentDraftStore();
    store.set('w/d/r1', doc);
    expect(store.get('w/d/r2')).toBeUndefined();
    expect(store.get('w/other/r1')).toBeUndefined();
    expect(store.get('w2/d/r1')).toBeUndefined();
  });

  it('clears on null and on an empty list (a posted or deleted draft must not come back)', () => {
    const store = createCommentDraftStore();
    store.set('w/d/r1', doc);
    store.set('w/d/r1', null);
    expect(store.get('w/d/r1')).toBeUndefined();
    store.set('w/d/r1', doc);
    store.set('w/d/r1', []);
    expect(store.get('w/d/r1')).toBeUndefined();
  });

  it('clearing one record leaves the others (sending on A must not eat the half comment on B)', () => {
    const store = createCommentDraftStore();
    store.set('w/d/a', doc);
    store.set('w/d/b', doc);
    store.set('w/d/a', null);
    expect(store.get('w/d/a')).toBeUndefined();
    expect(store.get('w/d/b')).toEqual(doc);
  });

  it('clear() drops everything (sign-out / identity change)', () => {
    const store = createCommentDraftStore();
    store.set('w/d/a', doc);
    store.set('w2/d/b', doc);
    store.handOffFocus('w/d/a', 0);
    store.clear();
    expect(store.get('w/d/a')).toBeUndefined();
    expect(store.get('w2/d/b')).toBeUndefined();
    expect(store.takeFocusHandoff('w/d/a', 1)).toBe(false);
  });

  it('dropOutside(ws) keeps that workspace and drops the rest, and does not match a workspace id by prefix', () => {
    const store = createCommentDraftStore();
    store.set('w1/d/a', doc);
    store.set('w10/d/a', doc);
    store.set('w2/d/a', doc);
    store.dropOutside('w1');
    expect(store.get('w1/d/a')).toEqual(doc);
    expect(store.get('w10/d/a')).toBeUndefined();
    expect(store.get('w2/d/a')).toBeUndefined();
  });
});

describe('onWorkspaceChange: the active workspace changed', () => {
  it('drops a draft keyed to the workspace the user left (draft in WS1, now looking at WS2)', () => {
    const store = createCommentDraftStore();
    store.set('ws1/d/r', doc);
    store.handOffFocus('ws1/d/r', 0);
    onWorkspaceChange(store, 'ws2'); // WS2's home page: no RecordDetail mounts, and the draft must still go
    expect(store.get('ws1/d/r')).toBeUndefined();
    expect(store.takeFocusHandoff('ws1/d/r', 1)).toBe(false);
    onWorkspaceChange(store, 'ws1'); // ...and coming back to the WS1 record finds nothing
    expect(store.get('ws1/d/r')).toBeUndefined();
  });

  it('keeps every draft in the workspace being shown (same-workspace navigation and re-renders)', () => {
    const store = createCommentDraftStore();
    store.set('ws1/d/a', doc);
    store.set('ws1/d2/b', doc);
    onWorkspaceChange(store, 'ws1');
    onWorkspaceChange(store, 'ws1');
    expect(store.get('ws1/d/a')).toEqual(doc);
    expect(store.get('ws1/d2/b')).toEqual(doc);
  });
});

describe('the draft store never touches browser storage', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // The store module plus anything it imports by a relative path (it has none today; a future import is scanned too).
  const files = new Set<string>([join(__dirname, 'comment-draft.ts')]);
  for (const f of [...files]) {
    for (const m of strip(readFileSync(f, 'utf8')).matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
      for (const ext of ['.ts', '.tsx']) {
        try {
          const p = join(f, '..', m[1] + ext);
          readFileSync(p);
          files.add(p);
        } catch {
          /* not this extension */
        }
      }
    }
  }
  it.each([...files])('%s', (f) => {
    expect(strip(readFileSync(f, 'utf8'))).not.toMatch(/localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie/);
  });
});

describe('commentDraftKey: one identity per record (an in-place switch must not reuse a composer)', () => {
  it('differs whenever the record, database or workspace differs, so the composer remounts and loads its own draft', () => {
    const a = commentDraftKey('w', 'd', 'r1');
    expect(commentDraftKey('w', 'd', 'r2')).not.toBe(a);
    expect(commentDraftKey('w', 'd2', 'r1')).not.toBe(a);
    expect(commentDraftKey('w2', 'd', 'r1')).not.toBe(a);
    expect(commentDraftKey('w', 'd', 'r1')).toBe(a);
  });
  it("record B's composer seeds from B's own draft, never A's text", () => {
    const store = createCommentDraftStore();
    store.set(commentDraftKey('w', 'd', 'A'), doc);
    expect(store.get(commentDraftKey('w', 'd', 'B'))).toBeUndefined();
    expect(store.get(commentDraftKey('w', 'd', 'A'))).toEqual(doc);
  });
});

describe('createCommentDraftStore: focus hand-off across the remount', () => {
  it('gives focus to the composer that mounts right after a focused one unmounted, exactly once', () => {
    const store = createCommentDraftStore();
    store.handOffFocus('w/d/r', 1000);
    expect(store.takeFocusHandoff('w/d/r', 1010)).toBe(true);
    expect(store.takeFocusHandoff('w/d/r', 1011)).toBe(false);
  });

  it('never steals focus: nothing handed off means nothing taken', () => {
    const store = createCommentDraftStore();
    expect(store.takeFocusHandoff('w/d/r', 1000)).toBe(false);
  });

  it('does not hand focus to a different record', () => {
    const store = createCommentDraftStore();
    store.handOffFocus('w/d/a', 1000);
    expect(store.takeFocusHandoff('w/d/b', 1001)).toBe(false);
  });

  it('a late return (navigated away and back) does not steal focus', () => {
    const store = createCommentDraftStore();
    store.handOffFocus('w/d/r', 1000);
    expect(store.takeFocusHandoff('w/d/r', 1000 + FOCUS_HANDOFF_WINDOW_MS + 1)).toBe(false);
  });
});

describe('createFocusTracker: does an unmounting composer hold focus?', () => {
  it('blur delivered, then the unmount in the same turn: the blur was the teardown, focus is held', () => {
    const t = createFocusTracker();
    t.mount();
    t.focus();
    t.blur({ hidden: false }); // not yet settled: same turn
    t.unmount();
    expect(t.holds).toBe(true);
  });

  it('unmounted first, then the blur arrives inside that commit: also the teardown', () => {
    const t = createFocusTracker();
    t.mount();
    t.focus();
    t.unmount();
    t.blur({ hidden: false });
    expect(t.holds).toBe(true);
  });

  it('a blur that lands while the layout switch has hidden the composer is the layout\'s doing, not the user\'s', () => {
    const t = createFocusTracker();
    t.mount();
    t.focus();
    t.blur({ hidden: true })(); // display:none first (composer still mounted ~70ms), the unmount comes much later
    expect(t.holds).toBe(true);
  });

  it('a user who clicked away (visible, still mounted, turn over) does not hold focus, even if it unmounts later', () => {
    const t = createFocusTracker();
    t.mount();
    t.focus();
    t.blur({ hidden: false })(); // the microtask ran
    expect(t.holds).toBe(false);
    t.unmount(); // e.g. they then navigated away
    expect(t.holds).toBe(false);
  });

  it('a composer that never had focus holds nothing, even when torn down (focus is never stolen)', () => {
    const t = createFocusTracker();
    t.mount();
    t.unmount();
    expect(t.holds).toBe(false);
  });

  it('handed-over focus that has not landed yet is still passed on, until it is given up', () => {
    const t = createFocusTracker();
    t.mount();
    t.expectFocus();
    expect(t.holds).toBe(true); // a second remount in the same crossing inherits it
    t.giveUp();
    expect(t.holds).toBe(false);
  });

  it('a user blur after the focus landed clears it', () => {
    const t = createFocusTracker();
    t.mount();
    t.expectFocus();
    t.focus();
    t.blur({ hidden: false })();
    expect(t.holds).toBe(false);
  });
});

describe('the session store survives navigation', () => {
  it('is one shared module instance, so the record page unmounting does not lose the draft', async () => {
    commentDrafts.set('w/d/nav', doc);
    // What a route change does: the module is imported again by the next page. Same instance, same drafts.
    const again = (await import('./comment-draft')).commentDrafts;
    expect(again).toBe(commentDrafts);
    expect(again.get('w/d/nav')).toEqual(doc);
    expect(again.get('w/d/elsewhere')).toBeUndefined();
    again.set('w/d/nav', null);
  });
});

// LAST RESORT, stated: BlockNote cannot render under node, so the composer's use of the store cannot be exercised here. These
// source greps only pin that the wiring exists; the behaviour is covered by the store tests above and by the live resize/navigate check.
describe('wiring (source grep: BlockNote cannot render in node)', () => {
  const panels = readFileSync(join(__dirname, 'panels.tsx'), 'utf8');
  const detail = readFileSync(join(__dirname, 'record-detail.tsx'), 'utf8');
  const providers = readFileSync(join(__dirname, '../../app/providers.tsx'), 'utf8');
  const wsLayout = readFileSync(join(__dirname, '../../app/w/[ws]/layout.tsx'), 'utf8');

  it('the record page passes the shared singleton, not a per-page store', () => {
    expect(detail).toContain('drafts={commentDrafts}');
    expect(detail).not.toContain('createCommentDraftStore');
  });
  it('the composer seeds from, writes to, and clears the store; and hands focus over on unmount', () => {
    expect(panels).toContain('initialContent: drafts?.get(draftKey) as never');
    expect(panels).toContain('drafts?.set(draftKey, isDocEmpty(doc) ? null : doc)');
    expect(panels).toContain('drafts?.set(draftKey, null)');
    expect(panels).toContain('drafts?.handOffFocus(draftKey)');
    expect(panels).toContain('queueMicrotask(focusTracker.blur(');
    expect(panels).toContain('drafts?.takeFocusHandoff(draftKey)');
  });
  // The in-place switch (peek/split pane re-targeted: same RecordDetail, new `rec`) is invisible to a store test; the guard is that
  // the composer is keyed by the record, and that the draft key it seeds/posts with is the same helper.
  it('the composer is keyed by record, so an in-place record switch remounts it (no cross-record Send)', () => {
    expect(panels).toContain('<CommentComposer key={commentDraftKey(ws, db, rec)}');
    expect(panels).toContain('const draftKey = commentDraftKey(ws, db, rec);');
  });
  it('an identity change clears the drafts', () => {
    expect(providers).toContain('commentDrafts.clear()');
  });
  // Why a grep: the effect lives in a layout that needs the router and a session to render. The decision itself
  // (onWorkspaceChange) is behaviourally tested above; this only pins that the layout, which runs on every workspace page, calls it,
  // and that the old per-record wiring is not the thing holding it (that was the bug: it ran only when a RecordDetail mounted).
  it('the workspace layout drops other workspaces\' drafts when the workspace changes, on every page', () => {
    expect(wsLayout).toMatch(/useEffect\(\(\) => \{\s*onWorkspaceChange\(commentDrafts, ws\);\s*\}, \[ws\]\)/);
  });
  it('the record page does not carry the workspace clear (it only ran when a record mounted)', () => {
    expect(detail).not.toContain('dropOutside');
  });
});
