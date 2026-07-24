export const STORYOS_MCP_SCOPE = 'storyos.mcp';

/**
 * The full scope set the StoryOS authorization server supports for hosted-MCP
 * OAuth (MN-154 / #331). `offline_access` is what better-auth keys refresh-token
 * issuance off; `storyos.mcp` is ours — the guard (auth.guard.ts) requires it on
 * an OAuth access token, so it MUST be advertised, or a spec-conformant client
 * never requests it and its token is rejected. Mirrors packages/mcp `oauth.ts`.
 */
export const MCP_SUPPORTED_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  STORYOS_MCP_SCOPE,
] as const;

export function hasStoryOsMcpScope(scopes: string | string[] | null | undefined): boolean {
  const values = Array.isArray(scopes) ? scopes : (scopes ?? '').split(/[\s,]+/);
  return values.includes(STORYOS_MCP_SCOPE);
}

/**
 * Merge the StoryOS supported scopes into a discovery document's
 * `scopes_supported`, de-duplicated and preserving any the plugin already listed.
 *
 * #331 — better-auth 1.6.23's `mcp()` plugin HARDCODES `scopes_supported` in its
 * `/.well-known/oauth-authorization-server` response and provides no config hook
 * that reaches it (`oidcConfig.metadata.scopes_supported` only feeds the
 * *protected-resource* document, not the AS document). So `storyos.mcp` can only
 * be advertised there by rewriting the response — which is what app.setup.ts does
 * with this. A client only requests scopes it sees advertised, so without this the
 * OAuth token never carries `storyos.mcp` and the guard rejects every tool call.
 *
 * Returns a new object; safe to hand a parsed JSON body from the better-auth handler.
 */
export function augmentSupportedScopes<T extends { scopes_supported?: unknown }>(
  doc: T,
): T & { scopes_supported: string[] } {
  const existing = Array.isArray(doc?.scopes_supported)
    ? (doc.scopes_supported as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const merged = Array.from(new Set([...existing, ...MCP_SUPPORTED_SCOPES]));
  return { ...doc, scopes_supported: merged };
}
