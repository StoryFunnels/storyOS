import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let recId: string;

const BOUNDARY = 'X-STORYOS-TEST-BOUNDARY';

function multipartBody(filename: string, mime: string, data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

/** Tiny valid 1x1 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const base = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records/${recId}/attachments`;

async function upload(filename: string, mime: string, data: Buffer, token = admin.token) {
  return app.inject({
    method: 'POST',
    url: base(),
    headers: {
      ...authed(token),
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipartBody(filename, mime, data),
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Uploader');
  const inject = (m: string, u: string, p?: unknown) =>
    app.inject({ method: m as never, url: `/api/v1${u}`, headers: authed(admin.token), payload: p as never });
  wsId = (await inject('POST', '/workspaces', { name: 'Files WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Briefs' })).json().id;
  recId = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Brief' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('attachments (MN-029)', () => {
  let textAttId: string;
  let imageAttId: string;

  it('uploads a file and lists it', async () => {
    const res = await upload('notes.txt', 'text/plain', Buffer.from('hello attachments'));
    expect(res.statusCode, res.body).toBe(201);
    textAttId = res.json().id;
    expect(res.json().has_thumbnail).toBe(false);

    const list = await app.inject({ method: 'GET', url: base(), headers: authed(admin.token) });
    expect(list.json().data[0]).toMatchObject({ filename: 'notes.txt', size: 17 });
  });

  it('downloads the exact bytes back', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${base()}/${textAttId}/download`,
      headers: authed(admin.token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('hello attachments');
    expect(res.headers['content-disposition']).toContain('notes.txt');
  });

  it('generates a thumbnail for images', async () => {
    const res = await upload('pixel.png', 'image/png', PNG);
    expect(res.statusCode, res.body).toBe(201);
    imageAttId = res.json().id;
    expect(res.json().has_thumbnail).toBe(true);

    const thumb = await app.inject({
      method: 'GET',
      url: `${base()}/${imageAttId}/thumbnail`,
      headers: authed(admin.token),
    });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/jpeg');
  });

  it('rejects files over the configured cap with 422', async () => {
    const big = Buffer.alloc(1024 * 1024 + 100, 1); // test cap is 1MB
    const res = await upload('big.bin', 'application/octet-stream', big);
    expect(res.statusCode).toBe(422);
  });

  it('guests can download but not upload or delete', async () => {
    const guest = await signUpUser(app, 'FileGuest');
    const inject = (m: string, u: string, p?: unknown) =>
      app.inject({ method: m as never, url: `/api/v1${u}`, headers: authed(admin.token), payload: p as never });
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: spaceId, role: 'commenter' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({ method: 'POST', url: '/api/v1/invites/accept', headers: authed(guest.token), payload: { token } });

    const download = await app.inject({
      method: 'GET',
      url: `${base()}/${textAttId}/download`,
      headers: authed(guest.token),
    });
    expect(download.statusCode).toBe(200);

    const uploadRes = await upload('nope.txt', 'text/plain', Buffer.from('x'), guest.token);
    expect(uploadRes.statusCode).toBe(403);

    const del = await app.inject({
      method: 'DELETE',
      url: `${base()}/${textAttId}`,
      headers: authed(guest.token),
    });
    expect(del.statusCode).toBe(403);
  });

  it('delete removes the row and the object', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `${base()}/${textAttId}`,
      headers: authed(admin.token),
    });
    expect(res.statusCode).toBe(200);

    const download = await app.inject({
      method: 'GET',
      url: `${base()}/${textAttId}/download`,
      headers: authed(admin.token),
    });
    expect(download.statusCode).toBe(404);
  });
});

/**
 * #473 AC2/AC3 — attachments are now RECORD-scoped, via the same
 * RecordsService.assertRecordAccess a record grant (#472) already reaches the
 * record's own field values through. Before this, AttachmentsController only
 * checked database/space access plus the record's existence — a record grant's
 * boundary stopped at the record's values and never reached its files.
 */
describe('attachments respect a RECORD-scoped grant, not just database access (#473)', () => {
  let app2: NestFastifyApplication;
  let owner: { token: string; email: string };
  let guest: { token: string; email: string };
  let guestId: string;
  let ws: string;
  let db: string;
  let recA: string;
  let recB: string;

  async function as(token: string, method: string, url: string, payload?: unknown) {
    return app2.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
  }

  beforeAll(async () => {
    app2 = await createTestApp();
    owner = await signUpUser(app2, '473Owner');
    guest = await signUpUser(app2, '473Guest');
    guestId = (await as(guest.token, 'GET', '/me')).json().id;

    ws = (await as(owner.token, 'POST', '/workspaces', { name: '473 Attachments WS' })).json().id;
    db = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, {
      space_id: (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id,
      name: 'Briefs 473',
    })).json().id;
    recA = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} })).json().id;
    recB = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} })).json().id;

    // Invite the guest with a record grant on recA ONLY — no space/database
    // access at all, matching #472's "zero broader grant" scenario exactly.
    const invite = await as(owner.token, 'POST', `/workspaces/${ws}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ record_id: recA, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(guest.token, 'POST', '/invites/accept', { token });

    await upload2(recA);
    await upload2(recB);
  });

  afterAll(async () => {
    await app2.close();
  });

  async function upload2(recordId: string) {
    return app2.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws}/databases/${db}/records/${recordId}/attachments`,
      headers: { ...authed(owner.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('f.txt', 'text/plain', Buffer.from('x')),
    });
  }

  it('the guest CAN list and download attachments on recA, the record they were actually granted', async () => {
    const list = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${db}/records/${recA}/attachments`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const attId = list.json().data[0].id;
    const download = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${db}/records/${recA}/attachments/${attId}/download`);
    expect(download.statusCode).toBe(200);
  });

  it('the SAME guest CANNOT list or download recB\'s attachments — the record grant does not leak to a sibling record', async () => {
    const list = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${db}/records/${recB}/attachments`);
    expect(list.statusCode).toBe(404);

    const ownerList = await as(owner.token, 'GET', `/workspaces/${ws}/databases/${db}/records/${recB}/attachments`);
    const attId = ownerList.json().data[0].id;
    const download = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${db}/records/${recB}/attachments/${attId}/download`);
    expect(download.statusCode).toBe(404);
  });

  it('upload/delete on recA still require editor rank, not just presence of a grant', async () => {
    const viewerGuest = await signUpUser(app2, '473ViewerGuest');
    const invite = await as(owner.token, 'POST', `/workspaces/${ws}/invites`, {
      email: viewerGuest.email,
      role: 'guest',
      grants: [{ record_id: recA, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(viewerGuest.token, 'POST', '/invites/accept', { token });

    const uploadRes = await app2.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${ws}/databases/${db}/records/${recA}/attachments`,
      headers: { ...authed(viewerGuest.token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody('nope.txt', 'text/plain', Buffer.from('x')),
    });
    expect(uploadRes.statusCode).toBe(403);
  });
});
