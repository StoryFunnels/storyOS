import { identifierPrefixSchema } from '@storyos/schemas';

/**
 * Ticket #1381 — what the box in front of an admin means when they are setting a database's identifier prefix.
 *
 * The SHAPE is the schema's (`identifierPrefixSchema`, the one the API validates with, message included) and is imported, not re-typed.
 * Uniqueness and "is this an admin" are the server's: the dialog shows the API's own refusal inline rather than guessing at either.
 * What lives here is only the preview of the server's rule, so a typo is caught before the round trip.
 */
export interface IdentifierPrefixDraft {
  /** What to send: `null` when the box is empty (clearing returns the database to plain `#123` numbers), else the upper-cased text. */
  value: string | null;
  /** The schema's own wording when the text is not a valid prefix; null when it is valid or empty (empty is a legitimate "remove it"). */
  error: string | null;
  /** True when saving would send what the database already has, so Save stays off instead of firing a no-op PATCH. */
  unchanged: boolean;
}

export function identifierPrefixDraft(raw: string, current: string | null | undefined): IdentifierPrefixDraft {
  // Upper-cased here as well as in the input: storage is case-sensitive (the CHECK constraint wants capitals), lookup is not, so typing
  // `issue` should mean ISSUE rather than a refusal about a letter the person cannot see is wrong.
  const text = raw.trim().toUpperCase();
  if (text === '') return { value: null, error: null, unchanged: (current ?? null) === null };
  const parsed = identifierPrefixSchema.safeParse(text);
  return {
    value: text,
    error: parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Not a valid identifier prefix'),
    unchanged: text === current,
  };
}

/** The helper line under the box. Uses what is typed once it is valid, so the example is the person's own prefix. */
export function identifierPrefixHelper(draft: IdentifierPrefixDraft): string {
  const shown = draft.value && !draft.error ? draft.value : 'ISSUE';
  return `Records show as ${shown}-123. Leave empty to show #123.`;
}
