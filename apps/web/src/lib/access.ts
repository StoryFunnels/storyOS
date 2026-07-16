/**
 * ADR-0007 client helpers. Mirrors ACCESS_RANK in the API's access.service —
 * they must stay in lockstep or the UI enables a control the API then refuses.
 * `contributor` (MN-121): read + create + update records, no delete.
 */
export type EffectiveRole =
  | 'viewer'
  | 'commenter'
  | 'contributor'
  | 'editor'
  | 'creator'
  | 'admin';

const RANK: Record<EffectiveRole, number> = {
  viewer: 0,
  commenter: 1,
  contributor: 2,
  editor: 3,
  creator: 4,
  admin: 5,
};

export function atLeast(access: EffectiveRole | undefined, min: EffectiveRole): boolean {
  if (!access) return false;
  return RANK[access] >= RANK[min];
}

export const GRANT_ROLES = [
  { value: 'viewer', label: 'Viewer — read only' },
  { value: 'commenter', label: 'Commenter — read + comment' },
  { value: 'contributor', label: 'Contributor — add & edit records, but not delete' },
  { value: 'editor', label: 'Editor — work with records & views' },
  { value: 'creator', label: 'Creator — also edit fields' },
] as const;
