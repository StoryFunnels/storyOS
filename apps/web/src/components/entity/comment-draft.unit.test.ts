import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentDrafts, createCommentDraftStore, createFocusTracker, FOCUS_HANDOFF_WINDOW_MS } from './comment-draft';

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
  it('an identity change clears the drafts', () => {
    expect(providers).toContain('commentDrafts.clear()');
  });
});
