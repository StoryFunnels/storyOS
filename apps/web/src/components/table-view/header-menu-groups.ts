/**
 * #1281 item 2 — the column header menu is grouped the way the prototype's is: edit / filter-sort / visibility (then the
 * destructive Delete on its own). A separator sits between two groups only when BOTH have an item, so a read-only viewer's
 * one-group menu has no stray rule and a menu never opens or ends on one.
 */
export type HeaderMenuGroups = { edit: boolean; filterSort: boolean; visibility: boolean; destructive: boolean };

export function headerMenuSeparators(g: HeaderMenuGroups): { afterEdit: boolean; afterFilterSort: boolean; afterVisibility: boolean } {
  return {
    afterEdit: g.edit && (g.filterSort || g.visibility || g.destructive),
    afterFilterSort: g.filterSort && (g.visibility || g.destructive),
    afterVisibility: g.visibility && g.destructive,
  };
}
