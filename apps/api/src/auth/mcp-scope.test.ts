import { describe, expect, it } from 'vitest';
import { hasStoryOsMcpScope } from './mcp-scope';

describe('hasStoryOsMcpScope', () => {
  it('accepts the dedicated MCP scope in stored Better Auth scope strings', () => {
    expect(hasStoryOsMcpScope('openid profile offline_access storyos.mcp')).toBe(true);
    expect(hasStoryOsMcpScope(['openid', 'storyos.mcp'])).toBe(true);
  });

  it('refuses a valid OIDC token that was not minted for MCP', () => {
    expect(hasStoryOsMcpScope('openid profile email offline_access')).toBe(false);
    expect(hasStoryOsMcpScope(null)).toBe(false);
  });
});
