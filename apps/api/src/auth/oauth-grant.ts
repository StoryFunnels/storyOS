import type { TokenScope } from '@storyos/schemas';

/**
 * #1030 — what a person approved when they pressed Allow: ONE workspace and a power ceiling. Stored on the `oauth_consent`
 * row better-auth already provides, as extra scope words beside the OAuth scopes (`ws:<uuid>`, `access:<read|write>`), so no
 * schema change is needed and the row remains the single record of "this person allowed this client".
 *
 * An OAuth access token has no workspace or ceiling of its own, so the AuthGuard looks the grant up by (user, client) on every
 * request. No grant means no access: a token minted by a flow nobody consented to is inert.
 */
export interface OauthGrant {
  workspaceId: string;
  access: Extract<TokenScope, 'read' | 'write'>;
}

const WS = 'ws:';
const ACCESS = 'access:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatGrantScopes(oauthScopes: string[], grant: OauthGrant): string {
  return [...oauthScopes.filter((s) => !s.startsWith(WS) && !s.startsWith(ACCESS)), `${WS}${grant.workspaceId}`, `${ACCESS}${grant.access}`].join(' ');
}

/** The grant in a consent row's scopes, or null when it carries none (an old row, a malformed one): fail closed. */
export function parseGrantScopes(scopes: string | null | undefined): OauthGrant | null {
  const words = (scopes ?? '').split(/\s+/).filter(Boolean);
  const ws = words.find((w) => w.startsWith(WS))?.slice(WS.length);
  const access = words.find((w) => w.startsWith(ACCESS))?.slice(ACCESS.length);
  if (!ws || !UUID.test(ws) || (access !== 'read' && access !== 'write')) return null;
  return { workspaceId: ws.toLowerCase(), access };
}

/** Plain-language labels for the scopes the consent screen shows. Unknown scopes are shown as their id, never hidden. */
export const SCOPE_LABELS: Record<string, string> = {
  openid: 'Know who you are',
  profile: 'See your name and picture',
  email: 'See your email address',
  offline_access: 'Stay connected without asking you to sign in again',
  'storyos.mcp': 'Read and change the data in the workspace you choose, as you',
};
