/**
 * Where a person lands after installing a pack (#1167), kept out of the dialog so the rule is testable and so the dialog cannot
 * quietly re-decide it.
 *
 * A pack can say which of its views its database OPENS on (`views[].default`, #1146). Installing such a pack should put you on
 * that view (Team Board: its Board) rather than on a result list you have to click out of. A pack that declares none keeps the
 * result screen, and an install that did not happen navigates nowhere.
 *
 * Why this reads the MANIFEST and the install RESULT together rather than asking the API which view is the default: the install
 * result lists every view and database it touched, by the same names the manifest uses (`Database.View` labels), each with its id.
 * The manifest says which one is the default. Matching the two is exact (the server builds those labels from the manifest), where
 * guessing "the first view" or "the one called Board" would be brittle. The server only SETS the default for a view and database
 * this install created; a reused view is still the pack's default view to look at, so it is a landing target all the same.
 */

export interface LandingManifest {
  views?: Array<{ database: string; name: string; default?: boolean }>;
}

export interface LandingEntity {
  name: string;
  action: 'created' | 'reused' | 'updated' | 'skipped';
  id: string;
}

export interface LandingResult {
  databases: LandingEntity[];
  views: LandingEntity[];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The sidebar's per-space collapse is the person's own, kept in localStorage under this key (MN-088). Landing inside a space they
 * had collapsed would leave the thing they landed on hidden, so an install that navigates expands the space through the SAME
 * store the sidebar's own chevron writes, and tells the mounted sidebar with this event (it only reads storage on mount).
 */
export const EXPAND_SPACE_EVENT = 'storyos:expand-space';
export const spaceCollapseKey = (spaceId: string) => `storyos:space-collapsed:${spaceId}`;

export function expandSpaceInSidebar(spaceId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(spaceCollapseKey(spaceId), '0');
  } catch {
    /* storage can be blocked: the event below still expands it for this session */
  }
  window.dispatchEvent(new CustomEvent(EXPAND_SPACE_EVENT, { detail: { spaceId } }));
}

/** The view the manifest marks as the default. A database has exactly one, and the server lets the LAST marked one win. */
export function manifestDefaultView(manifest: LandingManifest | undefined): { database: string; name: string } | null {
  const marked = (manifest?.views ?? []).filter((v) => v.default === true);
  const last = marked[marked.length - 1];
  return last ? { database: last.database, name: last.name } : null;
}

/**
 * The route to open after an install, or null when there is nowhere better than what the dialog already does (no default view
 * declared, the install result is missing, or the default view / its database was skipped and so has no id to open).
 *
 * `result` is null for anything that is not a finished install (a refused one, a still-running one): null means "do not navigate".
 */
export function landingRoute(
  ws: string,
  manifest: LandingManifest | undefined,
  result: LandingResult | null | undefined,
): string | null {
  if (!result) return null;
  const wanted = manifestDefaultView(manifest);
  if (!wanted) return null;
  const view = result.views.find((v) => norm(v.name) === norm(`${wanted.database}.${wanted.name}`));
  const db = result.databases.find((d) => norm(d.name) === norm(wanted.database));
  if (!view || !db || view.action === 'skipped' || db.action === 'skipped' || !view.id || !db.id) return null;
  return `/w/${ws}/d/${db.id}?view=${view.id}`;
}
