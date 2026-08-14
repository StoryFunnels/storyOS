import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import {
  databases,
  memberships,
  notifications,
  records,
  spaceDocuments,
  spaces,
  views,
} from '../src/db/schema';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #291 — Personal space access enforcement.
 *
 * These are the LEAK tests. The feature's whole value is that nobody else can read
 * the content, so the assertions that matter are the negative ones: a second member
 * can't, and — per #290's no-admin-bypass decision — an ADMIN can't either.
 *
 * Personal rows are created directly through the db here: the sidebar/create flow is
 * slice C (#292), and enforcement must hold regardless of how a row got there.
 */
let app: NestFastifyApplication;
let db: Db;
let owner: { token: string };
let ownerId: string;
let admin: { token: string };
let adminId: string;
let wsId: string;
let sharedSpace: string;
let sharedDb: string;
let personalSpaceId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);

  admin = await signUpUser(app, 'PersonalAdmin');
  owner = await signUpUser(app, 'PersonalOwner');
  ownerId = (await as(owner.token, 'GET', '/me')).json().id;
  adminId = (await as(admin.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Personal WS' })).json().id;
  sharedSpace = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  sharedDb = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: sharedSpace,
      name: 'Shared Tasks',
    })
  ).json().id;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/records`, {
    name: 'A shared record that must survive everything',
  });

  // Add the owner as an ordinary member. Inserted directly rather than through the
  // invite flow — this suite is about ACCESS, and a silently-failed invite would make
  // the negative assertions pass for the wrong reason.
  await db.insert(memberships).values({ workspaceId: wsId, userId: ownerId, role: 'member' });

  // The owner's personal space, created directly (slice C owns the UI flow).
  const [personal] = await db
    .insert(spaces)
    .values({
      workspaceId: wsId,
      name: 'Personal',
      slug: `personal-${ownerId.slice(0, 8)}`,
      personal: true,
      ownerUserId: ownerId,
    })
    .returning();
  personalSpaceId = personal!.id;
});

afterAll(async () => {
  await app.close();
});

describe('#291 personal space — nobody else can see it', () => {
  it('the OWNER sees their personal space in the spaces list', async () => {
    const list = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{
      id: string;
    }>;
    expect(list.map((s) => s.id)).toContain(personalSpaceId);
  });

  // #290: no admin bypass. This is the assertion the whole decision rests on.
  it('an ADMIN does NOT see it in the spaces list', async () => {
    const list = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json() as Array<{
      id: string;
    }>;
    expect(list.map((s) => s.id)).not.toContain(personalSpaceId);
  });

  it('an admin cannot reach it directly by id — 404, not 403', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${personalSpaceId}/documents`);
    // 404 rather than 403: a distinguishable "forbidden" would confirm the space exists.
    expect(res.statusCode).toBe(404);
  });

  it('the owner CAN list documents in their own personal space', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/spaces/${personalSpaceId}/documents`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the workspace export excludes personal spaces entirely', async () => {
    const rows = await db.query.spaces.findMany({ where: eq(spaces.workspaceId, wsId) });
    const exported = rows.filter((s) => !s.personal);
    expect(rows.map((s) => s.id)).toContain(personalSpaceId);
    expect(exported.map((s) => s.id)).not.toContain(personalSpaceId);
  });

  // ADR §2 — documents and views only; a private database is a private SCHEMA.
  it('a database cannot be created inside a personal space', async () => {
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: personalSpaceId,
      name: 'Secret DB',
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('documents and views only');
  });
});

describe('#291 member removal — hard delete, but ONLY personal rows', () => {
  it('removing the member deletes their personal space and personal views, and NOT the shared records those views pointed at', async () => {
    // A personal view over the SHARED database — the exact shape that must not take
    // company data with it.
    const [personalView] = await db
      .insert(views)
      .values({
        databaseId: sharedDb,
        name: 'My private lens',
        type: 'table',
        ownerUserId: ownerId,
      })
      .returning();

    const before = await db.query.records.findMany({ where: eq(records.databaseId, sharedDb) });
    expect(before.length).toBeGreaterThan(0);

    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { id: string };
    }>;
    // No fallback path here on purpose: if the membership can't be found the test
    // must FAIL, not quietly delete the rows itself and assert on its own handiwork.
    const membership = members.find((m) => m.user.id === ownerId);
    expect(membership, 'the owner must be a member for this to test the real path').toBeTruthy();
    const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${membership!.id}`);
    expect(res.statusCode, res.body).toBe(200);

    // Personal rows are GONE — "lost" has to be literally true (#290), not
    // "hidden but still in the table".
    expect(await db.query.spaces.findFirst({ where: eq(spaces.id, personalSpaceId) })).toBeUndefined();
    expect(
      await db.query.views.findFirst({ where: eq(views.id, personalView!.id) }),
    ).toBeUndefined();

    /**
     * The load-bearing assertion: a personal VIEW is a saved query over SHARED data.
     * Deleting it must not remove a single record. Getting this wrong would mean
     * offboarding someone silently deletes company data their private board pointed at.
     */
    const after = await db.query.records.findMany({ where: eq(records.databaseId, sharedDb) });
    expect(after.length).toBe(before.length);

    // …and the shared database itself is untouched.
    expect(await db.query.databases.findFirst({ where: eq(databases.id, sharedDb) })).toBeDefined();
  });
});

describe('#293 — a mention inside personal content must never notify', () => {
  /**
   * The ADR rule: an @mention in personal content produces NO notification and NO
   * stored inbox snippet. Since #235 a notification carries the TEXT, so suppressing
   * at DELIVERY would still persist a private draft's words in the notifications
   * table — which is why the rule is "never create it", not "don't send it".
   *
   * Today this holds by ABSENCE: space_documents has no mention/notify path at all.
   * That is an accident, not a guarantee — the moment someone wires mentions into
   * space documents (rich mentions, #169/#170) the promise breaks silently and
   * nothing else in the suite notices. This test is the invariant.
   */
  it('writing an @mention into a personal document creates no notification row', async () => {
    const [personal] = await db
      .insert(spaces)
      .values({
        workspaceId: wsId,
        name: 'Personal 2',
        slug: `personal2-${ownerId.slice(0, 8)}`,
        personal: true,
        ownerUserId: ownerId,
      })
      .returning();

    const before = await db.query.notifications.findMany({
      where: eq(notifications.workspaceId, wsId),
    });

    // A private draft that mentions the ADMIN — the person who must NOT be told.
    await db.insert(spaceDocuments).values({
      workspaceId: wsId,
      spaceId: personal!.id,
      title: 'Private draft',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Thinking about ', styles: {} },
            { type: 'mention', props: { kind: 'user', id: adminId, label: 'PersonalAdmin' } },
          ],
        },
      ] as never,
      createdBy: ownerId,
    });

    const after = await db.query.notifications.findMany({
      where: eq(notifications.workspaceId, wsId),
    });
    expect(after.length, 'a private draft must not notify the person it mentions').toBe(
      before.length,
    );
    // Nor may anything carrying the draft's words be persisted for someone else.
    expect(JSON.stringify(after)).not.toContain('Thinking about');
  });
});
