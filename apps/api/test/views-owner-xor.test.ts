import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * #347 — the `views_owner_xor` CHECK: a view has a database XOR a space.
 *
 * This tests the DATABASE CONSTRAINT deliberately, not the controller. The
 * controller rejects the same shapes with a readable message and that is the
 * user-facing contract — but the constraint is the thing that holds when a
 * future endpoint, a migration, a backfill script or a support query forgets.
 * `access_grants_scope_xor` (MN-125) exists because the invariant the service
 * "always checked" turned out not to hold in one path; this is the same lesson
 * applied before rather than after.
 *
 * Writes go through raw SQL for exactly that reason: routing them through the
 * service would test the service's guard and prove nothing about the column.
 */
let app: NestFastifyApplication;
let db: ReturnType<typeof connectTestDb>;
let spaceId: string;
let databaseId: string;

beforeAll(async () => {
  app = await createTestApp();
  db = connectTestDb();
  const admin = await signUpUser(app, 'Xor');
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({
      method: method as never,
      url: `/api/v1${url}`,
      headers: authed(admin.token),
      payload: payload as never,
    });

  const wsId = (await inject('POST', '/workspaces', { name: 'Xor WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  databaseId = (
    await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })
  ).json().id;
});

afterAll(async () => {
  await db.pool.end();
  await app.close();
});

/** Raw pool write — bypasses every service guard, which is the whole point. */
function rawInsert(database_id: string | null, space_id: string | null) {
  return db.pool.query(
    `INSERT INTO views (database_id, space_id, name, type) VALUES ($1, $2, 'probe', 'table')`,
    [database_id, space_id],
  );
}

describe('views_owner_xor (#347)', () => {
  it('ACCEPTS a database-owned view — the shape every existing view has', async () => {
    await expect(rawInsert(databaseId, null)).resolves.toBeTruthy();
  });

  it('ACCEPTS a space-owned view with no database — a dashboard (#306)', async () => {
    await expect(rawInsert(null, spaceId)).resolves.toBeTruthy();
  });

  it('REJECTS neither — a view with no home at all', async () => {
    await expect(rawInsert(null, null)).rejects.toThrow(/views_owner_xor/);
  });

  it('REJECTS both — two possible homes is the ambiguity the XOR exists to prevent', async () => {
    await expect(rawInsert(databaseId, spaceId)).rejects.toThrow(/views_owner_xor/);
  });

  it('every view created by the ordinary path satisfies it', async () => {
    // Guard the guard: if a refactor stopped setting database_id, the four cases
    // above would still pass while every real view became invalid.
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM views WHERE (database_id IS NULL) = (space_id IS NULL)`,
    );
    expect(rows[0].n).toBe(0);
  });
});
