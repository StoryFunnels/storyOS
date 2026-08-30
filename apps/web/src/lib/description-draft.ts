import { DESCRIPTION_MAX } from '@storyos/schemas';

/**
 * THE web-side rules for a half-typed description (#457).
 *
 * One definition of what the box in front of you means, for every surface that
 * offers one. This exists because the first cut of #457 did not have it: the
 * dialog and the workspace settings page each re-derived the same trim, the same
 * over-limit test, the same clear-to-null rule and the same counter wording, and
 * Vera failed the ticket's criterion 6 on exactly that. She was right. The cap was
 * genuinely shared — both imported `DESCRIPTION_MAX` and neither typed a literal
 * 200 — but "share the cap" is not what the criterion asked for, and a reviewer
 * looking at one file could not see that the other re-implemented the rest.
 *
 * That is the shape `docs/architecture/field-surfaces.md` exists to stop, and the
 * history it cites (#267, #272 twice, #303) is four shipments of precisely this:
 * copies that were identical right up until one of them changed.
 *
 * The division of labour, unchanged:
 *
 *   - The **cap** is the schema's (`DESCRIPTION_MAX`), imported here and nowhere
 *     re-typed.
 *   - **Storage normalisation** is the SERVER's (`normalizeDescription`, same
 *     schema file). What this module computes is a preview of that so the counter
 *     does not tell someone they are over the limit because of a trailing newline
 *     the server is about to collapse away — it is not a second authority on what
 *     gets stored.
 *   - **How a surface looks** is still the surface's own business. The dialog is a
 *     modal with Cancel/Save; the settings page is an inline field with its own
 *     Save. That difference is legitimate and this module does not touch it — it
 *     is the RULES that must not fork, not the chrome.
 */
export interface DescriptionDraft {
  /**
   * What to send to the API. `null` when the box is effectively empty, so a
   * cleared description is REMOVED rather than stored as `''` — #305's rule that
   * unconfigured is not invalid, and that it should also not be two states which
   * render identically.
   */
  value: string | null;
  /** Length the server will actually store, i.e. after whitespace collapsing. */
  length: number;
  /** Over the cap, and therefore not submittable. */
  over: boolean;
  /**
   * The counter label. Here rather than in each surface so the two cannot word the
   * same fact differently — the drift this module exists to prevent is not only
   * behavioural.
   */
  hint: string;
}

/**
 * Read a raw textarea value as the description it would become.
 *
 * The collapse mirrors `normalizeDescription`'s (all whitespace runs, including
 * newlines, to single spaces, then trim). It is deliberately a PREVIEW: the server
 * still normalises on write, and this never becomes the thing that decides what is
 * stored.
 */
export function describeDraft(raw: string): DescriptionDraft {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const over = collapsed.length > DESCRIPTION_MAX;
  return {
    // Send the raw string when there is something to send — the server owns the
    // final normalisation, and sending `collapsed` would quietly make this module
    // the authority instead.
    value: collapsed === '' ? null : raw,
    length: collapsed.length,
    over,
    hint: over
      ? `${collapsed.length - DESCRIPTION_MAX} over the ${DESCRIPTION_MAX}-character limit`
      : `${DESCRIPTION_MAX - collapsed.length} left`,
  };
}
