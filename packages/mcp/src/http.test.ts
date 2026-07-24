import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { challengeHeader, createRequestListener, resolveConfig } from './http.js';

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
    const handle = createRequestListener({ oauth: true, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    const { res, captured } = fakeRes();
    await handle(fakeReq('POST', '/mcp'), res);
    expect(captured.status).toBe(401);
    expect(Array.isArray(captured.headers['WWW-Authenticate'])).toBe(true);
  });

  it('401s with a single plain-Bearer challenge when OAuth is OFF', async () => {
    const handle = createRequestListener({ oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    const { res, captured } = fakeRes();
    await handle(fakeReq('POST', '/mcp'), res);
    expect(captured.status).toBe(401);
    expect(captured.headers['WWW-Authenticate']).toBe('Bearer realm="StoryOS MCP"');
  });

  it('serves protected-resource metadata only when OAuth is ON', async () => {
    const on = createRequestListener({ oauth: true, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    const { res, captured } = fakeRes();
    await on(fakeReq('GET', '/.well-known/oauth-protected-resource'), res);
    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body!)).toMatchObject({
      resource: 'https://mcp.x/mcp',
      authorization_servers: ['https://as.x'],
      scopes_supported: expect.arrayContaining(['storyos.mcp']),
    });

    const off = createRequestListener({ oauth: false, publicUrl: 'https://mcp.x', authServer: 'https://as.x' });
    const r2 = fakeRes();
    await off(fakeReq('GET', '/.well-known/oauth-protected-resource'), r2.res);
    expect(r2.captured.status).toBe(404);
  });
});
