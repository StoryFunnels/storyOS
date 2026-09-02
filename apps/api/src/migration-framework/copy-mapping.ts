import { matchExistingField, type MatchableField } from '@storyos/schemas';
import type { FieldDestination, SourceField } from './types';

/**
 * #432 — the rules between #431's adapter and #433's dialog, and where #430's
 * "refuse, don't drop" decision is enforced.
 *
 * THE THREE STATES, and there is deliberately no fourth:
 *
 *   mapped   — it has a destination.
 *   skipped  — the user said so, explicitly, in the dialog.
 *   blocking — it has a value, has no valid destination, and nobody has
 *              skipped it. This state REFUSES the copy.
 *
 * The fourth state — "dropped because nobody looked" — is the entire thing
 * being prevented. A copy that silently omits a field looks complete, which is
 * the worst possible presentation for data loss.
 */

export type MappingState = 'mapped' | 'skipped' | 'blocking';

export interface DestinationField extends MatchableField {
  /** For relation fields: which database this side points at. */
  targetDatabaseId?: string;
  options?: Array<{ id: string; label: string }>;
}

export interface FieldPlan {
  sourceKey: string;
  label: string;
  state: MappingState;
  to: FieldDestination;
  /** Why it blocks, phrased for a person — names the field and what is missing. */
  reason?: string;
  /** Several equally valid destinations; the dialog must ask rather than guess. */
  ambiguousWith?: string[];
}

/**
 * Types that can never receive a value.
 *
 * #477 — this comment used to claim this list was "imported rather than
 * restated" from column-match.ts's matcher. It was not; it is a second,
 * hand-maintained copy that had already drifted (missing `relation` and
 * `attachment`, the exact gap #477 found and fixed in column-match.ts).
 *
 * It genuinely CANNOT just import that set now that it's correct: `relation`
 * belongs in column-match.ts's set because a bare CSV string can never be a
 * relation value, but `writable` here (below) also gates the
 * `source.sourceType === 'relation'` branch, which deliberately WANTS
 * relation-typed destinations — a copied relation's value already IS a
 * resolved reference, not a raw string, so a relation destination is exactly
 * the valid target for a relation source. Importing column-match.ts's set
 * verbatim would silently break relation-to-relation copying.
 *
 * `attachment` has no such conflict and arguably belongs here too, but
 * whether `sourceType === 'attachment'` copying is even exercised anywhere,
 * and what shape its value takes, is not established — recording that as an
 * open question on #477 rather than guessing at a fix here.
 */
const UNWRITABLE = new Set(['lookup', 'rollup', 'formula', 'button']);

/**
 * Emptiness, tested EXPLICITLY.
 *
 * #345's lesson, and the reason it is worth a named function here: the obvious
 * falsiness check silently treats `Checkbox = false` and `Number = 0` as absent,
 * so a copy would drop them and look complete. An empty relation must also read
 * as empty, because an empty relation never blocks.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * Plan one source field against a destination database.
 *
 * `hasValue` is passed in rather than derived, because blocking depends on
 * whether THIS COPY carries a value — a relation field that is empty on the
 * record being copied has nothing to lose, and refusing there would be theatre.
 */
export function planField(
  source: SourceField,
  destinations: DestinationField[],
  opts: { hasValue: boolean; skipped?: boolean; sourceTargetDatabaseId?: string },
): FieldPlan {
  const base = { sourceKey: source.key, label: source.label };

  if (opts.skipped) {
    return { ...base, state: 'skipped', to: { kind: 'skip' } };
  }

  const writable = destinations.filter((d) => !UNWRITABLE.has(d.type));

  if (source.sourceType === 'relation') {
    /*
     * A relation carries record ids, which only mean anything to the database
     * they point at. So a destination relation is valid ONLY when it targets
     * the same database — a relation to a different one would import ids that
     * resolve to nothing, or worse, to the wrong rows.
     */
    const candidates = writable.filter(
      (d) => d.type === 'relation' && d.targetDatabaseId === opts.sourceTargetDatabaseId,
    );
    if (candidates.length === 1) {
      return { ...base, state: 'mapped', to: { kind: 'relation', field_id: candidates[0]!.id } };
    }
    if (candidates.length > 1) {
      /*
       * AMBIGUOUS, not blocking. Several relations to the same target is a
       * legitimate shape — "Blocked by" and "Duplicates" both point at Issues —
       * so the dialog offers the choice and defaults to none. Guessing one
       * would be a coin flip the user cannot see, which is the same reasoning
       * matchExistingField uses for ambiguous columns.
       */
      return {
        ...base,
        state: 'blocking',
        to: { kind: 'skip' },
        reason: `"${source.label}" could go to more than one relation — choose which, or skip it.`,
        ambiguousWith: candidates.map((c) => c.displayName),
      };
    }
    // No candidate. Only a problem if this copy actually carries a value.
    if (!opts.hasValue) {
      return { ...base, state: 'skipped', to: { kind: 'skip' } };
    }
    return {
      ...base,
      state: 'blocking',
      to: { kind: 'skip' },
      reason: `"${source.label}" links to records the destination has no relation for. Skip it explicitly to copy without it.`,
    };
  }

  const match = matchExistingField(source.label, writable) ?? matchExistingField(source.key, writable);
  if (match) {
    return { ...base, state: 'mapped', to: { kind: 'existing', field_id: match.id } };
  }

  /*
   * No destination and nothing to lose — not a block. Refusing a copy over an
   * empty field would make the feature unusable the first time two schemas do
   * not line up perfectly, which #430 explicitly did not want.
   */
  if (!opts.hasValue) {
    return { ...base, state: 'skipped', to: { kind: 'skip' } };
  }

  return {
    ...base,
    state: 'blocking',
    to: { kind: 'skip' },
    reason: `"${source.label}" has a value and no matching field in the destination. Map it, or skip it explicitly.`,
  };
}

/**
 * The copy is refused while ANY field blocks. Returned as a list rather than a
 * boolean so the dialog can name every one at once — telling someone about one
 * blocker at a time turns a single decision into five round trips.
 */
export function blockingFields(plans: FieldPlan[]): FieldPlan[] {
  return plans.filter((p) => p.state === 'blocking');
}
