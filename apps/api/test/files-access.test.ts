import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { signDownloadUrl } from '../src/files/signed-download';

/**
 * #201: `GET /files/:id` used to be unauthenticated, cached immutable for a
 * year, with no expiry and no tenant check. This covers the fix:
 *  - downloads go through a signed, expiring URL, not a permanent public one
 *  - any file URL (inline capability URL AND signed download URL) can be
 *    revoked by an operator/owner
 *  - a per-workspace private-attachments mode gates the inline path behind an
 *    access check
 *  - inline image embeds keep working, and are no longer the only thing that
 *    is cached immutably by default
 */

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;

const BOUNDARY = 'X-STORYOS-TEST-BOUNDARY';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function multipartBody(filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? admin.token),
    payload: payload as never,
  });
}

async function uploadTo(ws: string, token: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ws}/files`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody('pixel.png', 'image/png', PNG),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; url: string };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'FileOwner');
  wsId = (await inject('POST', '/workspaces', { name: 'Files WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('inline capability URL (#201)', () => {
  it('serves an uploaded image unauthenticated, cached immutable', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    const res = await app.inject({ method: 'GET', url: `/api/v1/files/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });
});

describe('signed download URLs (#201)', () => {
  it('mints a URL that succeeds within its expiry window, not cached immutably', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    const mint = await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`);
    expect(mint.statusCode, mint.body).toBe(201);
    const { url, expires_at } = mint.json() as { url: string; expires_at: string };
    expect(new Date(expires_at).getTime()).toBeGreaterThan(Date.now());

    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode, res.body.toString()).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers['content-disposition']).toContain('pixel.png');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('rejects a tampered signature — mutated id', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    const other = await uploadTo(wsId, admin.token);
    const mint = (await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`)).json() as { url: string };
    const parsed = new URL(mint.url, 'http://x');
    // Swap in a different (also real, also unexpired) file id, keep the
    // original signature — this is the "reuse a valid sig for a different
    // resource" bug class, not just a garbage-signature test.
    const forged = parsed.pathname.replace(id, other.id) + parsed.search;
    const res = await app.inject({ method: 'GET', url: forged });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tampered signature — mutated expires', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    const mint = (await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`)).json() as { url: string };
    const parsed = new URL(mint.url, 'http://x');
    const extended = String(Number(parsed.searchParams.get('expires')) + 100_000);
    parsed.searchParams.set('expires', extended);
    const res = await app.inject({ method: 'GET', url: `${parsed.pathname}${parsed.search}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request past its expiry', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    const pastExpires = String(Math.floor(Date.now() / 1000) - 60);
    const sig = signDownloadUrl(id, pastExpires);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${id}/download?expires=${pastExpires}&sig=${sig}`,
    });
    expect(res.statusCode).toBe(410);
  });

  it('mint requires access to the file — 404 for a non-member', async () => {
    const outsider = await signUpUser(app, 'FileOutsider');
    const { id } = await uploadTo(wsId, admin.token);
    const res = await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`, undefined, outsider.token);
    expect(res.statusCode).toBe(404);
  });
});

describe('revoke (#201) — the load-bearing test', () => {
  it('kills a previously-valid signed download URL AND the inline capability URL', async () => {
    const { id, url: inlineUrl } = await uploadTo(wsId, admin.token);
    const mint = (await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`)).json() as { url: string };

    // Both work before revoke.
    expect((await app.inject({ method: 'GET', url: inlineUrl })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: mint.url })).statusCode).toBe(200);

    const revoke = await inject('POST', `/workspaces/${wsId}/files/${id}/revoke`);
    expect(revoke.statusCode, revoke.body).toBe(201);
    expect(revoke.json()).toEqual({ revoked: true });

    // The SAME URLs, byte-for-byte, now fail.
    const inlineAfter = await app.inject({ method: 'GET', url: inlineUrl });
    expect(inlineAfter.statusCode).toBe(403);
    const downloadAfter = await app.inject({ method: 'GET', url: mint.url });
    expect(downloadAfter.statusCode).toBe(403);
  });

  it('is admin-only', async () => {
    const member = await signUpUser(app, 'FileMember');
    const inviteRes = await inject('POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
    const token = new URL(inviteRes.json().accept_url).searchParams.get('token')!;
    await app.inject({ method: 'POST', url: '/api/v1/invites/accept', headers: authed(member.token), payload: { token } });

    const { id } = await uploadTo(wsId, admin.token);
    const res = await inject('POST', `/workspaces/${wsId}/files/${id}/revoke`, undefined, member.token);
    expect(res.statusCode).toBe(403);
  });
});

describe('tenant isolation (#201)', () => {
  it('a file from workspace A cannot be minted or revoked via workspace B, even by B\'s admin', async () => {
    const otherAdmin = await signUpUser(app, 'OtherWsAdmin');
    const wsB = (await inject('POST', '/workspaces', { name: 'Files WS B' }, otherAdmin.token)).json().id;
    const { id } = await uploadTo(wsId, admin.token); // belongs to wsId (workspace A)

    const mintViaB = await inject('POST', `/workspaces/${wsB}/files/${id}/download-url`, undefined, otherAdmin.token);
    expect(mintViaB.statusCode).toBe(404);

    const revokeViaB = await inject('POST', `/workspaces/${wsB}/files/${id}/revoke`, undefined, otherAdmin.token);
    expect(revokeViaB.statusCode).toBe(404);

    // And the file must still be perfectly usable via its real workspace.
    const mintViaA = await inject('POST', `/workspaces/${wsId}/files/${id}/download-url`);
    expect(mintViaA.statusCode).toBe(201);
  });
});

describe('private-attachments mode (#201)', () => {
  it('off by default: the inline path stays public', async () => {
    const { id } = await uploadTo(wsId, admin.token);
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${id}` })).statusCode).toBe(200);
  });

  it('when on: unauthenticated/no-access is rejected, a viewer+ member succeeds; OFF is unchanged', async () => {
    const privateWs = (await inject('POST', '/workspaces', { name: 'Private Files WS' })).json().id;
    const { id } = await uploadTo(privateWs, admin.token);

    // Sanity: still public before the flag flips.
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/${id}` })).statusCode).toBe(200);

    const patch = await inject('PATCH', `/workspaces/${privateWs}`, { private_attachments: true });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().settings.private_attachments).toBe(true);

    // Unauthenticated: rejected.
    const anon = await app.inject({ method: 'GET', url: `/api/v1/files/${id}` });
    expect(anon.statusCode).toBe(401);

    // Authenticated but not a member of this workspace: rejected, no-leak (404).
    const outsider = await signUpUser(app, 'PrivateOutsider');
    const outsiderRes = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${id}`,
      headers: authed(outsider.token),
    });
    expect(outsiderRes.statusCode).toBe(404);

    // A viewer+ member (here, a guest with a grant — the least-privileged
    // membership that still counts as "an active member") succeeds.
    const spaceId = (await inject('GET', `/workspaces/${privateWs}/spaces`)).json()[0].id;
    const guest = await signUpUser(app, 'PrivateGuestViewer');
    const invite = await inject('POST', `/workspaces/${privateWs}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: spaceId, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({ method: 'POST', url: '/api/v1/invites/accept', headers: authed(guest.token), payload: { token } });

    const guestRes = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${id}`,
      headers: authed(guest.token),
    });
    expect(guestRes.statusCode).toBe(200);
    expect(guestRes.headers['cache-control']).toBe('private, no-store');
  });
});

describe('inline embeds are unaffected (#201)', () => {
  it('the editor upload → embed round trip still returns a working url', async () => {
    const { id, url } = await uploadTo(wsId, admin.token);
    expect(url).toBe(`/api/v1/files/${id}`);
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });
});
