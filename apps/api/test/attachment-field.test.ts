import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #391 — files as a COLUMN, not just the record-level bag.
 *
 * The gap: a record held one undifferentiated pile of files, so "which one is
 * the cover?" had no answer, a gallery had nothing to render, and "posts with no
 * cover image" was not expressible. The workaround was a URL field pointing at
 * someone else's bucket, where a dead link and an empty field look identical.
 *
 * Two properties here would rot silently if untested: the record BAG must keep
 * behaving exactly as it did, and a record PATCH must never be able to claim a
 * file it was not given.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let spaceId: string;
let dbId: string;
let coverId: string;

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

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

const upload = (rec: string, filename: string, fieldId?: string, db = dbId, token = admin.token) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${db}/records/${rec}/attachments${fieldId ? `?field=${fieldId}` : ''}`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(filename, 'image/png', PNG),
  });

const newRecord = async (name: string, db = dbId) =>
  (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, { values: { name } })).json() as {
    id: string;
  };

const valuesOf = async (rec: string, db = dbId) =>
  (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db}/records/${rec}`)).json().values as Record<
    string,
    unknown
  >;

const names = (v: unknown) => (v as Array<{ filename: string }>).map((f) => f.filename);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Media Admin');
  guest = await signUpUser(app, 'Media Guest');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Media Co' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Posts' })).json().id;
  coverId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Cover',
      type: 'attachment',
    })
  ).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('attachment fields (#391)', () => {
  it('creates the field type that did not exist', async () => {
    const db = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    expect(db.fields.find((f: { id: string }) => f.id === coverId).type).toBe('attachment');
  });

  it('projects a field file as a renderable chip, not a uuid', async () => {
    const rec = await newRecord('Launch post');
    const res = await upload(rec.id, 'cover.png', coverId);
    expect(res.statusCode, res.body).toBe(201);

    const files = (await valuesOf(rec.id))['cover'] as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    // A card cannot draw a thumbnail from an id. The projection has to carry
    // enough to render, and `has_thumbnail` has to be answerable BEFORE the
    // client requests an image that may not exist.
    expect(files[0]).toMatchObject({ filename: 'cover.png', mime: 'image/png', has_thumbnail: true });
    expect(files[0]!.size).toBeGreaterThan(0);
  });

  it("keeps two kinds of file apart — the ticket's opening complaint", async () => {
    const videoId = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Video',
        type: 'attachment',
      })
    ).json().id;
    const rec = await newRecord('Two kinds');
    await upload(rec.id, 'the-cover.png', coverId);
    await upload(rec.id, 'the-video.png', videoId);

    const values = await valuesOf(rec.id);
    expect(names(values['cover'])).toEqual(['the-cover.png']);
    expect(names(values['video'])).toEqual(['the-video.png']);
  });

  it('preserves ORDER, because a gallery card shows the first file', async () => {
    const rec = await newRecord('Ordered');
    await upload(rec.id, 'first.png', coverId);
    await upload(rec.id, 'second.png', coverId);
    expect(names((await valuesOf(rec.id))['cover'])).toEqual(['first.png', 'second.png']);
  });

  it('lets a PATCH reorder, and refuses one that claims another record\'s file', async () => {
    const mine = await newRecord('Mine');
    const other = await newRecord('Someone else');
    const a = (await upload(mine.id, 'a.png', coverId)).json();
    const b = (await upload(mine.id, 'b.png', coverId)).json();
    const theirs = (await upload(other.id, 'theirs.png', coverId)).json();

    const ok = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${mine.id}`, {
      values: { cover: [b.id, a.id] },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(names((await valuesOf(mine.id))['cover'])).toEqual(['b.png', 'a.png']);

    // Without this refusal `values` is a bag of uuids and "permissions follow
    // the record" is a comment rather than a rule.
    const stolen = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${mine.id}`, {
      values: { cover: [a.id, theirs.id] },
    });
    expect(stolen.statusCode).toBe(422);
    expect(JSON.stringify(stolen.json())).toContain('not on this record');
    // And the refusal must not have half-applied.
    expect(names((await valuesOf(mine.id))['cover'])).toEqual(['b.png', 'a.png']);
  });

  it('drops a deleted file out of the field value', async () => {
    const rec = await newRecord('Deletes');
    await upload(rec.id, 'keep.png', coverId);
    const drop = (await upload(rec.id, 'drop.png', coverId)).json();

    await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/attachments/${drop.id}`);
    // A value pointing at a file that no longer exists renders as a broken image
    // on every gallery card showing that record.
    expect(names((await valuesOf(rec.id))['cover'])).toEqual(['keep.png']);
  });

  it('leaves the record-level BAG exactly as it was', async () => {
    const rec = await newRecord('Bag');
    await upload(rec.id, 'loose.png'); // no field — the pre-#391 behaviour
    await upload(rec.id, 'in-cover.png', coverId);

    const bag = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/attachments`)).json();
    // Adding a Cover field must not silently double every record's file list.
    expect(bag.data.map((a: { filename: string }) => a.filename)).toEqual(['loose.png']);
  });

  it('refuses a target field that is not an attachment field', async () => {
    const notes = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Notes',
        type: 'text',
      })
    ).json();
    const rec = await newRecord('Wrong field');
    const res = await upload(rec.id, 'x.png', notes.id);
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('not an attachment field');
  });

  it('filters on presence — "posts with no cover image"', async () => {
    const withCover = await newRecord('Has cover');
    const without = await newRecord('No cover');
    await upload(withCover.id, 'c.png', coverId);

    const ids = async (op: string) =>
      (
        await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
          filter: { field: 'cover', op },
          limit: 200,
        })
      ).json().data.map((r: { id: string }) => r.id);

    expect(await ids('is_empty')).toContain(without.id);
    expect(await ids('is_empty')).not.toContain(withCover.id);
    expect(await ids('not_empty')).toContain(withCover.id);
  });

  it('refuses an op it cannot answer, rather than silently matching nothing', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: 'cover', op: 'eq', value: 'some-id' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.stringify(res.json())).toContain('is_empty');
  });

  it('PERMISSIONS FOLLOW THE RECORD — proven with a guest fixture', async () => {
    // Only guests can have partial access, so a test without one proves nothing
    // (CLAUDE.md). Two databases: granted, and not.
    const openRec = await newRecord('Granted');
    const openFile = (await upload(openRec.id, 'ok.png', coverId)).json();

    const secretDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Secret' })
    ).json();
    const secretField = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${secretDb.id}/fields`, {
        display_name: 'Cover',
        type: 'attachment',
      })
    ).json();
    const secretRec = await newRecord('Secret post', secretDb.id);
    const secretFile = (await upload(secretRec.id, 'secret.png', secretField.id, secretDb.id)).json();

    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ database_id: dbId, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    const accept = await as(guest.token, 'POST', '/invites/accept', { token });
    expect(accept.statusCode, accept.body).toBeLessThan(300);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/${openRec.id}/attachments/${openFile.id}/download`,
      headers: authed(guest.token),
    });
    expect(allowed.statusCode, allowed.body).toBe(200);

    // The file lives in a database the guest was never granted. A URL must not
    // be a way around that — this is the whole of "permissions follow the
    // record, not the file".
    const denied = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${secretDb.id}/records/${secretRec.id}/attachments/${secretFile.id}/download`,
      headers: authed(guest.token),
    });
    expect([403, 404]).toContain(denied.statusCode);
  });
});
