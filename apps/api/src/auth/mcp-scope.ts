export const STORYOS_MCP_SCOPE = 'storyos.mcp';

export function hasStoryOsMcpScope(scopes: string | string[] | null | undefined): boolean {
  const values = Array.isArray(scopes) ? scopes : (scopes ?? '').split(/[\s,]+/);
  return values.includes(STORYOS_MCP_SCOPE);
}
