import { describe, expect, it } from 'vitest';
import {
  boardGroupDisabledReason,
  canGroupBoardBy,
  canGroupListBy,
  listGroupDisabledReason,
} from './groupable-fields';

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

  // #307 shipped date grouping, so `date` moved OUT of this list — the assertion
  // that used to pin it here is the one that caught the change.
  it('allows a date field, which groups into periods (#307)', () => {
    expect(canGroupBoardBy(f('date'))).toBe(true);
  });

  it.each(['text', 'number', 'checkbox', 'multi_select', 'rich_text', 'formula'])(
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

describe('boardGroupDisabledReason — #225: say WHY, never silently omit', () => {
  it('returns null for fields that CAN group (they are not disabled)', () => {
    expect(boardGroupDisabledReason(f('select'))).toBeNull();
    expect(boardGroupDisabledReason(f('workflow'))).toBeNull();
    expect(boardGroupDisabledReason(f('user', { config: {} }))).toBeNull();
  });

  it('explains the multi-value rejections in the user\'s terms', () => {
    expect(boardGroupDisabledReason(f('user', { config: { multi: true } }))).toContain(
      'several columns',
    );
    expect(boardGroupDisabledReason(f('multi_select'))).toContain('several columns');
    expect(
      boardGroupDisabledReason(f('relation', { relation: { cardinality: 'many_to_many', side: 'a' } })),
    ).toContain('several columns');
  });

  it('distinguishes not-built-yet from cannot-work, so the roadmap is legible', () => {
    // date is groupable as of #307 — no reason, because it isn't disabled.
    expect(boardGroupDisabledReason(f('date'))).toBeNull();
    expect(boardGroupDisabledReason(f('number'))).toContain('not built yet');
    expect(boardGroupDisabledReason(f('formula'))).toContain('computed');
  });

  it('always returns SOME reason for an ungroupable field — never an empty label', () => {
    for (const type of ['text', 'rich_text', 'checkbox', 'email', 'url', 'attachment']) {
      const reason = boardGroupDisabledReason(f(type));
      expect(reason, `${type} must explain itself`).toBeTruthy();
    }
  });
});

describe('listGroupDisabledReason — points at the board when that is the answer', () => {
  it('tells you to use a board for a field a board could group', () => {
    expect(listGroupDisabledReason(f('user', { config: {} }))).toContain('try a board');
    expect(
      listGroupDisabledReason(f('relation', { relation: { cardinality: 'one_to_many', side: 'a' } })),
    ).toContain('try a board');
  });

  it('returns null for select/workflow', () => {
    expect(listGroupDisabledReason(f('select'))).toBeNull();
    expect(listGroupDisabledReason(f('workflow'))).toBeNull();
  });
});
