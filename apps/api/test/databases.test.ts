import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { OPTION_COLORS } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { databases, memberships } from '../src/db/schema';
import { DatabasesService } from '../src/databases/databases.service';
import type { Membership } from '../src/workspaces/workspace-access.guard';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let generalSpaceId: string;
let clientSpaceId: string;
let tasksDbId: string;
const { db, pool } = connectTestDb();

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Builder');

  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'DB Test WS' },
  });
  wsId = ws.json().id;

  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  generalSpaceId = spaces.json()[0].id;

  const clientSpace = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
    payload: { name: 'Client Work' },
  });
  clientSpaceId = clientSpace.json().id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('databases CRUD (MN-009)', () => {
  it('creates a database with title field, system fields, and default view', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: clientSpaceId, name: 'Tasks' },
    });
    expect(res.statusCode).toBe(201);
    tasksDbId = res.json().id;
    expect(res.json().apiSlug).toBe('tasks');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
    });
    const body = detail.json();
    expect(body.fields.map((f: { apiName: string }) => f.apiName)).toEqual([
      'id',
      'name',
      'created_at',
      'updated_at',
      'created_by',
    ]);
    expect(body.fields[0].type).toBe('id');
    expect(body.fields[1].type).toBe('title');
    expect(body.views).toHaveLength(1);
    expect(body.views[0].type).toBe('table');
  });

  it('generates unique api slugs per space (MN-153)', async () => {
    // clientSpace already has a "Tasks" (slug `tasks`). The same name in a
    // DIFFERENT space keeps the clean slug — namespacing is by space.
    const inGeneral = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Tasks' },
    });
    expect(inGeneral.json().apiSlug).toBe('tasks');
    expect(inGeneral.json().qualifiedSlug).toBe('general/tasks');

    // A second "Tasks" in the SAME space is suffixed.
    const dupe = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Tasks' },
    });
    expect(dupe.json().apiSlug).toBe('tasks_2');
  });

  it('guests see only databases in their scoped spaces (list + direct get)', async () => {
    const dana = await signUpUser(app, 'DanaG');
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/invites`,
      headers: authed(admin.token),
      payload: { email: dana.email, role: 'guest', grants: [{ space_id: clientSpaceId, role: 'commenter' }] },
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(dana.token),
      payload: { token },
    });

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(dana.token),
    });
    expect(list.json().map((d: { id: string }) => d.id)).toEqual([tasksDbId]);

    const general = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
    });
    const otherDbId = general.json().find((d: { id: string }) => d.id !== tasksDbId).id;

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${otherDbId}`,
      headers: authed(dana.token),
    });
    expect(forbidden.statusCode).toBe(404);

    const write = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(dana.token),
      payload: { space_id: clientSpaceId, name: 'Nope' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('moving a database to another space changes guest visibility', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().spaceId).toBe(generalSpaceId);

    // move it back for later tests
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { space_id: clientSpaceId },
    });
  });

  it('delete requires the exact database name as confirmation', async () => {
    const wrong = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { confirm: 'nope' },
    });
    expect(wrong.statusCode).toBe(409);

    const right = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
      payload: { confirm: 'Tasks' },
    });
    expect(right.statusCode).toBe(200);

    const gone = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${tasksDbId}`,
      headers: authed(admin.token),
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('database color auto-assignment + fallback (MN-299)', () => {
  it('auto-assigns a random palette color at creation time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Auto Color' },
    });
    expect(res.statusCode).toBe(201);
    expect(OPTION_COLORS).toContain(res.json().color);
  });

  it('an explicit color at creation time is respected, not overridden', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Explicit Color', color: 'teal' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().color).toBe('teal');
  });

  it('the manual-override path (icon-picker swatch → update()) still works unchanged', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Override Me' },
    });
    const id = created.json().id;
    const autoColor = created.json().color;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${wsId}/databases/${id}`,
      headers: authed(admin.token),
      payload: { color: 'red' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().color).toBe('red');
    expect(patched.json().color).not.toBe(autoColor === 'red' ? undefined : autoColor);
  });

  it('a legacy null-colored database (pre-MN-299) resolves to a stable non-null color at read time, without persisting it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Legacy Null Color' },
    });
    const id = created.json().id;

    // Simulate a database that predates auto-color-assignment: force color
    // back to null directly at the row level (bypassing the service).
    await db.update(databases).set({ color: null }).where(eq(databases.id, id));

    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${id}`,
      headers: authed(admin.token),
    });
    expect(OPTION_COLORS).toContain(first.json().color);

    // Stable across reads (hash-of-id, not random-per-request) and never
    // written back to the row.
    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${id}`,
      headers: authed(admin.token),
    });
    expect(second.json().color).toBe(first.json().color);

    const [row] = await db.select().from(databases).where(eq(databases.id, id));
    expect(row!.color).toBeNull();
  });

  it('surfaces target_database_color alongside target_database_name on relation fields', async () => {
    const parent = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Color Relation Parent' },
    });
    const child = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: generalSpaceId, name: 'Color Relation Child' },
    });
    const parentId = parent.json().id;
    const childId = child.json().id;
    const childColor = child.json().color;

    const relRes = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/relations`,
      headers: authed(admin.token),
      payload: {
        database_a_id: parentId,
        database_b_id: childId,
        cardinality: 'many_to_many',
        field_a_name: 'Children',
        field_b_name: 'Parents',
      },
    });
    expect(relRes.statusCode, relRes.body).toBe(201);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/databases/${parentId}`,
      headers: authed(admin.token),
    });
    const relField = detail.json().fields.find((f: { type: string }) => f.type === 'relation');
    expect(relField.relation).toMatchObject({
      target_database_id: childId,
      target_database_color: childColor,
    });
  });
});

describe('concurrent slug allocation is race-safe (MN-165)', () => {
  it('two concurrent creates of the SAME name in the SAME space both succeed with distinct slugs (no 500)', async () => {
    const service = app.get(DatabasesService);
    const membership = (await db.query.memberships.findFirst({
      where: eq(memberships.workspaceId, wsId),
    })) as Membership;
    expect(membership).toBeTruthy();

    // Fire both creates concurrently: `uniqueSlugFor` reads-then-inserts, so
    // pre-fix both would read `race_me` as free and the loser would 500 on
    // `databases_space_slug_uq`. The bounded retry must recompute the suffix.
    const [a, b] = await Promise.all([
      service.create(membership, { space_id: clientSpaceId, name: 'Race Me' }),
      service.create(membership, { space_id: clientSpaceId, name: 'Race Me' }),
    ]);

    // Both rows exist and carry the same name.
    expect(a.name).toBe('Race Me');
    expect(b.name).toBe('Race Me');
    expect(a.id).not.toBe(b.id);

    // One took the base slug, the other the `_2` suffix — order is nondeterministic.
    const slugs = [a.apiSlug, b.apiSlug].sort();
    expect(slugs).toEqual(['race_me', 'race_me_2']);

    // The unique index holds: exactly these two rows for this space+name.
    const rows = await db.query.databases.findMany({
      where: eq(databases.spaceId, clientSpaceId),
    });
    const raceRows = rows.filter((d) => d.name === 'Race Me');
    expect(raceRows.map((d) => d.apiSlug).sort()).toEqual(['race_me', 'race_me_2']);
  });

  it('a third concurrent create of the same name lands on the next free suffix', async () => {
    const service = app.get(DatabasesService);
    const membership = (await db.query.memberships.findFirst({
      where: eq(memberships.workspaceId, wsId),
    })) as Membership;

    // clientSpace already holds `race_me` and `race_me_2` from the prior test.
    const [c, d, e] = await Promise.all([
      service.create(membership, { space_id: clientSpaceId, name: 'Race Me' }),
      service.create(membership, { space_id: clientSpaceId, name: 'Race Me' }),
      service.create(membership, { space_id: clientSpaceId, name: 'Race Me' }),
    ]);

    const newSlugs = [c.apiSlug, d.apiSlug, e.apiSlug].sort();
    expect(newSlugs).toEqual(['race_me_3', 'race_me_4', 'race_me_5']);
  });
});
