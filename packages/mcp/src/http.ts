#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { makeClientFor } from './client.js';

/**
 * Hosted Streamable HTTP entrypoint (MN-105) — the cloud MCP endpoint.
 *
 * Runs stateless: each request builds a fresh server bound to the PAT carried in
 * its own `Authorization: Bearer mn_pat_…` header, so one endpoint serves every
 * user and the API scopes each response. Connect a claude.ai / ChatGPT connector
 * to `https://mcp.storyos.dev/mcp` with a StoryOS PAT — no local process, no repo.
 *
 * Env:
 *   PORT         (default 3002)
 *   STORYOS_URL  the API base (e.g. http://api:3001 in-cluster, or https://app.storyos.dev)
 */
const PORT = Number(process.env.PORT ?? 3002);

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve(undefined);
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, extra?: Record<string, string>) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

// OAuth discovery (MN-154). Advertised only when MCP_OAUTH is on (i.e. the StoryOS
// authorization server is live); PAT auth works regardless. Clients read the
// resource metadata to find the AS and run the OAuth flow.
const OAUTH = process.env.MCP_OAUTH === 'true' || process.env.MCP_OAUTH === '1';
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? 'https://mcp.storyos.dev').replace(/\/$/, '');
const AUTH_SERVER = (process.env.MCP_AUTH_SERVER ?? 'https://app.storyos.dev').replace(/\/$/, '');
const RESOURCE_METADATA = `${PUBLIC_URL}/.well-known/oauth-protected-resource`;

const server = createServer(async (req, res) => {
  // Permissive CORS so browser-based MCP clients (e.g. the Inspector) can connect.
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

  // Health / liveness (for Caddy + uptime checks).
  if (pathname === '/' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'storyos-mcp', transport: 'streamable-http', ok: true }));
    return;
  }

  // Protected Resource Metadata (RFC 9728) — points MCP clients at the authorization server.
  if (OAUTH && pathname === '/.well-known/oauth-protected-resource') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [AUTH_SERVER] }));
    return;
  }

  if (pathname !== '/mcp') {
    rpcError(res, 404, -32601, 'Not found — the MCP endpoint is POST /mcp');
    return;
  }

  // Dual auth: any Bearer is forwarded to the StoryOS API, which validates it as a
  // PAT (mn_pat_…, self-managed) or — when OAuth is enabled — an OAuth access token.
  const token = bearer(req);
  if (!token) {
    rpcError(res, 401, -32001, 'Missing bearer token — send Authorization: Bearer <StoryOS PAT or OAuth token>', {
      'WWW-Authenticate': OAUTH
        ? `Bearer realm="StoryOS MCP", resource_metadata="${RESOURCE_METADATA}"`
        : 'Bearer realm="StoryOS MCP"',
    });
    return;
  }

  const body = req.method === 'POST' ? await readBody(req) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const mcp = buildServer(makeClientFor(token));
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    if (!res.headersSent) {
      rpcError(res, 500, -32603, err instanceof Error ? err.message : String(err));
    }
  }
});

server.listen(PORT, () => {
  process.stderr.write(`storyos-mcp: Streamable HTTP listening on :${PORT} (POST /mcp)\n`);
});
