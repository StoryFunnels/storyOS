import { describe, expect, it, vi } from 'vitest';
import {
  authorizationMetadataUrl,
  fetchAuthorizationMetadata,
  hasStoryOsMcpScope,
  protectedResourceMetadata,
} from './oauth.js';

describe('hosted MCP OAuth metadata', () => {
  it('advertises the resource, auth base path, refresh support, and MCP scope', () => {
    expect(
      protectedResourceMetadata('https://mcp.storyos.dev/', 'https://app.storyos.dev/api/v1/auth/'),
    ).toEqual({
      resource: 'https://mcp.storyos.dev/mcp',
      authorization_servers: ['https://app.storyos.dev/api/v1/auth'],
      scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'storyos.mcp'],
      bearer_methods_supported: ['header'],
    });
  });

  it('fetches Better Auth discovery from its mounted base path', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token_endpoint: 'https://example.test/token' }), {
        status: 200,
      }),
    );

    await expect(
      fetchAuthorizationMetadata('https://app.example/api/v1/auth/', fetcher),
    ).resolves.toEqual({
      token_endpoint: 'https://example.test/token',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://app.example/api/v1/auth/.well-known/oauth-authorization-server',
      { headers: { Accept: 'application/json' } },
    );
  });

  it('rejects an unavailable upstream discovery document', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      fetchAuthorizationMetadata('https://app.example/api/v1/auth', fetcher),
    ).rejects.toThrow('returned 404');
  });
});

describe('StoryOS MCP OAuth scope', () => {
  it('accepts both Better Auth space-delimited scopes and arrays', () => {
    expect(hasStoryOsMcpScope('openid offline_access storyos.mcp')).toBe(true);
    expect(hasStoryOsMcpScope(['openid', 'storyos.mcp'])).toBe(true);
  });

  it('does not accept an ordinary OIDC token without the MCP scope', () => {
    expect(hasStoryOsMcpScope('openid profile email')).toBe(false);
    expect(hasStoryOsMcpScope(undefined)).toBe(false);
  });

  it('builds the mounted Better Auth discovery URL', () => {
    expect(authorizationMetadataUrl('https://app.example/api/v1/auth/')).toBe(
      'https://app.example/api/v1/auth/.well-known/oauth-authorization-server',
    );
  });
});
