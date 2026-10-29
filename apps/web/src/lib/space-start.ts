/**
 * The space page's "start here" logic (#1094), kept out of the components so the rules are testable and so the page cannot
 * quietly re-decide them.
 *
 * Three rules live here, each of which is a way the page used to be (or could again become) a dead end:
 *
 *  - WHEN is a space empty. A space is empty only when it has no database, no document and no view the viewer can see. A space
 *    holding one document is not empty: offering "pick a ready-made setup" over somebody's writing is wrong, and was the
 *    easy mistake in a version that counted databases alone.
 *  - WHO is offered the creators. Anyone who is not a guest, the same gate the sidebar's "+" menu uses (`canEdit` there), so
 *    this page never offers what the sidebar withholds. A guest keeps the plain "nothing here you can access" line.
 *  - WHICH packs lead, and which filter chips exist (only a kind of work that has at least one pack).
 */

export interface SpacePackLike {
  slug: string;
  name: string;
}

export interface PackFilterOption {
  value: string;
  label: string;
}

/**
 * The packs designed to be the first thing a new space offers ("Start ready to work", #1022). They lead the grid and the
 * "Any team" chip shows exactly them. Matched by slug, and a slug the registry does not have is skipped rather than invented,
 * so this list can name packs before they ship without the page drawing a card for something that does not exist.
 */
export const FEATURED_SPACE_PACKS: readonly string[] = ['team-board', 'dev-tracker', 'team-wiki'];

export const ANY_TEAM = 'team';
export const ALL_PACKS = 'all';

/** Empty means nothing at all that the viewer can see in it: databases, documents, views. */
export function isSpaceEmpty(counts: { databases: number; documents: number; views: number }): boolean {
  return counts.databases === 0 && counts.documents === 0 && counts.views === 0;
}

/** Everyone but a guest may add to a space (mirrors the sidebar's `canEdit`); a guest sees the page read-only. */
export function canAddToSpace(workspaceRole: string | undefined): boolean {
  return workspaceRole !== undefined && workspaceRole !== 'guest';
}

/**
 * Installing a pack is admin-only on the API (`@MinRole('admin')` on the packs controller: preview and install both answer
 * "Requires admin role" to a member), and the Packs page gates its Install button the same way. A member offered the cards would
 * get a dialog that opens on an error, so they are not offered them.
 */
export function canInstallPacks(workspaceRole: string | undefined): boolean {
  return workspaceRole === 'admin';
}

/**
 * What a member who cannot install a pack is told instead: who CAN. Names come from the members list the page already has
 * (never invented): one name, "A or B", "A, B or C", and past three "A, B, C and N more". With no admin names to give (the list
 * has not loaded, or came back with no admin) it says "a workspace admin" rather than guessing.
 */
export function adminAskLine(members: ReadonlyArray<{ role: string; user: { name: string } }> | undefined): string {
  const names = [...new Set((members ?? []).filter((m) => m.role === 'admin').map((m) => m.user.name.trim()).filter(Boolean))];
  const who =
    names.length === 0
      ? 'a workspace admin'
      : names.length === 1
        ? names[0]!
        : names.length <= 3
          ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`
          : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return `Only admins can add packs. Ask ${who} to add one.`;
}

const isFeatured =(slug: string) => FEATURED_SPACE_PACKS.includes(slug);

/**
 * "All", "Any team" (only when a featured pack exists) and then one chip per kind of work that actually has a pack, in the
 * order the Packs page already uses. A chip that would show nothing is not drawn.
 */
export function spacePackFilters<P extends SpacePackLike>(
  packs: readonly P[],
  verticalOf: (slug: string) => string,
  kinds: readonly PackFilterOption[],
): PackFilterOption[] {
  const present = new Set(packs.map((p) => verticalOf(p.slug)));
  return [
    { value: ALL_PACKS, label: 'All' },
    ...(packs.some((p) => isFeatured(p.slug)) ? [{ value: ANY_TEAM, label: 'Any team' }] : []),
    ...kinds.filter((k) => k.value !== ALL_PACKS && present.has(k.value)),
  ];
}

/** The cards to draw for a filter, featured packs first (in the featured order), the rest in the registry's own order. */
export function visibleSpacePacks<P extends SpacePackLike>(
  packs: readonly P[],
  filter: string,
  verticalOf: (slug: string) => string,
): P[] {
  const shown = packs.filter((p) =>
    filter === ALL_PACKS ? true : filter === ANY_TEAM ? isFeatured(p.slug) : verticalOf(p.slug) === filter,
  );
  const featured = FEATURED_SPACE_PACKS.flatMap((slug) => shown.filter((p) => p.slug === slug));
  return [...featured, ...shown.filter((p) => !isFeatured(p.slug))];
}
