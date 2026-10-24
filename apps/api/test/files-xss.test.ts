import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { workspaceFiles } from '../src/db/schema';
import { getStorage } from '../src/attachments/storage';
import { mintDownloadUrl } from '../src/files/signed-download';
import { sniffImageMime } from '../src/files/image-sniff';

/**
 * #1031 — stored XSS through `GET /files/:id`. The app and API share one origin, so an SVG with a script that the
 * endpoint replays as `image/svg+xml` runs as the victim (mint a PAT, take the account). The attack has two halves and
 * each is closed on its own: nothing script-capable can be UPLOADED, and what is already stored is never SERVED as
 * something a browser executes.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string;
const BOUNDARY = 'X-XSS-BOUNDARY';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/v1/me/tokens",{method:"POST",credentials:"include"})</script></svg>');

const multipart = (filename: string, mime: string, data: Buffer) =>
  Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
const upload = (filename: string, mime: string, data: Buffer) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ws}/files`,
    headers: { ...authed(admin.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipart(filename, mime, data),
  });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Xss Owner');
  ws = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: authed(admin.token), payload: { name: 'Xss WS' } })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1031 nothing script-capable can be uploaded', () => {
  it.each([
    ['an SVG sent as image/svg+xml', 'x.svg', 'image/svg+xml', SVG],
    ['an SVG sent as image/png (a lie about the type)', 'x.png', 'image/png', SVG],
    ['HTML sent as image/png', 'x.png', 'image/png', Buffer.from('<html><script>alert(1)</script></html>')],
    ['a PNG sent as image/svg+xml (type disagrees with the bytes)', 'x.svg', 'image/svg+xml', PNG],
    ['a PNG sent as image/jpeg', 'x.jpg', 'image/jpeg', PNG],
    ['a PNG sent with no type', 'x', '', PNG],
    ['an SVG whose first bytes are a PNG signature padded in front (polyglot attempt)', 'x.png', 'image/png', Buffer.concat([Buffer.from([0x89, 0x50]), SVG])],
  ])('rejects %s', async (_n, filename, mime, data) => {
    const res = await upload(filename, mime, data);
    expect(res.statusCode, res.body).toBe(422);
  });

  it.each([
    ['image/png', PNG], ['image/jpeg', JPEG], ['image/gif', GIF], ['image/webp', WEBP],
  ])('still accepts a real %s', async (mime, data) => {
    const res = await upload('ok', mime, data);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('the sniffer names each real type and nothing else', () => {
    expect([PNG, JPEG, GIF, WEBP].map(sniffImageMime)).toEqual(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
    expect(sniffImageMime(SVG)).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('#1031 what is served is never executable', () => {
  it('a real upload is served with nosniff and a sandbox CSP', async () => {
    const { id } = (await upload('p.png', 'image/png', PNG)).json();
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['content-disposition'], 'a normal image still renders inline').toBeUndefined();
  });

  it('an SVG ALREADY STORED (uploaded before the allowlist) is served as an opaque attachment, on both read paths', async () => {
    const key = `editor/${ws}/legacy-svg`;
    await getStorage().put(key, SVG, 'image/svg+xml');
    const [row] = await app.get<Db>(DB).insert(workspaceFiles).values({ workspaceId: ws, filename: 'evil.svg', mime: 'image/svg+xml', size: SVG.length, storageKey: key }).returning();

    const inline = await app.inject({ method: 'GET', url: `/api/v1/files/${row!.id}` });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers['content-type'], 'never replayed as image/svg+xml').toBe('application/octet-stream');
    expect(inline.headers['content-disposition']).toContain('attachment');
    expect(inline.headers['x-content-type-options']).toBe('nosniff');
    expect(inline.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    const dl = await app.inject({ method: 'GET', url: mintDownloadUrl(row!.id).url });
    expect(dl.statusCode, dl.body).toBe(200);
    expect(dl.headers['content-type']).toBe('application/octet-stream');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
});
