/**
 * #1030 / #1079 — what a person approved when they pressed Allow: ALL their workspaces (the default) or ONE. Stored on the
 * `oauth_consent` row better-auth already provides, as an extra scope word beside the OAuth scopes (`ws:all` or `ws:<uuid>`), so
 * no schema change is needed and the row remains the single record of "this person allowed this client".
 *
 * There is NO access level (#1079): every AI connection can read and write, and limiting which tools an AI uses is the client's
 * job. Role and grants still decide what the person can do in each workspace, exactly as for a session.
 *
 * An OAuth access token has no workspace of its own, so the AuthGuard looks the grant up by (user, client) on every request.
 * No grant means no access: a token minted by a flow nobody consented to is inert. "All" is resolved per request, never frozen
 * into a list: a workspace the person joins later is reachable, one they leave is not.
 */
export interface OauthGrant {
  /** The one workspace approved, or null for all of the person's workspaces. */
  workspaceId: string | null;
}

const WS = 'ws:';
const ACCESS = 'access:';
const ALL = 'all';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatGrantScopes(oauthScopes: string[], grant: OauthGrant): string {
  return [...oauthScopes.filter((s) => !s.startsWith(WS) && !s.startsWith(ACCESS)), `${WS}${grant.workspaceId ?? ALL}`].join(' ');
}

/**
 * The grant in a consent row's scopes, or null when it carries none (an old row, a malformed one): fail closed.
 *
 * A row written before #1079 may carry `access:read`. That level no longer exists and the person approved a smaller thing than
 * every connection now is, so it is NOT upgraded behind their back: it reads as no grant, the client is refused, and Connect
 * your AI shows "Reconnect needed". An old `access:write` row is exactly what is now offered for one workspace, so it stays valid.
 */
export function parseGrantScopes(scopes: string | null | undefined): OauthGrant | null {
  const words = (scopes ?? '').split(/\s+/).filter(Boolean);
  const ws = words.find((w) => w.startsWith(WS))?.slice(WS.length);
  if (words.includes(`${ACCESS}read`)) return null;
  if (ws === ALL) return { workspaceId: null };
  if (!ws || !UUID.test(ws)) return null;
  return { workspaceId: ws.toLowerCase() };
}

/** Plain-language labels for the scopes the consent screen shows. Unknown scopes are shown as their id, never hidden. */
export const SCOPE_LABELS: Record<string, string> = {
  openid: 'Know who you are',
  profile: 'See your name and picture',
  email: 'See your email address',
  offline_access: 'Stay connected without asking you to sign in again',
  'storyos.mcp': 'Read and change your data in the workspaces you allow, as you',
};
