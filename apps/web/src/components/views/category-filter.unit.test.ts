import { describe, expect, it } from 'vitest';
import { STATE_CATEGORIES } from '@storyos/schemas';
import {
  CATEGORY_CHOICES,
  categoryWord,
  describeCategoryCondition,
  isCategoryOp,
  joinWords,
  matchesCategory,
  normalizeCategories,
  parseCategoryValue,
} from './category-filter';

/** #1159 — the words and the verdict for the API's `category_is` / `category_is_not` (ticket #1154). */
describe('describeCategoryCondition', () => {
  it('reads a done-like set as words, not as option labels', () => {
    expect(describeCategoryCondition('category_is', ['completed', 'canceled'])).toBe('is done or canceled');
    expect(describeCategoryCondition('category_is_not', ['completed'])).toBe('is not done');
    expect(describeCategoryCondition('category_is_not', ['completed', 'canceled'])).toBe('is not done or canceled');
  });

  it("uses the option editor's words for all five, in a sentence", () => {
    expect(STATE_CATEGORIES.map(categoryWord)).toEqual(['backlog', 'not started', 'in progress', 'done', 'canceled']);
    expect(describeCategoryCondition('category_is', [...STATE_CATEGORIES])).toBe(
      'is backlog, not started, in progress, done or canceled',
    );
  });

  it('reads one stored string the way the API reads it: a single category', () => {
    expect(describeCategoryCondition('category_is', 'started')).toBe('is in progress');
  });

  it('prints an unfinished condition as the bare operator, like every other unfinished condition', () => {
    expect(describeCategoryCondition('category_is', [])).toBe('is in category');
    expect(describeCategoryCondition('category_is_not', undefined)).toBe('is not in category');
    expect(describeCategoryCondition('category_is', '')).toBe('is in category');
  });

  it('keeps a name that is not a category as written instead of dropping or throwing', () => {
    expect(describeCategoryCondition('category_is', ['completed', 'archived'])).toBe('is done or archived');
    expect(describeCategoryCondition('category_is', 'archived')).toBe('is archived');
    expect(() => describeCategoryCondition('category_is', { weird: true })).not.toThrow();
    expect(() => describeCategoryCondition('category_is', [null, 7, ['x']])).not.toThrow();
  });

  it('says nothing about any other operator, so the caller describes it the ordinary way', () => {
    for (const op of ['eq', 'neq', 'has', 'has_none', 'is_empty', 'category_in', '']) {
      expect(describeCategoryCondition(op, ['completed'])).toBeNull();
    }
  });

  it('is stable: the same set reads the same whatever order it was stored in', () => {
    expect(describeCategoryCondition('category_is', ['canceled', 'completed'])).toBe(
      describeCategoryCondition('category_is', ['completed', 'canceled']),
    );
  });
});

describe('parseCategoryValue / normalizeCategories', () => {
  it('separates real categories from anything else, de-duplicating', () => {
    expect(parseCategoryValue(['completed', 'completed', 'nope', null, ''])).toEqual({
      categories: ['completed'],
      unknown: ['nope'],
    });
    expect(parseCategoryValue(undefined)).toEqual({ categories: [], unknown: [] });
    expect(parseCategoryValue(5)).toEqual({ categories: [], unknown: [] });
  });

  it('writes the picked categories in the canonical order whatever the click order', () => {
    expect(normalizeCategories(['canceled', 'backlog', 'completed'])).toEqual(['backlog', 'completed', 'canceled']);
    expect(normalizeCategories(['completed', 'bogus'])).toEqual(['completed']);
  });

  it("offers exactly the schemas package's five, never a retyped list", () => {
    expect(CATEGORY_CHOICES.map((c) => c.id)).toEqual([...STATE_CATEGORIES]);
    expect(CATEGORY_CHOICES.map((c) => c.label)).toEqual(['Backlog', 'Not started', 'In progress', 'Done', 'Canceled']);
  });
});

describe('isCategoryOp / joinWords', () => {
  it('recognises exactly the two ops', () => {
    expect(isCategoryOp('category_is')).toBe(true);
    expect(isCategoryOp('category_is_not')).toBe(true);
    expect(isCategoryOp('has')).toBe(false);
  });
  it('joins with commas and a final "or"', () => {
    expect(joinWords([])).toBe('');
    expect(joinWords(['a'])).toBe('a');
    expect(joinWords(['a', 'b'])).toBe('a or b');
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b or c');
  });
});

describe('matchesCategory (My Work, mirrors the API compileCategory)', () => {
  const byOption = { todo: 'unstarted', doing: 'started', done: 'completed', wontdo: 'canceled', plain: null } as const;
  const isDoneish = (id: unknown) => matchesCategory('category_is', id, ['completed', 'canceled'], byOption);
  const isOpen = (id: unknown) => matchesCategory('category_is_not', id, ['completed', 'canceled'], byOption);

  it("category_is: the option's category is one of the wanted", () => {
    expect(isDoneish('done')).toBe(true);
    expect(isDoneish('wontdo')).toBe(true);
    expect(isDoneish('doing')).toBe(false);
  });

  it('category_is_not is the exact complement, so what has NO category or NO value passes it', () => {
    expect(isOpen('doing')).toBe(true);
    expect(isOpen('done')).toBe(false);
    expect(isOpen('plain')).toBe(true); // an option with no category is not in any category
    expect(isOpen(null)).toBe(true); // no value
    expect(isOpen(undefined)).toBe(true);
    expect(isOpen('ghost')).toBe(true); // an option id the field no longer has
    expect(isDoneish('plain')).toBe(false);
    expect(isDoneish(null)).toBe(false);
  });

  it('an unknown category name matches nothing, and its complement everything', () => {
    expect(matchesCategory('category_is', 'done', ['archived'], byOption)).toBe(false);
    expect(matchesCategory('category_is_not', 'done', ['archived'], byOption)).toBe(true);
  });
});
