export const STORYOS_MCP_SCOPE = 'storyos.mcp';
export const MCP_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  STORYOS_MCP_SCOPE,
] as const;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * RFC 9728 `authorization_servers` entries are authorization-server issuer
 * identifiers, not the mounted route where an implementation happens to expose
 * its endpoints. Better Auth's metadata issuer is the app origin even though
 * its authorize/token/register routes live below `/api/v1/auth`.
 */
export function authorizationServerIssuer(authorizationServer: string): string {
  const normalized = withoutTrailingSlash(authorizationServer);
  try {
    return new URL(normalized).origin;
  } catch {
    return normalized;
  }
}

export function protectedResourceMetadata(
  publicUrl: string,
  authorizationServer: string,
): ProtectedResourceMetadata {
  return {
    resource: `${withoutTrailingSlash(publicUrl)}/mcp`,
    authorization_servers: [authorizationServerIssuer(authorizationServer)],
    scopes_supported: [...MCP_OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function authorizationMetadataUrl(authorizationServer: string): string {
  return `${withoutTrailingSlash(authorizationServer)}/.well-known/oauth-authorization-server`;
}

export async function fetchAuthorizationMetadata(
  authorizationServer: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(authorizationMetadataUrl(authorizationServer), {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Authorization server discovery returned ${response.status}`);
  }
  return response.json();
}

export function hasStoryOsMcpScope(scopes: string | string[] | null | undefined): boolean {
  const values = Array.isArray(scopes) ? scopes : (scopes ?? '').split(/[\s,]+/);
  return values.includes(STORYOS_MCP_SCOPE);
}
