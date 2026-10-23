import { STATE_CATEGORIES } from '@storyos/schemas';
import type { StateCategory } from '@storyos/schemas';

/**
 * #1017 — the words for a workflow option's state category (ticket #1014), in a person's terms. The five are Linear's state
 * types; "finished" is the last two (Done, Canceled), which is what My Work, the "Assigned to me" view and overdue read.
 */
export const STATE_CATEGORY_LABEL: Record<StateCategory, string> = {
  backlog: 'Backlog',
  unstarted: 'Not started',
  started: 'In progress',
  completed: 'Done',
  canceled: 'Canceled',
};

export const STATE_CATEGORY_OPTIONS: Array<{ value: StateCategory; label: string }> = STATE_CATEGORIES.map((value) => ({
  value,
  label: STATE_CATEGORY_LABEL[value],
}));

/** What a field's options can have: a workflow always has a category; a select may have one or none; anything else has none. */
export function categoryEditable(fieldType: string): 'required' | 'optional' | null {
  return fieldType === 'workflow' ? 'required' : fieldType === 'select' ? 'optional' : null;
}
