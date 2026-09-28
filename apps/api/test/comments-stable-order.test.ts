import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { comments } from '../src/db/schema';

/**
 * #771 — comments.service.ts's list() sorted only by createdAt, so two
 * comments sharing a millisecond had undefined order across requests.
 * This forces an exact createdAt collision (the same-millisecond scenario
 * the ticket describes: concurrent writes, bulk import, multi-agent
 * posting) and asserts the list returns a stable, repeatable order.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let recId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'CommentsOrderOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '771 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  recId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Rec' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#771 — comments list has a deterministic secondary sort key', () => {
  it('two comments sharing the same createdAt millisecond return in stable, repeatable order', async () => {
    const post = (text: string) =>
      as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`, {
        body: [{ type: 'text', text }],
      });

    const a = await post('comment A');
    const b = await post('comment B');
    const c = await post('comment C');
    expect(a.statusCode, a.body).toBe(201);
    expect(b.statusCode, b.body).toBe(201);
    expect(c.statusCode, c.body).toBe(201);

    // Force the same-millisecond collision the ticket describes — the write
    // path already sets createdAt correctly (#434); this reproduces what any
    // concurrent-write/bulk-import/multi-agent path can still cause.
    const collidedAt = new Date();
    await db.update(comments).set({ createdAt: collidedAt }).where(eq(comments.id, a.json().id));
    await db.update(comments).set({ createdAt: collidedAt }).where(eq(comments.id, b.json().id));
    await db.update(comments).set({ createdAt: collidedAt }).where(eq(comments.id, c.json().id));

    const first = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`);
    const second = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`);
    const third = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`);

    const idsOf = (res: typeof first) => res.json().data.map((row: { id: string }) => row.id);
    const firstOrder = idsOf(first);
    expect(idsOf(second)).toEqual(firstOrder);
    expect(idsOf(third)).toEqual(firstOrder);

    // The order matches sorting by id alone (the tiebreak), confirming it's
    // not accidental repeat-query stability from an unrelated cause (e.g. a
    // cached plan) — deleting/recreating one comment would still resolve to
    // the same rule.
    const expectedById = [a.json().id, b.json().id, c.json().id].sort().reverse();
    expect(firstOrder).toEqual(expectedById);
  });

  it("#434's own fix is unaffected: a freshly duplicated record's copied comments still carry the source record's createdAt, not now()", async () => {
    const src = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Source' },
    });
    const srcId = src.json().id;
    const posted = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${srcId}/comments`, {
      body: [{ type: 'text', text: 'original' }],
    });
    const originalCreatedAt = posted.json().created_at;

    const dup = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${srcId}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    const dupId = dup.json().id;

    // data[0] is the "N comments carried" system note #434 AC6 adds AFTER
    // the copy, stamped now() so it sorts to the top — the copied comment
    // itself is found by its body, not by position.
    const dupComments = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${dupId}/comments`);
    const copied = dupComments.json().data.find((row: { body: unknown }) =>
      JSON.stringify(row.body).includes('original'),
    );
    expect(copied.created_at).toBe(originalCreatedAt);
  });
});
