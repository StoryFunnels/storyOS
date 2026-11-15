import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommentDraftStore } from './comment-draft';

// Ticket #1277 follow-up. The remount itself (side column <-> stacked section) needs a DOM and is checked live; these pin the store
// the two composers share and that both layouts are handed the SAME one.
describe('createCommentDraftStore', () => {
  const doc = [{ type: 'paragraph', content: 'half a thought' }];

  it('hands a draft written by one composer to the next one mounted for the same record', () => {
    const store = createCommentDraftStore();
    store.set('r1', doc); // the side-column composer, as the user types
    expect(store.get('r1')).toEqual(doc); // the stacked composer, mounting after the resize
  });

  it('keeps drafts per record', () => {
    const store = createCommentDraftStore();
    store.set('r1', doc);
    expect(store.get('r2')).toBeUndefined();
  });

  it('clears on null and on an empty list (a posted or deleted draft must not come back)', () => {
    const store = createCommentDraftStore();
    store.set('r1', doc);
    store.set('r1', null);
    expect(store.get('r1')).toBeUndefined();
    store.set('r1', doc);
    store.set('r1', []);
    expect(store.get('r1')).toBeUndefined();
  });
});

describe('the record page wires one store into both layouts', () => {
  const detail = readFileSync(join(__dirname, 'record-detail.tsx'), 'utf8');
  const panels = readFileSync(join(__dirname, 'panels.tsx'), 'utf8');

  it('creates the store once in the record page and passes it down the shared panel body', () => {
    expect(detail.match(/useState\(createCommentDraftStore\)/g)?.length).toBe(1);
    expect(detail).toContain('drafts={commentDrafts}');
  });

  it('seeds the composer from the store and writes back on change and clears on post', () => {
    expect(panels).toContain('initialContent: drafts?.get(draftKey) as never');
    expect(panels).toContain('drafts?.set(draftKey, isDocEmpty(doc) ? null : doc)');
    expect(panels).toContain('drafts?.set(draftKey, null)');
  });
});
