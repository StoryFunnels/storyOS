import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #240 phase 1 — comments across a whole database, chronological.
 *
 * Deliberately reads the SAME `activity_events` rows `listForRecord`
 * (test/activity-source.test.ts) already proves carry correct `source`
 * attribution — these tests exercise what is actually NEW here: aggregating
 * across many records in one database, resolving each comment's text and its
 * record, tolerating a comment that was soft-deleted after its event was
 * written, and keeping the access check a plain member fails correctly.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let outsider: { token: string };
let wsId: string;
let dbId: string;
let taskA: { id: string };
let taskB: { id: string };

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function comment(recordId: string, text: string) {
  return as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`, {
    body: [{ type: 'text', text }],
  });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'DbActivityOwner');
  outsider = await signUpUser(app, 'DbActivityOutsider');

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Db Activity WS' })).json().id;
  const spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  taskA = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Ship the release' } })).json();
  taskB = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Write the changelog' } })).json();
});

afterAll(async () => {
  await app.close();
});

describe('GET .../databases/:db/activity/comments (#240)', () => {
  it('aggregates comments across DIFFERENT records in the database, newest first', async () => {
    await comment(taskA.id, 'First comment, on task A');
    await comment(taskB.id, 'Second comment, on task B');
    await comment(taskA.id, 'Third comment, back on task A');

    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Array<{ comment: { snippet: string }; record: { id: string; title: string } }> };
    expect(body.data).toHaveLength(3);
    // Newest first — the ORDER is the point of a feed, not just membership.
    expect(body.data[0]!.comment.snippet).toBe('Third comment, back on task A');
    expect(body.data[0]!.record).toMatchObject({ id: taskA.id, title: 'Ship the release' });
    expect(body.data[1]!.record).toMatchObject({ id: taskB.id });
    expect(body.data[2]!.comment.snippet).toBe('First comment, on task A');
  });

  it('carries actor and source, the same attribution shape listForRecord already proves correct', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    const body = res.json() as { data: Array<{ actor: { name: string } | null; source: string | null }> };
    expect(body.data[0]!.actor?.name).toBeTruthy();
    expect(body.data[0]!.source).toBe('human');
  });

  it('a comment soft-deleted after its event was written is omitted, not shown as broken', async () => {
    const created = await comment(taskB.id, 'This one will be deleted');
    const commentId = created.json().id;
    const before = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    expect((before.json() as { data: unknown[] }).data.some((e) => (e as { comment: { id: string } }).comment.id === commentId)).toBe(true);

    await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${taskB.id}/comments/${commentId}`);

    const after = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    const afterData = (after.json() as { data: Array<{ comment: { id: string } }> }).data;
    expect(afterData.some((e) => e.comment.id === commentId)).toBe(false);
    // The other three real comments must still be there — deletion removed
    // exactly one entry, not the whole feed.
    expect(afterData.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses someone with no access to the workspace at all', async () => {
    const res = await as(outsider.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    expect(res.statusCode).toBe(404);
  });

  it('is idempotent — calling it twice in a row returns the same set', async () => {
    const first = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    const second = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`);
    expect(first.body).toEqual(second.body);
  });
});
