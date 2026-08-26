import { z } from 'zod';

/**
 * The purpose line carried by a workspace, a space and a database (#400).
 *
 * One definition for all three levels, deliberately. The founder's decision was
 * "description should be a short line" at every level, and three copies of
 * `z.string().max(200)` is exactly the shape that drifts — one gains a trim, one
 * gains a longer cap, and the product ends up with three different ideas of what
 * a description is.
 *
 * **Plain text, not a document.** #310 is the cautionary tale: the RECORD
 * description is a versioned `documents` row with `expected_version` conflict
 * handling, and that ticket had to abandon its original plan because moving that
 * content would have replaced conflict detection with last-write-wins. A purpose
 * line needs none of that machinery — it is a column.
 *
 * The 200 is a readability bound, not a storage one. The value of this field is
 * that it can be read at a glance in a tooltip, a listing, or an agent's context
 * window; something that scrolls is a different feature and should be a document.
 *
 * **Whitespace collapsing is NOT done here.** Like `icon` (see the #283 comment on
 * `createSpaceSchema`), the invariant is enforced one layer down in the services,
 * because that is the only choke point every entry point goes through — the HTTP
 * DTOs, yes, but also templates, packs and integrations, which construct these
 * objects by calling the services directly and never see this schema.
 */
export const DESCRIPTION_MAX = 200;

/**
 * On CREATE: optional, and absent means absent.
 *
 * Note there is no `.default('')` — an empty description and no description must
 * stay the same thing. #305's rule (unconfigured is not invalid) applies: a
 * database nobody has described yet is normal, and the UI must render nothing at
 * all rather than an empty line that reads as a bug.
 */
export const descriptionSchema = z.string().max(DESCRIPTION_MAX).optional();

/**
 * On UPDATE: `null` clears it.
 *
 * Explicitly nullable, matching how `icon` and `color` already behave on these
 * same schemas — "remove the description" has to be expressible, and omitting the
 * key already means "leave it alone".
 */
export const descriptionPatchSchema = z.string().max(DESCRIPTION_MAX).nullable().optional();

/**
 * The service-layer normalizer — the choke point named above.
 *
 * Collapses all whitespace runs (including newlines) to single spaces and trims.
 * A pasted sentence with a trailing newline is not a mistake worth a 422; it is
 * the same sentence. But keeping the newline would let a field the product calls
 * "one line" render as three in a tooltip sized for one.
 *
 * Returns `undefined` for undefined (leave alone) and `null` for null (clear), so
 * a caller can pass a patch value straight through without unwrapping it. A
 * string that collapses to empty becomes `null` — someone clearing the box means
 * to remove the description, and storing `''` would make "empty" and "absent" two
 * different states that render identically. #305: unconfigured is not invalid,
 * but it should also not be two things.
 */
export function normalizeDescription(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed.slice(0, DESCRIPTION_MAX);
}
