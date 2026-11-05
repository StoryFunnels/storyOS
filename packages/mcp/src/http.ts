#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { defaultBaseUrl, makeClientFor } from './client.js';
import { resolveToolProfile } from './tool-profiles.js';
import {
  fetchAuthorizationMetadata,
  protectedResourceMetadata,
  STORYOS_MCP_SCOPE,
} from './oauth.js';

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

/** #1047: the largest request body /mcp accepts. A JSON-RPC call is small; 4 MiB leaves room for a long document body. */
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body is larger than ${limit} bytes`);
  }
}

/**
 * Read a JSON body, stopping at `limit` bytes: past it the request is paused and the promise rejects with BodyTooLargeError, so
 * nothing beyond the cap is buffered. Chunks are kept as Buffers and decoded once, so a multi-byte character split across two
 * chunks is not mangled. An empty or non-JSON body resolves to undefined (the transport answers that with its own error).
 */
export function readBody(req: IncomingMessage, limit: number = DEFAULT_MAX_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on('data', (c: Buffer | string) => {
      if (done) return;
      const chunk = typeof c === 'string' ? Buffer.from(c) : c;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.pause();
        finish(() => reject(new BodyTooLargeError(limit)));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      finish(() => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data) return resolve(undefined);
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(undefined);
        }
      }),
    );
    req.on('error', () => finish(() => resolve(undefined)));
  });
}

/** The declared Content-Length, or undefined when absent or not a plain non-negative integer (chunked uploads have none). */
function declaredLength(req: IncomingMessage): number | undefined {
  const h = req.headers['content-length'];
  if (typeof h !== 'string' || !/^\d+$/.test(h)) return undefined;
  return Number(h);
}

/**
 * #1047: is this bearer one the API accepts? Only a definite 401 from GET /me counts as "no": a network error or a 5xx answers
 * "unknown" and the request goes on (the API still checks the token on every call the tools make), so an API hiccup never locks
 * a valid connection out. Exported for the handler's default; tests inject their own.
 */
export async function tokenRejected(baseUrl: string, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    return res.status === 401;
  } catch {
    return false;
  }
}

function rpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extra?: Record<string, string | string[]>,
) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Endpoint configuration, resolved from the environment. Extracted so the request
 * handler is a pure function of (req, res, config) and can be unit-tested without
 * binding a port or mutating process.env.
 *
 * OAuth discovery (MN-154) is advertised only when MCP_OAUTH is on (i.e. the
 * StoryOS authorization server is live); PAT auth works regardless.
 */
export interface HttpConfig {
  oauth: boolean;
  /** #1047: the largest request body accepted, in bytes (MCP_MAX_BODY_BYTES; default 4 MiB). */
  maxBodyBytes: number;
  /** Public origin of THIS MCP endpoint (e.g. https://mcp.storyos.dev). */
  publicUrl: string;
  /** Base URL of the OAuth authorization server (the StoryOS API's auth mount). */
  authServer: string;
}

export function resolveConfig(e: NodeJS.ProcessEnv = process.env): HttpConfig {
  const max = Number(e.MCP_MAX_BODY_BYTES);
  return {
    oauth: e.MCP_OAUTH === 'true' || e.MCP_OAUTH === '1',
    maxBodyBytes: Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_BODY_BYTES,
    publicUrl: (e.MCP_PUBLIC_URL ?? 'https://mcp.storyos.dev').replace(/\/$/, ''),
    authServer: (e.MCP_AUTH_SERVER ?? 'https://app.storyos.dev/api/v1/auth').replace(/\/$/, ''),
  };
}

/**
 * The `WWW-Authenticate` value(s) sent when a request arrives with NO credentials.
 *
 * #331 — the coexistence tradeoff. This endpoint is auth-method-agnostic: it
 * forwards whatever Bearer it receives to the API, which validates it as a PAT
 * (`mn_pat_…`) OR — when MCP_OAUTH is on — an OAuth access token. A client that
 * actually presents a valid PAT NEVER reaches this branch, so PATs keep working
 * regardless of MCP_OAUTH.
 *
 * The failure mode #331 is about is subtler: some MCP clients probe with no token
 * first, and a challenge carrying `resource_metadata=…` makes them treat the
 * resource as OAuth-*only* and drop a PAT they were otherwise configured to send.
 * To keep a dual-capable client's PAT path selectable we advertise BOTH schemes
 * when OAuth is on: the OAuth challenge (so the authorization flow is
 * discoverable) AND a plain `Bearer` realm naming the PAT option. A client that
 * understands only one still finds its scheme; one that understands both may
 * choose either. The tradeoff we accept: strictly-OAuth clients ignore the second
 * challenge (harmless), and we cannot force a client that only reacts to
 * `resource_metadata` to prefer its PAT — that last mile is client-side.
 */
export function challengeHeader(config: Pick<HttpConfig, 'oauth' | 'publicUrl' | 'authServer'>): string | string[] {
  if (!config.oauth) return 'Bearer realm="StoryOS MCP"';
  const resourceMetadata = `${config.publicUrl}/.well-known/oauth-protected-resource`;
  return [
    `Bearer realm="StoryOS MCP", scope="${STORYOS_MCP_SCOPE}", resource_metadata="${resourceMetadata}"`,
    'Bearer realm="StoryOS MCP personal access token"',
  ];
}

/** What the handler asks the outside world; injectable so tests need no API. */
export interface HttpDeps {
  /** True only when the API definitely refuses this bearer (see `tokenRejected`). */
  tokenRejected: (token: string) => Promise<boolean>;
}

export function createRequestListener(
  config: HttpConfig = resolveConfig(),
  deps: HttpDeps = { tokenRejected: (token) => tokenRejected(defaultBaseUrl(), token) },
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Permissive CORS so browser-based MCP clients (e.g. the Inspector) can connect.
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = requestUrl.pathname;

    // Health / liveness (for Caddy + uptime checks).
    if (pathname === '/' || pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'storyos-mcp', transport: 'streamable-http', ok: true }));
      return;
    }

    // Protected Resource Metadata (RFC 9728) — points MCP clients at the authorization server.
    if (config.oauth && pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(protectedResourceMetadata(config.publicUrl, config.authServer)));
      return;
    }

    // Compatibility discovery at the MCP origin. Claude and ChatGPT both probe
    // the connector host during setup, while Better Auth owns the actual AS
    // routes under /api/v1/auth on the app origin.
    if (config.oauth && pathname === '/.well-known/oauth-authorization-server') {
      try {
        const metadata = await fetchAuthorizationMetadata(config.authServer);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(JSON.stringify(metadata));
      } catch (error) {
        rpcError(
          res,
          502,
          -32603,
          error instanceof Error ? error.message : 'OAuth discovery is unavailable',
        );
      }
      return;
    }

    if (pathname !== '/mcp') {
      rpcError(res, 404, -32601, 'Not found — the MCP endpoint is POST /mcp');
      return;
    }

    // Dual auth: any Bearer is forwarded to the StoryOS API, which validates it as a
    // PAT (mn_pat_…, self-managed) or — when OAuth is enabled — an OAuth access token.
    // A request that carries ANY token skips the challenge entirely, so a valid PAT
    // always authenticates whether or not MCP_OAUTH is on (see challengeHeader).
    const token = bearer(req);
    if (!token) {
      rpcError(
        res,
        401,
        -32001,
        'Missing bearer token — send Authorization: Bearer <StoryOS PAT or OAuth token>',
        { 'WWW-Authenticate': challengeHeader(config) },
      );
      return;
    }

    // #1177: `?profile=agent-run` (the Runner sets it) offers a run only its role's tools. Unknown profile = an error, never the full set.
    const profile = resolveToolProfile(requestUrl.searchParams);
    if (!profile.ok) {
      rpcError(res, 400, -32602, profile.error);
      return;
    }

    // #1047: the size is checked before anything is read, and the token before the body is: an oversized or unauthenticated
    // request costs a header check (and one GET /me), never a buffered body or a server build.
    const tooLarge = () => rpcError(res, 413, -32600, `Request body too large (limit ${config.maxBodyBytes} bytes)`, { Connection: 'close' });
    const declared = declaredLength(req);
    if (declared !== undefined && declared > config.maxBodyBytes) {
      tooLarge();
      return;
    }
    if (await deps.tokenRejected(token)) {
      rpcError(res, 401, -32001, 'Invalid or expired bearer token', { 'WWW-Authenticate': challengeHeader(config) });
      return;
    }

    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readBody(req, config.maxBodyBytes);
      } catch (err) {
        if (!(err instanceof BodyTooLargeError)) throw err;
        tooLarge(); // `Connection: close`: the rest of the paused body is never read, the socket closes after this answer
        return;
      }
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = await buildServer(makeClientFor(token), profile.allow ? { onlyTools: profile.allow } : {});
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
  };
}

export function startServer(config: HttpConfig = resolveConfig()): ReturnType<typeof createServer> {
  if (config.oauth) {
    // #331 operator guardrail: flipping MCP_OAUTH on changes the unauthenticated
    // challenge and can make some connectors abandon a working PAT. Warn loudly so
    // the operator knows to test the OAuth flow and expect possible reconnections.
    process.stderr.write(
      'storyos-mcp: WARNING — MCP_OAUTH is enabled. The endpoint now advertises OAuth on ' +
        'unauthenticated probes. Existing PAT (mn_pat_…) connections still work, but TEST the ' +
        'OAuth flow end to end and expect some clients to need reconnection.\n',
    );
  }
  const server = createServer(createRequestListener(config));
  server.listen(PORT, () => {
    process.stderr.write(`storyos-mcp: Streamable HTTP listening on :${PORT} (POST /mcp)\n`);
  });
  return server;
}

// Auto-start only when run as the entrypoint, not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startServer();
}
