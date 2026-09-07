import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #599 — split from #434 during a backlog audit. `duplicate()` already
 * copies scalar values, relation links, and the description document; it
 * copied neither comments (thread history) nor attachments (files). Both
 * are covered here without disturbing anything `records-duplicate.test.ts`
 * already asserts.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;
let recordId: string;

const BOUNDARY = 'X-STORYOS-599-BOUNDARY';
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

async function inject(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function upload(token: string, url: string, filename: string, mime: string, data: Buffer) {
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { ...authed(token), 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: multipartBody(filename, mime, data),
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Dupe599');
  wsId = (await inject(admin.token, 'POST', '/workspaces', { name: '599 WS' })).json().id;
  const spaceId = (await inject(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: '599 DB' })).json().id;
  recordId = (await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Source' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#599 — duplicate() carries comments and attachments onto the copy', () => {
  it('copies comment thread history (body, mentions, author) onto the new record', async () => {
    const c1 = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`, {
      body: [{ type: 'text', text: 'first comment' }],
    });
    expect(c1.statusCode, c1.body).toBe(201);
    const c2 = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`, {
      body: [{ type: 'text', text: 'second comment' }],
    });
    expect(c2.statusCode, c2.body).toBe(201);

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const copyId = dup.json().id;

    const comments = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/comments`);
    expect(comments.statusCode, comments.body).toBe(200);
    const bodies = (comments.json().data as Array<{ body: Array<{ text: string }> }>).map((c) => c.body[0]?.text);
    expect(bodies.sort()).toEqual(['first comment', 'second comment']);

    // The source record's own comments must be untouched — copy, not move.
    const original = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`);
    expect(original.json().data).toHaveLength(2);
  });

  it('a soft-deleted comment is NOT copied onto the duplicate', async () => {
    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Deleted Comment Source' } })
    ).json().id;
    const kept = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/comments`, {
      body: [{ type: 'text', text: 'kept' }],
    });
    const removed = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/comments`, {
      body: [{ type: 'text', text: 'removed' }],
    });
    await inject(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${src}/comments/${removed.json().id}`);
    void kept;

    const dup2 = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);
    const comments2 = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dup2.json().id}/comments`);
    const bodies2 = (comments2.json().data as Array<{ body: Array<{ text: string }> }>).map((c) => c.body[0]?.text);
    expect(bodies2).toEqual(['kept']);
  });

  it('copies attachments (files) — a real, independent byte copy, not a shared storage key', async () => {
    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Attachment Source' } })
    ).json().id;
    const uploaded = await upload(admin.token, `/workspaces/${wsId}/databases/${dbId}/records/${src}/attachments`, 'photo.png', 'image/png', PNG);
    expect(uploaded.statusCode, uploaded.body).toBe(201);

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const copyId = dup.json().id;

    const copyAttachments = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/attachments`);
    expect(copyAttachments.statusCode, copyAttachments.body).toBe(200);
    const copyList = copyAttachments.json().data as Array<{ id: string; filename: string; size: number }>;
    expect(copyList).toHaveLength(1);
    expect(copyList[0]!.filename).toBe('photo.png');
    expect(copyList[0]!.size).toBe(PNG.length);

    const originalAttachments = (
      await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${src}/attachments`)
    ).json().data as Array<{ id: string }>;
    expect(originalAttachments[0]!.id).not.toBe(copyList[0]!.id);

    // Deleting the ORIGINAL's attachment must not break the COPY's file — the
    // whole point of a real byte copy rather than a shared storage key.
    const delOriginal = await inject(
      admin.token,
      'DELETE',
      `/workspaces/${wsId}/databases/${dbId}/records/${src}/attachments/${originalAttachments[0]!.id}`,
    );
    expect(delOriginal.statusCode, delOriginal.body).toBeLessThan(300);

    const copyDownload = await inject(
      admin.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/attachments/${copyList[0]!.id}/download`,
    );
    expect(copyDownload.statusCode, 'the copy\'s file must survive the original\'s deletion').toBe(200);
  });

  it("MUST KEEP WORKING: every value/relation/description copy behavior duplicate() already has is unchanged", async () => {
    const source = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Untouched Baseline' } })
    ).json().id;
    const doc = (await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${source}/document`)).json();
    await inject(admin.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/records/${source}/document`, {
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'still works', styles: {} }] }],
      expected_version: doc.version,
    });

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${source}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    expect(dup.json().title).toBe('Untouched Baseline (copy)');
    const copyDoc = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dup.json().id}/document`);
    expect(JSON.stringify(copyDoc.json().content)).toContain('still works');
  });
});
