import { isIncompleteCondition } from '@storyos/schemas';
import { flattenFilterTree, filterConditions, isFilterGroup } from './filter-config';
import type { FilterCondition, FilterGroup, FilterNode } from './filter-config';

/**
 * #965 — what the Filter button says, as pure functions over the two filters (the view's own and the
 * viewer's personal one), so every rule below has a test.
 *
 * The rule (Ievgen, 10-20): the button is YELLOW whenever any condition is APPLIED, in the view's
 * filter or the personal one, pinned conditions included. "Applied" is what the query actually runs:
 * a disabled condition hides nothing, and an unfinished one (#345: no value yet) is never queried, so
 * neither counts.
 */

function leaves(group: FilterNode | undefined): FilterCondition[] {
  if (!group) return [];
  return flattenFilterTree(filterConditions(group as FilterGroup))
    .map((f) => f.node)
    .filter((n): n is FilterCondition => !isFilterGroup(n));
}

const isApplied = (c: FilterCondition) => !c.disabled && !isIncompleteCondition(c);

export interface FilterButtonState {
  /** Any applied condition, in either filter. */
  yellow: boolean;
  /** The personal filter has an applied condition: draw the person mark. */
  personalOn: boolean;
  /** Every applied condition, both filters. */
  applied: number;
  /** Every condition the user has built (enabled or not, finished or not), both filters. */
  configured: number;
  /**
   * The number on the button: applied conditions that are NOT already visible as a chip. A pinned
   * view condition is a chip, so it does not count here; a personal one never chips, so it does.
   */
  buttonCount: number;
}

export function filterButtonState(view: FilterNode | undefined, personal: FilterNode | undefined): FilterButtonState {
  const v = leaves(view);
  const p = leaves(personal);
  const appliedView = v.filter(isApplied);
  const appliedPersonal = p.filter(isApplied);
  const chipped = appliedView.filter((c) => Boolean(c.pinned)).length;
  const applied = appliedView.length + appliedPersonal.length;
  return {
    yellow: applied > 0,
    personalOn: appliedPersonal.length > 0,
    applied,
    configured: v.length + p.length,
    buttonCount: applied - chipped,
  };
}

/**
 * Why a view shows nothing, when it does. Three causes, each with its own wording and button, so an
 * empty view never reads as "your data is gone" when it is only filtered:
 *   - `filters`  : the view's own filter hides every record
 *   - `personal` : the viewer's personal filter hides them (the view's filter alone would show some)
 *   - `search`   : only the Find text hides them
 *   - `empty`    : the database genuinely has no records (the coached empty state applies instead)
 *   - null       : nothing is hidden
 *
 * Counts come from the server (`/aggregate`), never from loaded pages:
 *   total            every record
 *   afterView        records the view's own filter keeps
 *   afterViewPersonal  records the view's filter AND the personal filter keep
 *   shown            what the view actually shows (also applying Find)
 */
export function emptyViewCause(c: {
  total: number | undefined;
  shown: number | undefined;
  afterView: number | undefined;
  afterViewPersonal: number | undefined;
  hasViewFilter: boolean;
  hasPersonal: boolean;
  hasSearch: boolean;
}): 'filters' | 'personal' | 'search' | 'empty' | null {
  if (c.total === undefined || c.shown === undefined) return null; // still counting: say nothing
  if (c.shown > 0) return null;
  if (c.total === 0) return 'empty';
  if (c.hasViewFilter && c.afterView === 0) return 'filters';
  if (c.hasPersonal && c.afterViewPersonal === 0) return 'personal';
  if (c.hasSearch) return 'search';
  // Narrowed by something we cannot attribute (e.g. a count still loading): the safe, true reading.
  return c.hasViewFilter ? 'filters' : c.hasPersonal ? 'personal' : null;
}

/**
 * #992 — how many APPLIED conditions of the view's filter are on one field, for the column header's gold mark.
 * The header must follow the Filter button's rule (above): a disabled or unfinished condition hides nothing, so
 * a column whose only condition is "State is none of [ ]" (0 of 1 applied) carries no mark. Counts at any depth.
 */
export function appliedConditionsOnField(view: FilterNode | undefined, apiName: string): number {
  return leaves(view).filter((c) => c.field === apiName && isApplied(c)).length;
}
