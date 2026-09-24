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
    // #434 AC6 — a system note ("N comments copied from #X") rides along too;
    // asserted precisely in its own describe block below, filtered out here
    // so this test stays about the carried comments themselves.
    expect(bodies.filter((b) => !b?.includes('copied from')).sort()).toEqual(['first comment', 'second comment']);

    // The source record's own comments must be untouched — copy, not move.
    const original = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`);
    expect(original.json().data).toHaveLength(2);

    // #734 — copied comments carry the ORIGINAL comment's provenance, not
    // "posted by whoever duplicated the record" (same reasoning authorId
    // preservation already documents above this code).
    expect(comments.json().data.every((c: { source: string | null }) => c.source === 'human')).toBe(true);
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
    expect(bodies2.filter((b) => !b?.includes('copied from'))).toEqual(['kept']);
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

/**
 * #434 — the three items Vera's 2026-09-07 review left open after #599
 * narrowed and shipped the rest: AC6 (system note), AC7 (no notification
 * spray), AC3 (attachment access governed by the copy's own record, never
 * inherited from the source). Plus one real bug this investigation found
 * along the way, not previously named on the ticket: carried comments had
 * no explicit createdAt, so every one silently defaulted to now() — the
 * exact "restamped to now" AC4 already forbids, and (since list ordering
 * has no secondary tiebreak) a real risk to AC5's thread-order guarantee
 * too, not just the displayed date.
 */
describe('#434 — system note, notification suppression, and copy-scoped attachment access', () => {
  it('AC6: a system note on the copy states how many comments were carried and from which record', async () => {
    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Note Source' } })
    ).json();
    await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src.id}/comments`, {
      body: [{ type: 'text', text: 'one' }],
    });
    await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src.id}/comments`, {
      body: [{ type: 'text', text: 'two' }],
    });

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src.id}/duplicate`);
    const list = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dup.json().id}/comments`);
    const bodies = (list.json().data as Array<{ body: Array<{ text: string }> }>).map((c) => c.body[0]?.text);
    expect(bodies).toContain(`2 comments copied from #${src.number}`);

    // "At the top": comments.service.ts's own list order is newest-first, so
    // the note — inserted after the carried comments, with its own default
    // (current) timestamp — must sort before both carried ones.
    expect(bodies[0]).toBe(`2 comments copied from #${src.number}`);
  });

  it('no system note when there was nothing to carry — a copy of a record with zero comments stays silent', async () => {
    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'No Comments' } })
    ).json().id;
    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);
    const list = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dup.json().id}/comments`);
    expect(list.json().data).toEqual([]);
  });

  it('a copied comment keeps its ORIGINAL createdAt, not the moment it was duplicated', async () => {
    // The bug this investigation found: without this, every carried comment
    // silently got createdAt = now(), which both misreports "when was this
    // posted" (AC4) and — since two+ comments copied in the same request
    // land within milliseconds of each other with no secondary sort key —
    // can scramble their relative order on read (AC5).
    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Timestamp Source' } })
    ).json().id;
    const posted = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/comments`, {
      body: [{ type: 'text', text: 'old news' }],
    });
    const originalCreatedAt = posted.json().created_at;

    // Real, not synthetic: wait past comment-insert resolution so a bug that
    // silently restamps to now() is actually distinguishable from the
    // original in the assertion below, not accidentally close enough to pass.
    await new Promise((r) => setTimeout(r, 1100));

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);
    const list = await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dup.json().id}/comments`);
    const carried = (list.json().data as Array<{ body: Array<{ text: string }>; created_at: string }>).find(
      (c) => c.body[0]?.text === 'old news',
    )!;
    expect(carried.created_at).toBe(originalCreatedAt);
  });

  it('AC7: carrying a comment with a mention does NOT re-notify the mentioned person', async () => {
    const guest = await signUpUser(app, 'Dupe434Mentioned');
    const guestId = (await inject(guest.token, 'GET', '/me')).json().id;
    const invite = await inject(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: guest.email, role: 'member' });
    const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
    await inject(guest.token, 'POST', '/invites/accept', { token: inviteToken });

    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Mention Source' } })
    ).json().id;
    await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/comments`, {
      body: [{ type: 'text', text: 'ping ' }, { type: 'mention', user_id: guestId }],
    });
    const before = (await inject(guest.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json().count;
    expect(before).toBe(1); // the ORIGINAL mention notified them, as it should.

    await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);

    // The duplicate carries the same mention into a new comment row, but
    // must not queue a SECOND notification for it — the mention already
    // fired once, and copying is not new activity by the person it names.
    const after = (await inject(guest.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json().count;
    expect(after).toBe(1);
  });

  it("AC3: a guest's access to the COPY's attachments is governed by the copy's OWN record — never inherited from a grant on the source", async () => {
    // #434 is scoped under #430's cross-database "copy a record" epic, but
    // the shipped mechanism (#599) is `duplicate()`, same-database. Within
    // one database that still means something real: the copy is a
    // DIFFERENT record with a different id, so a record-scoped grant on the
    // source must not silently reach it.
    const guest = await signUpUser(app, 'Dupe434Guest');
    const guestId = (await inject(guest.token, 'GET', '/me')).json().id;

    const src = (
      await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Guarded Source' } })
    ).json().id;
    const srcUpload = await upload(admin.token, `/workspaces/${wsId}/databases/${dbId}/records/${src}/attachments`, 'secret.png', 'image/png', PNG);
    expect(srcUpload.statusCode, srcUpload.body).toBe(201);

    // Invited with a grant on the SOURCE record only — nothing database- or
    // space-wide, and nothing on the copy (which doesn't exist yet).
    const invite = await inject(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ record_id: src, role: 'viewer' }],
    });
    const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
    await inject(guest.token, 'POST', '/invites/accept', { token: inviteToken });

    // Confirm the premise: the guest genuinely can read the source and its file.
    const sourceRead = await inject(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${src}`);
    expect(sourceRead.statusCode, sourceRead.body).toBe(200);
    const sourceDownload = await inject(
      guest.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${src}/attachments/${srcUpload.json().id}/download`,
    );
    expect(sourceDownload.statusCode, sourceDownload.body).toBe(200);

    const dup = await inject(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${src}/duplicate`);
    const copyId = dup.json().id;
    const copyAttachments = (
      await inject(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/attachments`)
    ).json().data as Array<{ id: string }>;

    // No grant on the copy — the source grant must not reach it, for the
    // record OR its carried attachment.
    const copyReadDenied = await inject(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}`);
    expect(copyReadDenied.statusCode, copyReadDenied.body).toBe(404);
    const copyCommentsDenied = await inject(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/comments`);
    expect(copyCommentsDenied.statusCode, copyCommentsDenied.body).toBe(404);
    const copyDownloadDenied = await inject(
      guest.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/attachments/${copyAttachments[0]!.id}/download`,
    );
    expect(copyDownloadDenied.statusCode, copyDownloadDenied.body).toBe(404);

    // Grant the guest access to the COPY specifically, then confirm normal
    // per-record access now governs it independently — including its file.
    await inject(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, record_id: copyId, role: 'viewer' });
    const copyReadAllowed = await inject(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${copyId}`);
    expect(copyReadAllowed.statusCode, copyReadAllowed.body).toBe(200);
    const copyDownloadAllowed = await inject(
      guest.token,
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${copyId}/attachments/${copyAttachments[0]!.id}/download`,
    );
    expect(copyDownloadAllowed.statusCode, copyDownloadAllowed.body).toBe(200);
  });
});
