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

  it('a personal view does NOT ride along in the database introspection payload (#332)', async () => {
    /*
     * The sibling leak, found while building #332's `view` argument for
     * query_records.
     *
     * `DatabasesService.get` loaded views with `eq(views.databaseId, ...)` and
     * no owner predicate, so the introspection payload — what `describe_database`
     * is built from, and what the table view reads — returned every view on the
     * database regardless of owner. `notOthersPersonalView` existed for exactly
     * this and had a single caller.
     *
     * #332 then began returning each view's `filter`/`sorts` there, which would
     * have widened the exposure from a name to the whole saved query, and the
     * new `view` argument would have let anyone QUERY THROUGH someone else's
     * personal lens.
     *
     * Latent rather than live: no endpoint sets `views.ownerUserId` yet (#292),
     * which is exactly why this is the cheap moment — the alternative is #292
     * shipping a leak on day one through a path nobody re-checked.
     */
    const other = await signUpUser(app, 'Nosy');
    const otherId = (await as(other.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: other.email,
      role: 'member',
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(other.token, 'POST', '/invites/accept', { token });

    await db.pool.query(
      `INSERT INTO views (database_id, name, type, owner_user_id, config) VALUES ($1, 'Nosy private lens', 'table', $2, $3)`,
      [tasksDb, otherId, JSON.stringify({ filters: { field: 'title', op: 'contains', value: 'secret' } })],
    );

    const asOwner = await as(other.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}`);
    const asAdmin = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${tasksDb}`);

    const viewNames = (b: string) =>
      (JSON.parse(b).views as Array<{ name: string }>).map((v) => v.name);

    expect(viewNames(asOwner.body), 'the owner still sees their own').toContain('Nosy private lens');
    expect(
      viewNames(asAdmin.body),
      'an admin must not see another member\'s personal view here either (#291) — no admin bypass',
    ).not.toContain('Nosy private lens');
    // The saved filter is the part #332 would have exposed; assert on the whole
    // payload, not just the name, because that is what actually leaks.
    expect(asAdmin.body).not.toContain('secret');
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

  it('MOVES a database-level dashboard into its space, backfilling tile sources (#306)', async () => {
    // A tile with NO database_id is implicitly measuring the view's database.
    // Clear database_id without backfilling first and that fallback resolves to
    // nothing — every such tile silently becomes unconfigured. This is the whole
    // reason the move is its own endpoint rather than a PATCH.
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/views`, {
      name: 'Tasks metrics',
      type: 'dashboard',
      config: {
        dashboard_tiles: [
          { id: '10000000-0000-4000-8000-000000000001', label: 'All', op: 'count' },
          {
            id: '10000000-0000-4000-8000-000000000002',
            label: 'Elsewhere',
            op: 'count',
            database_id: secretsDb,
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/views/${created.json().id}/move-to-space`);
    expect(res.statusCode, res.body).toBeLessThan(300);

    const { rows } = await db.pool.query(`SELECT database_id, space_id, config FROM views WHERE id = $1`, [
      created.json().id,
    ]);
    expect(rows[0].database_id, 'the container moved').toBeNull();
    expect(rows[0].space_id).toBe(space);

    const tiles = rows[0].config.dashboard_tiles as Array<{ id: string; database_id?: string }>;
    // NO tile may be left sourceless — that is the failure this endpoint exists
    // to prevent, and asserting only on the move would not catch it.
    expect(tiles.every((t) => t.database_id)).toBe(true);
    // The implicit one was filled from the OLD owning database…
    expect(tiles.find((t) => t.id.endsWith('001'))!.database_id).toBe(tasksDb);
    // …and one that already pointed elsewhere was left exactly as it was.
    expect(tiles.find((t) => t.id.endsWith('002'))!.database_id).toBe(secretsDb);
  });

  it('the moved dashboard is reachable on the view-first route and still lists in the space', async () => {
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const moved = (JSON.parse(list.body).data as Record<string, unknown>[]).find(
      (v) => v.name === 'Tasks metrics',
    )!;
    expect(moved.database_id).toBeNull();
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/views/${moved.id}`);
    expect(res.statusCode).toBe(200);
  });

  /**
   * #367 — the acceptance criterion is that a widget whose source the VIEWER
   * cannot read shows an explicit no-access state, "never an empty chart, never
   * zeroes". The client half is a render branch on `records.isError`; THIS is the
   * half that makes that branch reachable — the query must FAIL for a forbidden
   * source rather than succeed with an empty page.
   *
   * That distinction is the whole point. If /records/query answered `{data: []}`
   * here, every chart over a forbidden database would render a truthful-looking
   * empty chart and every metric tile would read 0 — a permissions failure
   * reported as a fact about the data.
   *
   * Proven with a GUEST: only guests can hold partial access (ADR-0009), so an
   * admin or member fixture would prove nothing — they are resolved as admin
   * before grants are ever consulted.
   */
  it('a GUEST querying a widget source they cannot read is REFUSED, not handed zero rows (#367)', async () => {
    // Control: the one database this guest WAS granted answers normally.
    const allowed = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records/query`, {});
    expect(allowed.statusCode, allowed.body).toBeLessThan(300);

    // The database they were NOT granted must not answer at all.
    const denied = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${secretsDb}/records/query`, {});
    expect(denied.statusCode, 'a forbidden source must ERROR, not return an empty page').toBeGreaterThanOrEqual(400);
  });

  /**
   * #383 — a space-root dashboard used to be undeletable by ANY route. The only
   * view-delete is scoped `eq(views.databaseId, databaseId)`, and these have
   * `database_id = NULL`, so every database 404s — including the one it was
   * moved off. #306 made this shape routine, so "create a dashboard" was a
   * one-way door.
   */
  describe('deleting a space-level view (#383)', () => {
    const makeSpaceDashboard = async (name: string) => {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${space}/views`, {
        name,
        type: 'dashboard',
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };

    it('soft-deletes it (#453) and it stops listing in the space', async () => {
      const id = await makeSpaceDashboard('Delete me');
      const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/views/${id}`);
      expect(res.statusCode, res.body).toBeLessThan(300);

      // #453: views/databases/spaces are soft-deleted now — the row survives
      // with deleted_at set, it just stops appearing in reads.
      const { rows } = await db.pool.query(`SELECT deleted_at FROM views WHERE id = $1`, [id]);
      expect(rows, 'the row must still exist').toHaveLength(1);
      expect(rows[0].deleted_at, 'deleted_at must be set').not.toBeNull();

      const list = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
      const names = (JSON.parse(list.body).data as Array<{ name: string }>).map((v) => v.name);
      expect(names).not.toContain('Delete me');
    });

    /**
     * The per-database route enforces "a database must keep at least one view".
     * This endpoint must not become a second, laxer way to delete the same thing
     * — it refuses and points at the route that owns the rule.
     */
    it('REFUSES a database-owned view, so the keep-one rule cannot be bypassed', async () => {
      const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/views`, {
        name: 'Owned by a database',
        type: 'table',
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id;

      const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/views/${id}`);
      expect(res.statusCode).toBe(422);
      expect(res.body).toMatch(/database/i);

      const { rows } = await db.pool.query(`SELECT id FROM views WHERE id = $1`, [id]);
      expect(rows, 'a refusal must not half-apply').toHaveLength(1);
    });

    /**
     * Only guests can hold partial access (ADR-0009), so this is the only fixture
     * that proves the door. This guest was granted ONE DATABASE in the space, not
     * the space itself — they must not be able to delete the space's dashboard.
     */
    it('a GUEST without space access cannot delete a space view', async () => {
      const id = await makeSpaceDashboard('Guest must not delete this');
      const res = await as(guest.token, 'DELETE', `/workspaces/${wsId}/views/${id}`);
      expect(res.statusCode, 'a guest with only a database grant must be refused').toBeGreaterThanOrEqual(400);

      const { rows } = await db.pool.query(`SELECT id FROM views WHERE id = $1`, [id]);
      expect(rows, 'the dashboard survives a refused delete').toHaveLength(1);
    });
  });

  it('MOVES a dashboard that has widgets, backfilling widget sources too (#367)', async () => {
    // #306 REFUSED this with a 422: a widget had no `database_id` (#304 gave that
    // field to tiles only, deliberately, rather than accept-and-ignore it), so
    // clearing the view's database left every chart measuring nothing. #367 gave
    // widgets the field, so the refusal is gone and they backfill by the same
    // rule tiles do.
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/views`, {
      name: 'Has widgets',
      type: 'dashboard',
      config: {
        dashboard_widgets: [
          { id: '20000000-0000-4000-8000-000000000001', type: 'bar', title: 'By state', measure: { op: 'count' } },
          {
            id: '20000000-0000-4000-8000-000000000002',
            type: 'pie',
            title: 'Elsewhere',
            measure: { op: 'count' },
            database_id: secretsDb,
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/views/${created.json().id}/move-to-space`);
    expect(res.statusCode, res.body).toBeLessThan(300);

    const { rows } = await db.pool.query(`SELECT database_id, space_id, config FROM views WHERE id = $1`, [
      created.json().id,
    ]);
    expect(rows[0].database_id, 'the container moved').toBeNull();
    expect(rows[0].space_id).toBe(space);

    const widgets = rows[0].config.dashboard_widgets as Array<{ id: string; database_id?: string }>;
    // NO widget may be left sourceless — the exact condition #306's refusal was
    // protecting against. Asserting only on the move would not catch it.
    expect(widgets.every((w) => w.database_id)).toBe(true);
    // The implicit one was filled from the OLD owning database…
    expect(widgets.find((w) => w.id.endsWith('001'))!.database_id).toBe(tasksDb);
    // …and one already pointing elsewhere was left exactly as it was.
    expect(widgets.find((w) => w.id.endsWith('002'))!.database_id).toBe(secretsDb);
  });

  it('REFUSES to move a non-dashboard view (#306)', async () => {
    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/spaces/${space}/views`);
    const table = (JSON.parse(list.body).data as Record<string, unknown>[]).find(
      (v) => v.name === 'Tasks board',
    )!;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/views/${table.id}/move-to-space`);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/dashboard/i);
  });

  it('REFUSES to move a view that already lives in a space', async () => {
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/spaces/${space}/views`, {
      name: 'Already home',
      type: 'dashboard',
    });
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/views/${created.json().id}/move-to-space`);
    expect(res.statusCode).toBe(422);
  });
});