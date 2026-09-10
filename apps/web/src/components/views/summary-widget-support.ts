/**
 * Which view types can show summary widgets — the single source of truth.
 *
 * Why this file exists: the rule lived as a four-way `||` chain inline in
 * `w/[ws]/d/[db]/page.tsx`, which was fine while exactly one place asked the
 * question. #698 moved the "add a summary widget" control into the view toolbar,
 * so a SECOND place now asks it, and two hand-written copies of a capability
 * gate is precisely how #267/#272/#303 happened: a type gets added, one copy
 * learns about it, the other does not, and the product offers an action whose
 * result never renders.
 *
 * If you add a surface that needs "can this view have summary widgets?", import
 * from here. Do not re-check `view.type` at the call site.
 */

/**
 * The record-grid views: "a view with rows a widget could summarise".
 *
 * Deliberately excluded, with reasons, so nobody re-litigates them one at a time:
 * - `calendar` / `timeline` — their own window/date framing means a stray count
 *   would misrepresent what the viewer is looking at.
 * - `feed` — same framing problem.
 * - `form` — has no rows to summarise.
 * - `dashboard` — already has this exact capability as its own tiles and widgets;
 *   a second, different widget system on the same surface would be the drift.
 */
const SUPPORTED = new Set(['table', 'board', 'gallery', 'list']);

export function viewSupportsSummaryWidgets(viewType: string | undefined): boolean {
  return viewType !== undefined && SUPPORTED.has(viewType);
}
