import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * #347 — GET /workspaces/:ws/spaces/:space/views, the sidebar's one call per space.
 *
 * The access rule this pins (ADR §6, docs/architecture/views-and-the-sidebar.md):
 * the SPACE is the door, each source DATABASE is the room. The trap it exists to
 * catch is the tempting shortcut — gate on the space alone and stop there.
 *
 * That shortcut leaks in exactly one configuration, and it is the one built below:
 * a guest granted ONE DATABASE still sees the parent space in their sidebar,
 * because `visibleSpaceIds` adds the parent space of every database-scoped grant.
 * Gate only on the space and that guest is handed every other table's views.
 *
 * It has to be a GUEST. `effectiveForDatabase` returns admin for admins and
 * creator for members WITHOUT consulting grants at all (ADR-0009), so the same
 * test written with a member fixture passes whether the rule is implemented or
 * not — it would be theatre.
 */
let app: NestFastifyApplication;
let db: ReturnType<typeof connectTestDb>;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let space: string;
let otherSpace: string;
let tasksDb: string;
let secretsDb: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

const makeView = (db: string, name: string) =>
  as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/views`, { name, type: 'table' });

beforeAll(async () => {
  app = await createTestApp();
  db = connectTestDb();
  admin = await signUpUser(app, 'Owner');
  guest = await signUpUser(app, 'Guest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'SpaceViews WS' })).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  otherSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Elsewhere' })).json().id;

  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  secretsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Secrets' })).json().id;
  const elsewhereDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: otherSpace, name: 'Elsewhere DB' })).json().id;

  await makeView(tasksDb, 'Tasks board');
  await makeView(secretsDb, 'Secret list');
  await makeView(elsewhereDb, 'Not in this space');

  // The leaky configuration: a guest granted ONE DATABASE, not the space.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ database_id: tasksDb, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  void guestId;
});

afterAll(async () => {
  await db.pool.end();
  await app.close();
});

const names = (body: string) =>
  (JSON.parse(body).data as { name: string }[]).map((v) => v.name).sort();

describe('GET /spaces/:space/views (#347)', () => {
  it('returns every view in the space for an admin, and nothing from another space', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    expect(res.statusCode, res.body).toBe(200);
    // The default view each database is created with rides along; assert on the
    // ones this test named rather than an exact count, so a change to seeding
    // does not fail an unrelated rule.
    const found = names(res.body);
    expect(found).toContain('Tasks board');
    expect(found).toContain('Secret list');
    expect(found).not.toContain('Not in this space');
  });

  it('carries the placement columns the sidebar needs', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const view = (JSON.parse(res.body).data as Record<string, unknown>[]).find(
      (v) => v.name === 'Tasks board',
    )!;
    expect(view.database_id).toBe(tasksDb);
    expect(view.space_id).toBeNull(); // database-owned: space is resolved by joining
    expect(view.folder_id).toBeNull(); // nested under its database by default
    expect(view.personal).toBe(false);
    expect(view.type).toBe('table');
  });

  it('a GUEST granted ONE database sees only that database\'s views', async () => {
    // The whole point. Space-access-alone would return 'Secret list' here.
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    expect(res.statusCode, res.body).toBe(200);
    const found = names(res.body);
    expect(found).toContain('Tasks board');
    expect(found, 'a database-scoped grant must not leak another database\'s views').not.toContain(
      'Secret list',
    );
  });

  it('a space the guest has no grant anywhere within is 404, not an empty list', async () => {
    // 404 rather than [] so the endpoint never confirms a space exists to someone
    // who cannot see it — the same choice assertSpace makes everywhere else.
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/spaces/${otherSpace}/views`);
    expect(res.statusCode).toBe(404);
  });

  it('a PERSONAL view is invisible to everyone but its owner, admins included (#291)', async () => {
    // Written through the raw pool ON PURPOSE. `views.ownerUserId` is not set by
    // any endpoint yet — #291 added the column and `notOthersPersonalView`, but
    // CREATING a personal view is still open as #292. Going through the API here
    // would produce an ordinary shared view and the assertion below would pass
    // while proving nothing.
    const other = await signUpUser(app, 'Other');
    const otherId = (await as(other.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: other.email,
      role: 'member',
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(other.token, 'POST', '/invites/accept', { token });

    await db.pool.query(
      `INSERT INTO views (database_id, name, type, owner_user_id) VALUES ($1, 'My private lens', 'table', $2)`,
      [tasksDb, otherId],
    );

    const asOwner = await as(other.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const asAdmin = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);

    expect(names(asOwner.body), 'the owner must see their own personal view').toContain(
      'My private lens',
    );
    expect(
      names(asAdmin.body),
      'a personal view must be invisible to admins too (#291) — no admin bypass',
    ).not.toContain('My private lens');
  });

  it('reports a personal view as personal, without saying whose it is', async () => {
    const other = (await db.pool.query(`SELECT owner_user_id FROM views WHERE name = 'My private lens'`))
      .rows[0].owner_user_id as string;
    expect(other).toBeTruthy(); // the fixture above really did write an owner

    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const payload = res.body;
    expect(payload, 'the owner id must never reach the sidebar payload').not.toContain(other);
  });

  it('creates a DASHBOARD that lives in the space and owns no database (#306)', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${space}/views`, {
      name: 'Morning numbers',
      type: 'dashboard',
    });
    expect(res.statusCode, res.body).toBe(201);

    // The XOR from the other side: space set, database null. Read from postgres,
    // not the response, because the response is the thing under test.
    const { rows } = await db.pool.query(
      `SELECT database_id, space_id, type FROM views WHERE id = $1`,
      [res.json().id],
    );
    expect(rows[0].database_id).toBeNull();
    expect(rows[0].space_id).toBe(space);
    expect(rows[0].type).toBe('dashboard');
  });

  it('REFUSES a space-level table, and says why (#306)', async () => {
    // Every other view type renders rows OF something. A table with no database
    // is a view of nothing — accepting one creates a row no surface can draw.
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${space}/views`, {
      name: 'Rows of what',
      type: 'table',
    });
    expect(res.statusCode).toBe(422);
    expect(res.body, 'the error must explain the rule, not just reject').toMatch(/needs one|dashboard/i);
  });

  it('the space-level dashboard appears in the space listing (#306)', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const found = (JSON.parse(res.body).data as Record<string, unknown>[]).find(
      (v) => v.name === 'Morning numbers',
    )!;
    expect(found, 'a space-owned view must list alongside database-owned ones').toBeTruthy();
    expect(found.database_id).toBeNull();
    expect(found.space_id).toBe(space);
  });

  it('resolves a database-less view through the view-first route (#306)', async () => {
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${space}/views`, {
      name: 'Routed dashboard',
      type: 'dashboard',
    });
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/views/${created.json().id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().database_id).toBeNull();
    expect(res.json().name).toBe('Routed dashboard');
  });

  it('the same route ALSO resolves a database-owned view — one route, both kinds', async () => {
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const dbOwned = (JSON.parse(list.body).data as Record<string, unknown>[]).find(
      (v) => v.name === 'Tasks board',
    )!;
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/views/${dbOwned.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().database_id).toBe(tasksDb);
  });

  it('a GUEST cannot read a space-level dashboard through the view-first route', async () => {
    // The view-first route is a NEW way in. It must apply the same door, or it
    // becomes the bypass — a guest granted one database is not a space member.
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${otherSpace}/views`, {
      name: 'Elsewhere dashboard',
      type: 'dashboard',
    });
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/views/${created.json().id}`);
    expect(res.statusCode, 'the view-first route must not bypass the space door').toBe(404);
  });
});