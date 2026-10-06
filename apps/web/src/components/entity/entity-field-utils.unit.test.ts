import { describe, expect, it } from 'vitest';
import { NOT_INLINE, computedBadgeLabel, hidesWhenEmpty, isEmptyBlocks, isHidden } from './entity-field-utils';

/**
 * #776 — a computed field must never get the ordinary click-to-edit
 * affordance: it lies about being writable, and for `ai` specifically a write
 * attempt errors server-side (record-values.ts's `coerce()` has no case for
 * it). `ai` was added (#571) after this set was written and missed it.
 */
describe('NOT_INLINE', () => {
  it('rejects every computed field type', () => {
    expect(NOT_INLINE.has('lookup')).toBe(true);
    expect(NOT_INLINE.has('rollup')).toBe(true);
    expect(NOT_INLINE.has('formula')).toBe(true);
    expect(NOT_INLINE.has('button')).toBe(true);
    expect(NOT_INLINE.has('ai')).toBe(true);
  });

  it('keeps the audit fields it already covered', () => {
    expect(NOT_INLINE.has('created_at')).toBe(true);
    expect(NOT_INLINE.has('updated_at')).toBe(true);
    expect(NOT_INLINE.has('created_by')).toBe(true);
  });

  it('still allows a real typed field to inline-edit', () => {
    expect(NOT_INLINE.has('text')).toBe(false);
    expect(NOT_INLINE.has('number')).toBe(false);
    expect(NOT_INLINE.has('select')).toBe(false);
  });
});

describe('computedBadgeLabel (#811)', () => {
  it('badges the derived types, which is where the badge carries information', () => {
    expect(computedBadgeLabel('formula')).toBe('formula');
    expect(computedBadgeLabel('rollup')).toBe('rollup');
    expect(computedBadgeLabel('lookup')).toBe('lookup');
    expect(computedBadgeLabel('ai')).toBe('ai');
  });

  it('badges the audit fields as "system"', () => {
    expect(computedBadgeLabel('created_at')).toBe('system');
    expect(computedBadgeLabel('updated_at')).toBe('system');
    expect(computedBadgeLabel('created_by')).toBe('system');
  });

  it('does NOT badge a button: it holds no derived value and labels itself', () => {
    expect(computedBadgeLabel('button')).toBeNull();
  });

  it('does not badge an ordinary editable field', () => {
    for (const t of ['text', 'number', 'select', 'checkbox', 'relation', 'color']) {
      expect(computedBadgeLabel(t), t).toBeNull();
    }
  });
});

describe('isEmptyBlocks (#813)', () => {
  it('treats null, undefined and [] as empty', () => {
    expect(isEmptyBlocks(null)).toBe(true);
    expect(isEmptyBlocks(undefined)).toBe(true);
    expect(isEmptyBlocks([])).toBe(true);
  });

  it('treats the blank document BlockNote creates as empty', () => {
    expect(isEmptyBlocks([{ type: 'paragraph', content: [], children: [] }])).toBe(true);
    expect(isEmptyBlocks([{ type: 'paragraph' }])).toBe(true);
    expect(isEmptyBlocks([{ type: 'paragraph', content: [{ type: 'text', text: '  ', styles: {} }] }])).toBe(true);
    expect(isEmptyBlocks([{ type: 'paragraph' }, { type: 'paragraph' }])).toBe(true);
  });

  // The cases the filter must KEEP: calling real content "empty" would hide
  // someone's writing behind a one-line add affordance.
  it('keeps real text as content', () => {
    expect(isEmptyBlocks([{ type: 'paragraph', content: [{ type: 'text', text: 'hi', styles: {} }] }])).toBe(false);
    expect(isEmptyBlocks([{ type: 'paragraph', content: 'hi' }])).toBe(false);
  });

  it('keeps non-paragraph blocks as content even with no text', () => {
    expect(isEmptyBlocks([{ type: 'image', props: {} }])).toBe(false);
    expect(isEmptyBlocks([{ type: 'bulletListItem', content: [] }])).toBe(false);
  });

  it('keeps an empty paragraph that has children, and a mention-only paragraph', () => {
    expect(isEmptyBlocks([{ type: 'paragraph', content: [], children: [{ type: 'paragraph' }] }])).toBe(false);
    expect(isEmptyBlocks([{ type: 'paragraph', content: [{ type: 'mention', props: { id: 'x' } }] }])).toBe(false);
  });

  it('keeps a document with one empty paragraph and one real one', () => {
    expect(isEmptyBlocks([{ type: 'paragraph' }, { type: 'paragraph', content: [{ type: 'text', text: 'x', styles: {} }] }])).toBe(false);
  });

  it('does not call a non-array value empty', () => {
    expect(isEmptyBlocks('text')).toBe(false);
    expect(isEmptyBlocks({})).toBe(false);
  });
});

describe('hidesWhenEmpty / isHidden — collection default (#783)', () => {
  const rel = (config: Record<string, unknown>, rel: Record<string, unknown>) =>
    ({ id: 'r', apiName: 'r', displayName: 'R', type: 'relation', config, relation: rel }) as never;
  const manyToMany = (config: Record<string, unknown> = {}) => rel(config, { cardinality: 'many_to_many', side: 'a' });
  const oneToManyB = (config: Record<string, unknown> = {}) => rel(config, { cardinality: 'one_to_many', side: 'b' });
  const oneToManyA = (config: Record<string, unknown> = {}) => rel(config, { cardinality: 'one_to_many', side: 'a' });
  const text = (config: Record<string, unknown> = {}) => ({ id: 't', apiName: 't', displayName: 'T', type: 'text', config }) as never;
  const record = (values: Record<string, unknown>) => ({ values }) as never;

  it('an empty collection that never made the choice is hidden', () => {
    expect(isHidden(manyToMany(), record({ r: [] }))).toBe(true);
    expect(isHidden(oneToManyB(), record({}))).toBe(true);
  });

  // What the default must KEEP: an explicit "Always show" beats it, and filled sections stay.
  it('an explicit false is "always show" and beats the default', () => {
    expect(isHidden(manyToMany({ hide_when_empty: false }), record({ r: [] }))).toBe(false);
  });
  it('a collection with linked records is never hidden by this rule', () => {
    expect(isHidden(manyToMany(), record({ r: [{ id: 'x', title: 'x' }] }))).toBe(false);
  });
  it('an explicit true still hides an empty one, and entity_hidden still hides a full one', () => {
    expect(isHidden(manyToMany({ hide_when_empty: true }), record({ r: [] }))).toBe(true);
    expect(isHidden(manyToMany({ entity_hidden: true }), record({ r: [{ id: 'x' }] }))).toBe(true);
  });

  it('is per KIND: single references and scalar fields keep showing when empty', () => {
    expect(isHidden(oneToManyA(), record({}))).toBe(false);
    expect(isHidden(text(), record({}))).toBe(false);
    expect(isHidden(text({ hide_when_empty: true }), record({}))).toBe(true);
  });

  it('the menu label follows the effective state', () => {
    expect(hidesWhenEmpty(manyToMany())).toBe(true);
    expect(hidesWhenEmpty(manyToMany({ hide_when_empty: false }))).toBe(false);
    expect(hidesWhenEmpty(text())).toBe(false);
  });
});
