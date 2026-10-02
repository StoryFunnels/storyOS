/**
 * #821 — a token list is a PERSONAL resource (GET /me/tokens returns every token
 * the signed-in user owns, across all workspaces), but this page lives inside one
 * workspace's settings and says "this workspace". The presentation, not the API,
 * is what has to reconcile the two: show the current workspace's tokens by
 * default, keep the rest reachable behind an explicit control, and name the
 * owning workspace wherever a token from another one is visible.
 */
export interface ScopedToken {
  id: string;
  workspace_id: string | null;
}

export interface WorkspaceRef {
  id: string;
  name: string;
  slug?: string;
}

/** The route param is an id today but a slug elsewhere in the app — accept either. */
export function currentWorkspaceId(ws: string, workspaces: WorkspaceRef[] | undefined): string | null {
  return workspaces?.find((w) => w.id === ws || w.slug === ws)?.id ?? null;
}

/**
 * Split by the CURRENT workspace. A token with no workspace_id is not "here": it
 * is never silently folded into the default list, because the default list is the
 * one whose revoke button is unguarded.
 */
export function splitTokens<T extends ScopedToken>(tokens: T[], currentId: string): { here: T[]; elsewhere: T[] } {
  const here: T[] = [];
  const elsewhere: T[] = [];
  for (const t of tokens) (t.workspace_id === currentId ? here : elsewhere).push(t);
  return { here, elsewhere };
}

/** A name, never a uuid (AC2). */
export function workspaceLabel(workspaceId: string | null, workspaces: WorkspaceRef[] | undefined): string {
  if (workspaceId === null) return 'No specific workspace';
  return workspaces?.find((w) => w.id === workspaceId)?.name ?? 'A workspace you are not a member of';
}
