/**
 * Field-type families, in one place (#172 / #267 / #272 / #311).
 *
 * `workflow` (the State/Status field) is **select-shaped**: single-valued, backed by
 * coloured options, rendered by the same controls. Every surface that special-cases
 * `select` almost always means "an option field" and must include `workflow` too.
 *
 * It did not, in at least five places, because `workflow` was introduced (#172) long
 * after those allowlists were written and nobody could see them all at once. The
 * user-visible result was the same bug reported over and over: "State is missing
 * from <some picker>" (#267, #272, and the collection-section columns).
 *
 * Import from here instead of writing `f.type === 'select'`. See
 * docs/architecture/field-surfaces.md.
 */

/** Single-valued option fields: exactly one coloured option per record. */
export const SINGLE_OPTION_TYPES: ReadonlySet<string> = new Set(['select', 'workflow']);

/** Every option-backed field, including the multi-valued one. */
export const OPTIONED_TYPES: ReadonlySet<string> = new Set(['select', 'multi_select', 'workflow']);

/** True for a field whose value is one coloured option (select or State/workflow). */
export function isSingleOption(field: { type: string }): boolean {
  return SINGLE_OPTION_TYPES.has(field.type);
}

/** True for any option-backed field — the set that can colour, group or chip. */
export function isOptioned(field: { type: string }): boolean {
  return OPTIONED_TYPES.has(field.type);
}
