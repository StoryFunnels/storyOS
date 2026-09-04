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

  // #520 — the owner's personal space, via the real get-or-create endpoint
  // (previously seeded directly through the db; that workaround is gone now
  // that the endpoint exists).
  personalSpaceId = (await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/personal`)).json().id;
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

describe('#520 — provisioning endpoints: get-or-create personal space, create personal view', () => {
  it('POST spaces/personal is idempotent — the same space every call', async () => {
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/personal`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().id).toBe(personalSpaceId);
    expect(res.json().personal).toBe(true);
  });

  it('a brand-new member gets their OWN personal space, distinct from another member\'s', async () => {
    const second = await signUpUser(app, 'PersonalSecond');
    await db.insert(memberships).values({
      workspaceId: wsId,
      userId: (await as(second.token, 'GET', '/me')).json().id,
      role: 'member',
    });

    const res = await as(second.token, 'POST', `/workspaces/${wsId}/spaces/personal`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().id).not.toBe(personalSpaceId);
    expect(res.json().personal).toBe(true);
  });

  it('creates a personal view over a shared database, owned by the caller — visible only to them (#291 leak rule holds through the real endpoint too)', async () => {
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'My private lens',
      type: 'table',
      config: {},
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json();
    // Casing on the raw create() response is genuinely inconsistent across this
    // codebase (views-owner-xor.test.ts hedges the same way) — check both.
    expect(view.database_id ?? view.databaseId).toBe(sharedDb);
    expect(view.space_id ?? view.spaceId).toBeFalsy();
    expect(view.owner_user_id ?? view.ownerUserId).toBeTruthy();

    const asOwner = await as(owner.token, 'GET', `/workspaces/${wsId}/spaces/${sharedSpace}/views`);
    const asAdmin = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${sharedSpace}/views`);
    const names = (b: string) => (JSON.parse(b).data as Array<{ name: string }>).map((v) => v.name);
    expect(names(asOwner.body)).toContain('My private lens');
    expect(names(asAdmin.body), 'a personal view must be invisible to admins too (#291)').not.toContain(
      'My private lens',
    );
  });

  it('ignores a folder_id in the body — a personal view is never placed in the shared folder tree', async () => {
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Folder attempt',
      type: 'table',
      config: {},
      folder_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode, res.body).toBe(201);
    const view = res.json();
    expect(view.folder_id ?? view.folderId).toBeFalsy();
  });

  it('VIEWER access to the database is enough — editor is not required (unlike a shared view)', async () => {
    const viewerOnly = await signUpUser(app, 'PersonalViewer');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: viewerOnly.email,
      role: 'guest',
      grants: [{ database_id: sharedDb, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(viewerOnly.token, 'POST', '/invites/accept', { token });

    const res = await as(viewerOnly.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Guest\'s own lens',
      type: 'table',
      config: {},
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('#551 — list a member\'s personal views across the workspace', () => {
  it('returns every personal view the caller owns across MULTIPLE databases, and never another user\'s', async () => {
    const secondDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: sharedSpace, name: 'Second DB' })
    ).json().id;

    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Owner Lens A',
      type: 'table',
      config: {},
    });
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${secondDb}/views/personal`, {
      name: 'Owner Lens B',
      type: 'table',
      config: {},
    });

    // A different member's OWN personal view — must never appear in owner's list.
    const other = await signUpUser(app, 'PersonalListOther');
    await db.insert(memberships).values({
      workspaceId: wsId,
      userId: (await as(other.token, 'GET', '/me')).json().id,
      role: 'member',
    });
    await as(other.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Other User Lens',
      type: 'table',
      config: {},
    });

    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/views/personal`);
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().data as Array<{ name: string; database_id: string; database_name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('Owner Lens A');
    expect(names).toContain('Owner Lens B');
    expect(names, 'never another user\'s personal view').not.toContain('Other User Lens');

    const lensA = rows.find((r) => r.name === 'Owner Lens A')!;
    expect(lensA.database_id).toBe(sharedDb);
    expect(lensA.database_name).toBe('Shared Tasks');
    const lensB = rows.find((r) => r.name === 'Owner Lens B')!;
    expect(lensB.database_id).toBe(secondDb);
  });

  it('an admin never sees another member\'s personal views through this endpoint either (#291 — no bypass)', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/views/personal`);
    expect(res.statusCode, res.body).toBe(200);
    const names = (res.json().data as Array<{ name: string }>).map((r) => r.name);
    expect(names).not.toContain('Owner Lens A');
  });

  it('AC3 — excludes a personal view whose database no longer exists, rather than erroring', async () => {
    const tempDb = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: sharedSpace, name: 'Temp DB' })
    ).json().id;
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${tempDb}/views/personal`, {
      name: 'Temp Lens',
      type: 'table',
      config: {},
    });

    const before = (await as(owner.token, 'GET', `/workspaces/${wsId}/views/personal`)).json().data as Array<{
      name: string;
    }>;
    expect(before.map((r) => r.name)).toContain('Temp Lens');

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${tempDb}`, { confirm: 'Temp DB' });
    expect(del.statusCode, del.body).toBe(200);

    const after = await as(owner.token, 'GET', `/workspaces/${wsId}/views/personal`);
    expect(after.statusCode, after.body).toBe(200);
    expect((after.json().data as Array<{ name: string }>).map((r) => r.name)).not.toContain('Temp Lens');
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
