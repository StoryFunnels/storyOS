#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

/**
 * stdio entrypoint for Claude Desktop / Claude Code (MN-076). Configure with:
 *   STORYOS_URL   (default http://localhost:3001)
 *   STORYOS_TOKEN (a personal access token, mn_pat_…)
 * Logs go to stderr only — stdout is the MCP protocol channel.
 */
async function main() {
  const server = await buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('storyos-mcp: connected over stdio\n');
}

main().catch((err) => {
  process.stderr.write(`storyos-mcp: fatal ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
