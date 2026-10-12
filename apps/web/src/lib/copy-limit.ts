/**
 * #823 — the Copy-to dialog states its record limit BEFORE a destination is
 * chosen, rather than the server's 422 surfacing after the mapping effort.
 *
 * The bound lives in ONE place on the server (`copy-record.controller.ts`'s
 * `record_ids: z.array(...).max(N)`), and the web cannot import it, so this
 * constant MIRRORS it and `copy-limit.unit.test.ts` reads the controller's own
 * source and fails if the two ever differ. A hand-copied `200` with nothing
 * checking it is how the UI starts lying in the other direction the day the
 * server bound moves.
 *
 * The server's 422 stays as the backstop for API callers; this is UI only.
 */
export const COPY_RECORDS_MAX = 200;

/**
 * Why a selection of `count` records cannot be copied, or null when it can.
 * INCLUSIVE: exactly COPY_RECORDS_MAX is fine (the boundary is where a fix like
 * this turns into a regression, so it is an explicit comparison with a test).
 *
 * There is deliberately no "copy the first 200" path offered from here: a
 * selection that silently gets handled only in part is the dangerous outcome,
 * and the API rejects rather than truncates for the same reason.
 */
export function copySelectionProblem(count: number): { selected: number; limit: number; message: string } | null {
  if (count <= COPY_RECORDS_MAX) return null;
  return {
    selected: count,
    limit: COPY_RECORDS_MAX,
    message: `${count.toLocaleString()} records are selected, and a copy takes at most ${COPY_RECORDS_MAX}. Narrow the selection to ${COPY_RECORDS_MAX} or fewer and try again — nothing has been copied.`,
  };
}
