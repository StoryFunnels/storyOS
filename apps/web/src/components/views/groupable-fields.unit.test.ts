import { describe, expect, it } from 'vitest';
import { canGroupBoardBy, canGroupListBy } from './groupable-fields';

const f = (type: string, over: Partial<Parameters<typeof canGroupBoardBy>[0]> = {}) => ({
  type,
  ...over,
});

describe('canGroupBoardBy — mirrors the API boardGroupError', () => {
  it('allows select', () => {
    expect(canGroupBoardBy(f('select'))).toBe(true);
  });

  // #172 / #267 / #272: the workflow (State) field is the one that keeps going missing.
  it('allows workflow — the regression this module exists to prevent', () => {
    expect(canGroupBoardBy(f('workflow'))).toBe(true);
  });

  it('allows a single-user field', () => {
    expect(canGroupBoardBy(f('user', { config: {} }))).toBe(true);
    expect(canGroupBoardBy(f('user', { config: { multi: false } }))).toBe(true);
  });

  it('rejects a multi-user field — a card would land in several columns', () => {
    expect(canGroupBoardBy(f('user', { config: { multi: true } }))).toBe(false);
  });

  it('allows the single side of a one-to-many relation', () => {
    expect(
      canGroupBoardBy(f('relation', { relation: { cardinality: 'one_to_many', side: 'a' } })),
    ).toBe(true);
  });

  it('rejects the many side of a one-to-many relation', () => {
    expect(
      canGroupBoardBy(f('relation', { relation: { cardinality: 'one_to_many', side: 'b' } })),
    ).toBe(false);
  });

  it('rejects a many-to-many relation', () => {
    expect(
      canGroupBoardBy(f('relation', { relation: { cardinality: 'many_to_many', side: 'a' } })),
    ).toBe(false);
  });

  it('rejects a relation with no live relation metadata', () => {
    expect(canGroupBoardBy(f('relation', { relation: null }))).toBe(false);
  });

  it.each(['text', 'number', 'date', 'checkbox', 'multi_select', 'rich_text', 'formula'])(
    'rejects %s',
    (type) => {
      expect(canGroupBoardBy(f(type))).toBe(false);
    },
  );
});

describe('canGroupListBy — narrower on purpose, matches what list-view renders', () => {
  it('allows select and workflow', () => {
    expect(canGroupListBy(f('select'))).toBe(true);
    expect(canGroupListBy(f('workflow'))).toBe(true);
  });

  // The bug: the List picker was `f.type === 'select'` inline, so State never appeared
  // even though list-view.tsx resolves workflow groups.
  it('offers workflow, which the inline copy in the New-view dialog did not (#272)', () => {
    expect(canGroupListBy(f('workflow'))).toBe(true);
  });

  it('rejects user and relation — list-view has no group key for them yet', () => {
    expect(canGroupListBy(f('user', { config: {} }))).toBe(false);
    expect(
      canGroupListBy(f('relation', { relation: { cardinality: 'one_to_many', side: 'a' } })),
    ).toBe(false);
  });
});
