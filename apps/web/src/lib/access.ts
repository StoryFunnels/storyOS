/** ADR-0007 client helpers. */
export type EffectiveRole = 'viewer' | 'commenter' | 'editor' | 'creator' | 'admin';

const RANK: Record<EffectiveRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  creator: 3,
  admin: 4,
};

export function atLeast(access: EffectiveRole | undefined, min: EffectiveRole): boolean {
  if (!access) return false;
  return RANK[access] >= RANK[min];
}

export const GRANT_ROLES = [
  { value: 'viewer', label: 'Viewer — read only' },
  { value: 'commenter', label: 'Commenter — read + comment' },
  { value: 'editor', label: 'Editor — work with records & views' },
  { value: 'creator', label: 'Creator — also edit fields' },
] as const;
