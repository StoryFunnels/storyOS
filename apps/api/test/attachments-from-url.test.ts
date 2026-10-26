import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...args: unknown[]) => lookupMock(...args) }));
/** When set, the guarded fetch uses this transport instead of the network (the guard's own checks still run). */
let stub: typeof fetch | undefined;
vi.mock('../src/common/net-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/common/net-guard')>();
  return { ...actual, guardedFetch: ((f: unknown, url: string, init: unknown, opts: unknown) => actual.guardedFetch((stub ?? f) as never, url, init as never, opts as never)) as typeof actual.guardedFetch };
});

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1033 — "attach a file from a URL" used to run inside the MCP process with a bare `fetch`: redirects followed, the whole body
 * read with no cap, from inside the compose network, and the response handed back as a downloadable attachment. It now runs in
 * the API behind the address-pinned guard. Attacks are run as the attacker; the check is what ended up attached (nothing).
 */
let app: NestFastifyApplication;
let token: string;
let ws: string, dbId: string, recId: string;
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const base = () => `/workspaces/${ws}/databases/${dbId}/records/${recId}/attachments`;
const attached = async () => (await as('GET', base())).json().data as Array<{ filename: string; size: number; mime: string }>;
const fromUrl = (url: string, extra: Record<string, unknown> = {}) => as('POST', `${base()}/from-url`, { url, ...extra });
const respond = (status: number, body: BodyInit | null, headers: Record<string, string> = {}) => new Response(body, { status, headers });

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Attach From Url')).token;
  ws = (await as('POST', '/workspaces', { name: 'Attach WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Files' })).json().id;
  recId = (await as('POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'r' } })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });
beforeEach(() => {
  stub = undefined;
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('#1033 internal addresses are refused, directly and through redirects, and nothing is attached', () => {
  it.each([
    ['http://127.0.0.1:3001/api/v1/me', 'loopback'],
    ['http://169.254.169.254/hetzner/v1/userdata', 'the cloud metadata service'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped loopback in hex'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://10.0.0.5/', 'private'],
    ['file:///etc/passwd', 'a file: URL'],
    ['ftp://example.com/x', 'ftp'],
  ])('%s (%s) is refused with a 422 that names no address', async (url) => {
    const res = await fromUrl(url);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('cannot be fetched');
    expect(res.body, 'the reason does not leak which address or why').not.toMatch(/10\.0\.0|169\.254|127\.0\.0|resolves to/);
    expect(await attached()).toHaveLength(0);
  });

  it('a name that RESOLVES to a private address is refused (docker service names like api, minio, web)', async () => {
    lookupMock.mockResolvedValue([{ address: '172.18.0.3', family: 4 }]);
    const res = await fromUrl('http://api:3001/api/v1/me');
    expect(res.statusCode, res.body).toBe(422);
    expect(await attached()).toHaveLength(0);
  });

  it('a PUBLIC url that 302s to the metadata service is refused at the redirect, and the metadata host is never requested', async () => {
    const requested: string[] = [];
    stub = (async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('https://files.example.com/')) return respond(302, null, { location: 'http://169.254.169.254/hetzner/v1/userdata' });
      return respond(200, 'SECRET-INSTANCE-USERDATA');
    }) as typeof fetch;
    const res = await fromUrl('https://files.example.com/innocent.png');
    expect(res.statusCode, res.body).toBe(422);
    expect(requested, 'only the public URL was ever requested').toEqual(['https://files.example.com/innocent.png']);
    expect(JSON.stringify(await attached())).not.toContain('SECRET');
    expect(await attached()).toHaveLength(0);
  });
});

describe('#1033 size and time are capped', () => {
  it('a body over ATTACHMENT_MAX_BYTES aborts while streaming and attaches nothing', async () => {
    let produced = 0;
    stub = (async () => respond(200, new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= 60) return controller.close();
        produced++;
        controller.enqueue(new Uint8Array(1024 * 1024)); // 1 MB chunks, up to 60 MB if nobody stops reading
      },
    }), { 'content-type': 'application/octet-stream' })) as typeof fetch;
    const res = await fromUrl('https://files.example.com/huge.bin');
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('exceeds');
    expect(produced, 'the reader stopped at the 1MB test cap (about 2 chunks), not the whole body').toBeLessThan(5);
    expect(await attached()).toHaveLength(0);
  });

  it('a hung URL times out instead of holding the request forever (the abort signal reaches the transport)', async () => {
    let sawSignal = false;
    stub = (async (_u: unknown, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      throw new DOMException('The operation was aborted', 'TimeoutError');
    }) as typeof fetch;
    const res = await fromUrl('https://slow.example.com/x');
    expect(res.statusCode, res.body).toBe(422);
    expect(sawSignal).toBe(true);
  });
});

describe('#1033 a legitimate URL still attaches', () => {
  it('fetches a public file and attaches it with its real bytes, the URL\'s file name and the response type', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
    stub = (async () => respond(200, bytes, { 'content-type': 'image/png; charset=binary' })) as typeof fetch;
    const res = await fromUrl('https://files.example.com/assets/logo%20final.png?v=2');
    expect(res.statusCode, res.body).toBeLessThan(300);
    const rows = await attached();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ filename: 'logo final.png', mime: 'image/png', size: bytes.length });
  });

  it('a redirect between two PUBLIC hosts is followed (and the second hop is checked too)', async () => {
    stub = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://a.example.com/x') return respond(301, null, { location: 'https://cdn.example.com/y.txt' });
      return respond(200, 'hello', { 'content-type': 'text/plain' });
    }) as typeof fetch;
    const res = await fromUrl('https://a.example.com/x', { filename: 'named.txt' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect((await attached()).map((r) => r.filename)).toContain('named.txt');
  });

  it('a non-2xx answer is a 422 with the status only, never the body', async () => {
    stub = (async () => respond(404, '<html>internal admin page with secrets</html>')) as typeof fetch;
    const res = await fromUrl('https://files.example.com/missing');
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('HTTP 404');
    expect(res.body).not.toContain('secrets');
  });

  it('it is still an EDITOR action: a reader of the record cannot attach', async () => {
    const reader = (await signUpUser(app, 'Not A Member')).token;
    const denied = await app.inject({ method: 'POST', url: `/api/v1${base()}/from-url`, headers: authed(reader), payload: { url: 'https://files.example.com/x' } });
    expect([403, 404]).toContain(denied.statusCode);
  });
});
