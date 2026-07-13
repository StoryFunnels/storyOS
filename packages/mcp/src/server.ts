import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeClient, type Client } from './client.js';
import { registerTools } from './tools.js';

/**
 * Build the StoryOS MCP server (MN-076). Transport-agnostic on purpose: index.ts
 * connects it over stdio (Claude Desktop / Claude Code) with the env token; http.ts
 * connects it over Streamable HTTP (hosted ChatGPT / claude.ai connectors) with a
 * per-request client. Pass a client for the hosted case; omit for stdio/env.
 */
export function buildServer(client: Client = makeClient()): McpServer {
  const server = new McpServer({ name: 'storyos', version: '0.1.0' });
  registerTools(server, client);
  return server;
}
