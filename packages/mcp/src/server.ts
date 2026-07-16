import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchEffectiveScope, makeClient, type Ctx } from './client.js';
import { registerTools } from './tools.js';

/**
 * Build the StoryOS MCP server (MN-076). Transport-agnostic on purpose: index.ts
 * connects it over stdio (Claude Desktop / Claude Code) with the env token; http.ts
 * connects it over Streamable HTTP (hosted ChatGPT / claude.ai connectors) with a
 * per-request client. Pass a client for the hosted case; omit for stdio/env.
 *
 * Async because it first asks the API (GET /me) what this credential can do (MN-134)
 * and advertises only the tools the token's scope permits — the HTTP transport builds
 * a fresh server per request, so each connection reflects its own token's ceiling.
 */
export async function buildServer(ctx: Ctx = makeClient()): Promise<McpServer> {
  const server = new McpServer({ name: 'storyos', version: '0.1.0' });
  const effective = await fetchEffectiveScope(ctx);
  registerTools(server, ctx, effective);
  return server;
}
