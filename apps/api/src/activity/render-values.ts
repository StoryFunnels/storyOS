import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { fields, selectOptions } from '../db/schema';

/**
 * How a stored value is RENDERED for a human (#335).
 *
 * Capture is faithful by design: `record_field_changes` and
 * `activity_events.payload.diff` both hold exactly what the write stored — a
 * select's option uuid, not its label. That property is the one thing a change
 * log cannot give up, so the reconciliation belongs on the read side, and #335
 * says so explicitly.
 *
 * `ActivityService` already did this correctly, resolving field ids to display
 * names and option ids to labels into a `changes[]` array while leaving the raw
 * `payload` untouched. `listFieldChanges` — its sibling, reading a diff written
 * by the same `update()` — did not, so the same change rendered two ways
 * depending on which endpoint you asked. This module is that resolution, in one
 * place, so the two cannot drift again. That drift is the defect #380 and #383
 * both document, and it is why this is a shared helper rather than a copy.
 *
 * Deleted fields and deleted options are deliberately included. The history of a
 * field outliving the field is the entire point of a change log, and a row that
 * renders as a bare uuid because its field was removed is exactly the "I doubt
 * the history is showing me the real thing" the ticket's user story describes.
 */
export interface RenderContext {
  /** Field id → display name, with removed fields marked rather than hidden. */
  fieldName: Map<string, string>;
  /** Field id → type, so a caller can render per type without a second lookup. */
  fieldType: Map<string, string>;
  /** Option id → label, across every select-like field in the database. */
  optionLabel: Map<string, string>;
}

export async function buildRenderContext(db: Db, databaseId: string): Promise<RenderContext> {
  // No `deletedAt` filter, on purpose — see the note above.
  const fieldRows = await db.query.fields.findMany({ where: eq(fields.databaseId, databaseId) });
  const selectFieldIds = fieldRows
    .filter((f) => f.type === 'select' || f.type === 'multi_select' || f.type === 'workflow')
    .map((f) => f.id);
  const options = selectFieldIds.length
    ? await db.query.selectOptions.findMany({ where: inArray(selectOptions.fieldId, selectFieldIds) })
    : [];
  return {
    fieldName: new Map(
      fieldRows.map((f) => [f.id, f.deletedAt ? `${f.displayName} (deleted field)` : f.displayName]),
    ),
    fieldType: new Map(fieldRows.map((f) => [f.id, f.type])),
    optionLabel: new Map(options.map((o) => [o.id, o.label])),
  };
}

/**
 * The stored value as a person should see it.
 *
 * Only select-like ids are translated. Everything else is returned unchanged —
 * a date stays its ISO string and a number stays a number, because the API
 * returns those verbatim on the record too and "renders identically to the
 * record" is the acceptance criterion, not "is prettier than the record".
 * Formatting a date here would make history the ONLY surface that formats, which
 * is a new disagreement rather than a fix for the old one.
 *
 * An id with no surviving option falls through to itself rather than becoming
 * "(unknown)": the raw value is at least true, and the caller still has the raw
 * pair alongside.
 */
export function renderValue(value: unknown, ctx: Pick<RenderContext, 'optionLabel'>): unknown {
  if (typeof value === 'string') return ctx.optionLabel.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => renderValue(v, ctx));
  return value;
}

/**
 * The same, but only where an option id can legitimately appear.
 *
 * `renderValue` maps ANY string that happens to match an option id, which is how
 * the activity feed has always behaved. In practice option ids are uuids so a
 * collision with a text value is vanishingly unlikely — but "vanishingly
 * unlikely" is not the same as "cannot", and a text field that stored a uuid
 * would silently render as some unrelated field's label.
 *
 * Where the caller knows the field's type — `listFieldChanges` does — prefer
 * this. It makes the guarantee structural instead of probabilistic, and it makes
 * the sentence at the top of `renderValue` literally true.
 */
const OPTION_TYPES = new Set(['select', 'multi_select', 'workflow']);

export function renderTypedValue(
  value: unknown,
  fieldType: string | null | undefined,
  ctx: Pick<RenderContext, 'optionLabel'>,
): unknown {
  return fieldType && OPTION_TYPES.has(fieldType) ? renderValue(value, ctx) : value;
}
