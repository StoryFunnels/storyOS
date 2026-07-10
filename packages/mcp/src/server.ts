import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeClient } from './client.js';
import { registerTools } from './tools.js';

/**
 * Build the StoryOS MCP server (MN-076). Transport-agnostic on purpose: index.ts
 * connects it over stdio for Claude Desktop / Claude Code today; the same server
 * can be served over Streamable HTTP later for hosted ChatGPT / claude.ai connectors.
 */
export function buildServer(): McpServer {
  const server = new McpServer({ name: 'storyos', version: '0.1.0' });
  registerTools(server, makeClient());
  return server;
}
