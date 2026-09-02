import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #238 — three real gaps an exhaustive audit of the guest mutation surface
 * found (posted on the ticket as the required enumeration): space-documents
 * had NO access check at all, file upload/download-url minting had none
 * either, and record-link/unlink never re-checked access on the relation's
 * OTHER database. None of these are "guest ladder wrong" — the ladder itself
 * (records/fields/views/comments/etc.) was already correct — these are three
 * surfaces that never consulted the ladder in the first place.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceAId: string;
let spaceBId: string;
let dbAId: string;
let dbBId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

let scratchSpaceId: string;

/**
 * Guest invites require at least one grant (createInviteSchema), so a truly
 * grant-LESS guest can't be invited directly — invite with a throwaway grant
 * on a scratch space nothing else uses, then revoke it via the grants API to
 * land on a genuine zero-grant guest.
 */
async function makeGuest(name: string, grants: Array<{ space_id?: string; database_id?: string; role: string }>) {
  const guest = await signUpUser(app, name);
  const effectiveGrants = grants.length ? grants : [{ space_id: scratchSpaceId, role: 'viewer' }];
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: effectiveGrants,
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });

  if (!grants.length) {
    const guestId = (await as(guest.token, 'GET', '/me')).json().id;
    const allGrants = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json().data as Array<{
      id: string;
      user_id: string;
    }>;
    const placeholder = allGrants.find((g) => g.user_id === guestId)!;
    const revoke = await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${placeholder.id}`);
    expect(revoke.statusCode, revoke.body).toBeLessThan(300);
  }
  return guest;
}

const BOUNDARY = 'X-238-BOUNDARY';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
async function upload(token: string, ws: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${ws}/files`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="p.png"\r\ncontent-type: image/png\r\n\r\n`),
      PNG,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
    ]),
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GuestSurfaceOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '238 WS' })).json().id;
  spaceAId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  spaceBId = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Space B' })).json().id;
  dbAId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceAId, name: 'DB A' })).json().id;
  dbBId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceBId, name: 'DB B' })).json().id;
  scratchSpaceId = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Scratch' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('files: a zero-grant guest cannot upload or mint download URLs (#238)', () => {
  it('upload is refused', async () => {
    const grantless = await makeGuest('GrantlessUploader', []);
    const res = await upload(grantless.token, wsId);
    expect(res.statusCode).toBe(403);
  });

  it('minting a download URL is refused', async () => {
    const grantless = await makeGuest('GrantlessMinter', []);
    const { id } = (await upload(admin.token, wsId)).json() as { id: string };
    const res = await as(grantless.token, 'POST', `/workspaces/${wsId}/files/${id}/download-url`);
    expect(res.statusCode).toBe(403);
  });

  it('MUST KEEP WORKING: a guest holding any grant can still upload', async () => {
    const grantedGuest = await makeGuest('GrantedUploader', [{ space_id: spaceAId, role: 'viewer' }]);
    const res = await upload(grantedGuest.token, wsId);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('MUST KEEP WORKING: an admin/member is entirely unaffected', async () => {
    const res = await upload(admin.token, wsId);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('space-documents: every route now goes through AccessService (#238)', () => {
  it('a guest with zero grants cannot list, create, read, update or delete a document in Space A', async () => {
    const grantless = await makeGuest('DocGrantless', []);
    expect((await as(grantless.token, 'GET', `/workspaces/${wsId}/spaces/${spaceAId}/documents`)).statusCode).toBe(404);
    const create = await as(grantless.token, 'POST', `/workspaces/${wsId}/spaces/${spaceAId}/documents`, { title: 'Sneaky' });
    expect(create.statusCode).toBe(404);

    // Even a document the ADMIN already created must be unreachable.
    const doc = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${spaceAId}/documents`, { title: 'Owner doc' })).json();
    expect((await as(grantless.token, 'GET', `/workspaces/${wsId}/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await as(grantless.token, 'PATCH', `/workspaces/${wsId}/documents/${doc.id}`, { title: 'hacked' })).statusCode).toBe(404);
    expect((await as(grantless.token, 'DELETE', `/workspaces/${wsId}/documents/${doc.id}`)).statusCode).toBe(404);
  });

  it('a viewer-grant guest can read but not write (403 — found, insufficient rank, not 404)', async () => {
    const viewer = await makeGuest('DocViewer', [{ space_id: spaceAId, role: 'viewer' }]);
    const doc = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${spaceAId}/documents`, { title: 'Readable' })).json();
    expect((await as(viewer.token, 'GET', `/workspaces/${wsId}/spaces/${spaceAId}/documents`)).statusCode).toBe(200);
    expect((await as(viewer.token, 'GET', `/workspaces/${wsId}/documents/${doc.id}`)).statusCode).toBe(200);
    expect((await as(viewer.token, 'PATCH', `/workspaces/${wsId}/documents/${doc.id}`, { title: 'nope' })).statusCode).toBe(403);
    expect((await as(viewer.token, 'POST', `/workspaces/${wsId}/spaces/${spaceAId}/documents`, {})).statusCode).toBe(403);
  });

  it('an editor-grant guest can create, update and delete', async () => {
    const editor = await makeGuest('DocEditor', [{ space_id: spaceAId, role: 'editor' }]);
    const created = await as(editor.token, 'POST', `/workspaces/${wsId}/spaces/${spaceAId}/documents`, { title: 'Mine' });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const docId = created.json().id;
    expect((await as(editor.token, 'PATCH', `/workspaces/${wsId}/documents/${docId}`, { title: 'Renamed' })).statusCode).toBeLessThan(300);
    expect((await as(editor.token, 'DELETE', `/workspaces/${wsId}/documents/${docId}`)).statusCode).toBeLessThan(300);
  });

  it('a grant on Space A does not reach a document in Space B', async () => {
    const editorOnA = await makeGuest('DocCrossSpace', [{ space_id: spaceAId, role: 'editor' }]);
    const bDoc = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${spaceBId}/documents`, { title: 'B doc' })).json();
    expect((await as(editorOnA.token, 'GET', `/workspaces/${wsId}/documents/${bDoc.id}`)).statusCode).toBe(404);
  });

  // #291 personal-space privacy on this same surface (admin cannot read another
  // member's personal-space document) is already covered end-to-end by
  // personal-space.test.ts — not duplicated here.
});

describe('relation link/unlink: the OTHER database is access-checked too (#238)', () => {
  let recA: string;
  let recB: string;
  let fieldAId: string;

  beforeAll(async () => {
    recA = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbAId}/records`, { values: {} })).json().id;
    recB = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbBId}/records`, { values: {} })).json().id;
    const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbAId,
      database_b_id: dbBId,
      cardinality: 'many_to_many',
    });
    expect(rel.statusCode, rel.body).toBeLessThan(300);
    fieldAId = rel.json().field_a.id;
  });

  it('a guest with editor on DB A but no grant on DB B cannot link A to a B record, and gets no B titles back', async () => {
    const guest = await makeGuest('LinkGuestA', [{ database_id: dbAId, role: 'editor' }]);
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbAId}/records/${recA}/links/${fieldAId}`, {
      record_ids: [recB],
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(JSON.stringify(res.json())).not.toContain(recB);
  });

  it('MUST KEEP WORKING: a guest granted editor on BOTH databases can link them', async () => {
    const guest = await makeGuest('LinkGuestBoth', [
      { database_id: dbAId, role: 'editor' },
      { database_id: dbBId, role: 'editor' },
    ]);
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbAId}/records/${recA}/links/${fieldAId}`, {
      record_ids: [recB],
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('MUST KEEP WORKING: admin linking across any two databases is unaffected', async () => {
    const rec2 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbAId}/records`, { values: {} })).json().id;
    const res = await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${dbAId}/records/${rec2}/links/${fieldAId}`, {
      record_ids: [recB],
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });
});
