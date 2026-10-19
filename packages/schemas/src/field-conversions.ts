import type { CreatableFieldType } from './fields';

/**
 * #957 — the ONE conversion matrix. `Change type` was allowed by two hand-kept copies (the API's
 * `CONVERTIBLE` in fields.service.ts and the web dialog's in field-dialog-shared.tsx) that had to be edited
 * together and nothing tied them: a picker offering less than the server allows is the bug the field-surface
 * rules name. The API enforces this list and the dialog renders it; neither keeps its own.
 *
 * `text` → a choice type is the conversion people need most after an import or a CSV: every distinct non-empty
 * trimmed value becomes one option (see `TEXT_TO_CHOICE_MAX_OPTIONS`).
 */
export const CONVERTIBLE: Record<string, readonly CreatableFieldType[]> = {
  text: ['number', 'date', 'rich_text', 'select', 'multi_select', 'workflow'],
  rich_text: ['text'],
  number: ['text'],
  checkbox: ['text'],
  date: ['text'],
  // #172: workflow is single-select-shaped, so it round-trips with select/multi_select
  // (option ids are preserved on select↔workflow) and degrades to text.
  select: ['text', 'multi_select', 'workflow'],
  multi_select: ['text', 'select', 'workflow'],
  workflow: ['text', 'select', 'multi_select'],
  url: ['text', 'email'],
  email: ['text', 'url'],
  user: [],
  // #391 — no conversion in or out. A filename is not a file, so "text → attachment" would produce a column
  // of names pointing at nothing, and "attachment → text" would silently strip the files off the record.
  attachment: [],
};

/** The choice types a text field can become, one option per distinct value. */
export const CHOICE_FIELD_TYPES = ['select', 'multi_select', 'workflow'] as const;

/**
 * More distinct values than this is not a list of choices, it is free text (or an ID column); refusing says
 * so instead of minting a thousand options nobody asked for.
 */
export const TEXT_TO_CHOICE_MAX_OPTIONS = 200;

export function isTextToChoice(from: string, to: string): boolean {
  return from === 'text' && (CHOICE_FIELD_TYPES as readonly string[]).includes(to);
}
