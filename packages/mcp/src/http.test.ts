import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BodyTooLargeError, challengeHeader, createRequestListener, readBody, resolveConfig } from './http.js';

/**
 * #331 — the hosted MCP endpoint is auth-method-agnostic: it forwards any Bearer
 * to the API, so a valid PAT always authenticates (that end-to-end guarantee is
 * pinned API-side in apps/api/test/mcp-oauth.test.ts). What changed here is the
 * unauthenticated challenge, so that is what these tests cover.
 */

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers, on: () => undefined } as unknown as IncomingMessage;
}

interface Captured {
  status?: number;
  headers: Record<string, string | string[]>;
  body?: string;
}

function fakeRes(): { res: ServerResponse; captured: Captured } {
  const captured: Captured = { headers: {} };
  const res = {
    headersSent: false,
    setHeader(k: string, v: string | string[]) {
      captured.headers[k] = v;
    },
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return this;
    },
    end(body?: string) {
      captured.body = body;
    },
    on() {
      return this;
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('resolveConfig', () => {
  it('reads MCP_OAUTH truthy values and trims trailing slashes', () => {
    expect(resolveConfig({ MCP_OAUTH: 'true' }).oauth).toBe(true);
    expect(resolveConfig({ MCP_OAUTH: '1' }).oauth).toBe(true);
    expect(resolveConfig({ MCP_OAUTH: 'false' }).oauth).toBe(false);
    expect(resolveConfig({}).oauth).toBe(false);
    const cfg = resolveConfig({
      MCP_PUBLIC_URL: 'https://mcp.example.com/',
      MCP_AUTH_SERVER: 'https://as.example.com/api/v1/auth/',
    });
    expect(cfg.publicUrl).toBe('https://mcp.example.com');
    expect(cfg.authServer).toBe('https://as.example.com/api/v1/auth');
  });

  it('#1047: caps the body at 4 MiB by default, MCP_MAX_BODY_BYTES overrides, nonsense falls back', () => {
    expect(resolveConfig({}).maxBodyBytes).toBe(4 * 1024 * 1024);
    expect(resolveConfig({ MCP_MAX_BODY_BYTES: '2048' }).maxBodyBytes).toBe(2048);
    expect(resolveConfig({ MCP_MAX_BODY_BYTES: 'lots' }).maxBodyBytes).toBe(4 * 1024 * 1024);
    expect(resolveConfig({ MCP_MAX_BODY_BYTES: '-5' }).maxBodyBytes).toBe(4 * 1024 * 1024);
  });
});

describe('challengeHeader (#331 PAT coexistence)', () => {
  it('advertises only the plain Bearer scheme when OAuth is OFF', () => {
    const value = challengeHeader({ oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    expect(value).toBe('Bearer realm="StoryOS MCP"');
  });

  it('advertises BOTH the OAuth challenge and a PAT challenge when OAuth is ON', () => {
    const value = challengeHeader({ oauth: true, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    expect(Array.isArray(value)).toBe(true);
    const arr = value as string[];
    // OAuth discovery challenge — carries resource_metadata + the required scope.
    expect(arr.some((c) => c.includes('resource_metadata="https://mcp.x/.well-known/oauth-protected-resource"'))).toBe(true);
    expect(arr.some((c) => c.includes('scope="storyos.mcp"'))).toBe(true);
    // A dual-capable client can still see and choose the PAT scheme.
    expect(arr.some((c) => c.toLowerCase().includes('personal access token'))).toBe(true);
  });
});

describe('createRequestListener no-token challenge', () => {
  it('401s an unauthenticated /mcp probe with a dual challenge when OAuth is ON', async () => {
    const handle = createRequestListener({ oauth: true, publicUrl: 'https://mcp.x', authServer: 'https://as.x', maxBodyBytes: 1024 });
    const { res, captured } = fakeRes();
    await handle(fakeReq('POST', '/mcp'), res);
    expect(captured.status).toBe(401);
    expect(Array.isArray(captured.headers['WWW-Authenticate'])).toBe(true);
  });

  it('401s with a single plain-Bearer challenge when OAuth is OFF', async () => {
    const handle = createRequestListener({ oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x', maxBodyBytes: 1024 });
    const { res, captured } = fakeRes();
    await handle(fakeReq('POST', '/mcp'), res);
    expect(captured.status).toBe(401);
    expect(captured.headers['WWW-Authenticate']).toBe('Bearer realm="StoryOS MCP"');
  });

  it('serves protected-resource metadata only when OAuth is ON', async () => {
    const on = createRequestListener({ oauth: true, publicUrl: 'https://mcp.x', authServer: 'https://as.x', maxBodyBytes: 1024 });
    const { res, captured } = fakeRes();
    await on(fakeReq('GET', '/.well-known/oauth-protected-resource'), res);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body!)).toMatchObject({
      resource: 'https://mcp.x/mcp',
      authorization_servers: ['https://as.x'],
      scopes_supported: expect.arrayContaining(['storyos.mcp']),
    });

    const off = createRequestListener({ oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x', maxBodyBytes: 1024 });
    const r2 = fakeRes();
    await off(fakeReq('GET', '/.well-known/oauth-protected-resource'), r2.res);
    expect(r2.captured.status).toBe(404);
  });
});

/**
 * #1047 — /mcp refuses an oversized body without buffering it, and an invalid bearer before reading the body at all. A real
 * server on an ephemeral port, so the streaming path (no Content-Length, chunked) is the one Node actually runs.
 */
describe('createRequestListener body cap and bearer check (#1047)', () => {
  const LIMIT = 1024;
  let server: Server;
  let url: string;
  let rejected: string[];
  let checks: string[];

  beforeEach(async () => {
    rejected = ['bad-token'];
    checks = [];
    const handle = createRequestListener(
      { oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x', maxBodyBytes: LIMIT },
      {
        tokenRejected: async (t) => {
          checks.push(t);
          return rejected.includes(t);
        },
      },
    );
    server = createServer((req, res) => void handle(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('413s a body whose Content-Length is over the cap, before checking the token', async () => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer good', 'Content-Type': 'application/json' }, body: 'x'.repeat(LIMIT + 1) });
    expect(res.status).toBe(413);
    expect((await res.json()).error.message).toContain(`${LIMIT} bytes`);
    expect(checks).toEqual([]);
  });

  it('413s a chunked body (no Content-Length) as soon as it passes the cap', async () => {
    const big = new ReadableStream({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new TextEncoder().encode('y'.repeat(512)));
        c.close();
      },
    });
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer good' }, body: big, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
  });

  it('401s a bearer the API rejects, without reading the body', async () => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer bad-token', 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="StoryOS MCP"');
    expect(checks).toEqual(['bad-token']);
  });

  it('readBody: parses a body under the cap, keeps a multi-byte character split across chunks, and rejects past the cap', async () => {
    const parts = [Buffer.from('{"t":"'), Buffer.from('é').subarray(0, 1), Buffer.concat([Buffer.from('é').subarray(1), Buffer.from('"}')])];
    expect(await readBody(fakeStream(parts), LIMIT)).toEqual({ t: 'é' });
    await expect(readBody(fakeStream([Buffer.alloc(LIMIT + 1, 0x20)]), LIMIT)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(await readBody(fakeStream([Buffer.from('not json')]), LIMIT)).toBeUndefined();
  });
});

function fakeStream(chunks: Buffer[]): IncomingMessage {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  const req = {
    on(ev: string, fn: (arg?: unknown) => void) {
      handlers[ev] = fn;
      if (ev === 'end') queueMicrotask(() => {
        for (const c of chunks) handlers.data?.(c);
        handlers.end?.();
      });
      return req;
    },
    pause() {
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}
