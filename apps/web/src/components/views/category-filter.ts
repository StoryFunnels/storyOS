import { STATE_CATEGORIES } from '@storyos/schemas';
import type { StateCategory } from '@storyos/schemas';
import { STATE_CATEGORY_LABEL } from '@/lib/state-category-labels';

/**
 * #1159 — the web half of the API's `category_is` / `category_is_not` filter ops (ticket #1154: query-compiler.ts `compileCategory`).
 * They ask "is this record's option in a completed state", whatever the option is called, so a "done" state added later is counted
 * with no edit to the filter. The value is one state category or a list of them; the API refuses a name outside STATE_CATEGORIES.
 *
 * Pure on purpose (no JSX), the same shape as `relative-date.ts`: the builder row, the pinned chip, the view summary and My Work's
 * client-side evaluator all read a condition through here, so none of them can disagree about what it says or matches.
 *
 * The categories and their labels are NOT retyped: the list is the schemas package's STATE_CATEGORIES and the words are the option
 * editor's own STATE_CATEGORY_LABEL (lower-cased, because a category reads as a kind of state, not as the name of one: "State is
 * done or canceled" is every done-like state, where "State is Done" is the one option called Done).
 */

export const CATEGORY_OPS = ['category_is', 'category_is_not'] as const;
export type CategoryOp = (typeof CATEGORY_OPS)[number];

export function isCategoryOp(op: string): op is CategoryOp {
  return (CATEGORY_OPS as readonly string[]).includes(op);
}

export function isStateCategory(value: unknown): value is StateCategory {
  return typeof value === 'string' && (STATE_CATEGORIES as readonly string[]).includes(value);
}

/** The five categories as `{ id, label }`, in the option editor's order and words: the picker's choices (the shape `OptionChipSet` takes). */
export const CATEGORY_CHOICES: Array<{ id: StateCategory; label: string }> = STATE_CATEGORIES.map((id) => ({
  id,
  label: STATE_CATEGORY_LABEL[id],
}));

/** A category as it reads inside a sentence: "not started", "in progress", "done". */
export function categoryWord(category: StateCategory): string {
  return STATE_CATEGORY_LABEL[category].toLowerCase();
}

/**
 * What a stored value holds. A string is a single category (the API takes one); an array is a list. Anything else, and any name that
 * is not a category, is `unknown` and kept as written: the reader shows it raw rather than dropping it or throwing, because the
 * value may have been written by a newer API than this build.
 */
export function parseCategoryValue(value: unknown): { categories: StateCategory[]; unknown: string[] } {
  const raw = Array.isArray(value) ? value : typeof value === 'string' && value !== '' ? [value] : [];
  const categories: StateCategory[] = [];
  const unknown: string[] = [];
  for (const item of raw) {
    if (isStateCategory(item)) {
      if (!categories.includes(item)) categories.push(item);
    } else if (item !== null && item !== undefined && item !== '') {
      unknown.push(String(item));
    }
  }
  return { categories, unknown };
}

/** "done", "done or canceled", "backlog, not started or in progress" — in the canonical order, so one set reads one way. */
export function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * The words for a stored category condition, after the field name: "is done or canceled", "is not done". Null when `op` is not a
 * category op (the caller describes it the ordinary way). An unfinished condition (no value) reads as the bare operator, the way
 * every other unfinished condition does. An unknown category name stays in the sentence as written.
 */
export function describeCategoryCondition(op: string, value: unknown): string | null {
  if (!isCategoryOp(op)) return null;
  const { categories, unknown } = parseCategoryValue(value);
  const lead = op === 'category_is' ? 'is' : 'is not';
  const words = [...normalizeCategories(categories).map(categoryWord), ...unknown];
  if (words.length === 0) return op === 'category_is' ? 'is in category' : 'is not in category';
  return `${lead} ${joinWords(words)}`;
}

/** What the picker writes: the chosen categories in the canonical order, whatever order they were clicked in. A name that is not a category is not a chip, so the first edit drops it (it was shown raw until then). */
export function normalizeCategories(ids: readonly string[]): StateCategory[] {
  return STATE_CATEGORIES.filter((c) => ids.includes(c));
}

/**
 * My Work's client-side verdict for one record, mirroring `compileCategory`: the record's option id is in the category when that
 * option's category is one of the wanted ones. `category_is_not` is the exact complement, so a record with no value, or an option
 * with no category, is NOT in the category and so passes it. An unknown category name matches nothing (the server refuses it, so
 * the condition never ran there either).
 */
export function matchesCategory(
  op: CategoryOp,
  optionId: unknown,
  wanted: unknown,
  categoryByOptionId: Record<string, StateCategory | null | undefined>,
): boolean {
  const { categories } = parseCategoryValue(wanted);
  const id = Array.isArray(optionId) ? optionId[0] : optionId;
  const own = typeof id === 'string' ? categoryByOptionId[id] : undefined;
  const inside = own != null && categories.includes(own);
  return op === 'category_is' ? inside : !inside;
}
