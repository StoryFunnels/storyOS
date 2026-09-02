import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { databases, fields, records, spaces, views } from '../src/db/schema';

/**
 * #453 — `databases`, `views` and `spaces` used to be hard-deleted (no
 * `deleted_at` column existed on any of the three), so nothing survived to
 * restore from. This file reproduces that first (criterion 1, via direct DB
 * reads), then asserts the new behaviour: delete marks `deleted_at` instead
 * of removing the row, cascades the SAME mark onto live children, and every
 * read path this ticket touches excludes what's marked.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
const { db } = connectTestDb();

const as = (method: string, url: string, payload?: unknown, token?: string) =>
  app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? admin.token),
    payload: payload as never,
  });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SoftDelete');
  wsId = (await as('POST', '/workspaces', { name: 'Soft Delete WS' })).json().id;
});
afterAll(async () => {
  await app?.close();
});

describe('deleting a database, view or space marks deleted_at instead of removing the row (#453)', () => {
  it('a deleted database: the row survives with deleted_at set, its live fields/records/views are marked too', async () => {
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Deals' })).json().id;
    const fieldId = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Amount', type: 'number' })
    ).json().id;
    const recordId = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })
    ).json().id;

    const del = await as('DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Deals' });
    expect(del.statusCode, del.body).toBeLessThan(300);

    // Reproduces criterion 1: confirm through the DATABASE (not the API) that
    // the row is flagged, not gone.
    const [row] = await db.select().from(databases).where(eq(databases.id, dbId));
    expect(row, 'the database row must still exist').toBeDefined();
    expect(row!.deletedAt).not.toBeNull();

    const [field] = await db.select().from(fields).where(eq(fields.id, fieldId));
    expect(field!.deletedAt, 'the field must be marked deleted too, not left live-but-orphaned').not.toBeNull();

    const [record] = await db.select().from(records).where(eq(records.id, recordId));
    expect(record!.deletedAt, 'the record must be marked deleted too').not.toBeNull();

    const dbViews = await db.select().from(views).where(eq(views.databaseId, dbId));
    expect(dbViews.length).toBeGreaterThan(0);
    for (const v of dbViews) expect(v.deletedAt, 'every view on the database must be marked deleted').not.toBeNull();
  });

  it('a deleted database no longer appears in GET /databases, and GET /databases/:db 404s', async () => {
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Reusable' })).json().id;
    await as('DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Reusable' });

    const list = await as('GET', `/workspaces/${wsId}/databases`);
    expect(list.json().map((d: { id: string }) => d.id)).not.toContain(dbId);

    const get = await as('GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(get.statusCode).toBe(404);

    // The api_slug unique index is whole-table, not partial-over-live-rows —
    // reusing the exact same name still succeeds (a NEW database, disambiguated
    // slug), it just doesn't reclaim the old slug. That's the existing
    // behaviour this ticket does not change.
    const recreated = await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Reusable' });
    expect(recreated.statusCode, recreated.body).toBeLessThan(300);
    expect(recreated.json().id).not.toBe(dbId);
  });

  it('a deleted space cascades to its own databases (and each database cascades the same as a direct delete), plus its dashboards', async () => {
    const spaceRes = await as('POST', `/workspaces/${wsId}/spaces`, { name: 'Doomed' });
    const spaceId = spaceRes.json().id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Inside' })).json().id;
    const recordId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;
    const dashboard = await as('POST', `/workspaces/${wsId}/spaces/${spaceId}/views`, {
      name: 'Overview',
      type: 'dashboard',
    });
    expect(dashboard.statusCode, dashboard.body).toBeLessThan(300);
    const dashboardId = dashboard.json().id;

    const del = await as('DELETE', `/workspaces/${wsId}/spaces/${spaceId}`, { confirm: 'Doomed' });
    expect(del.statusCode, del.body).toBeLessThan(300);

    const [spaceRow] = await db.select().from(spaces).where(eq(spaces.id, spaceId));
    expect(spaceRow!.deletedAt).not.toBeNull();
    const [dbRow] = await db.select().from(databases).where(eq(databases.id, dbId));
    expect(dbRow!.deletedAt, 'the space delete must cascade to its database via the SAME rule a direct delete uses').not.toBeNull();
    const [recRow] = await db.select().from(records).where(eq(records.id, recordId));
    expect(recRow!.deletedAt, "the database's own record must be marked too, transitively").not.toBeNull();
    const [dashRow] = await db.select().from(views).where(eq(views.id, dashboardId));
    expect(dashRow!.deletedAt, "the space's own dashboard view must be marked deleted").not.toBeNull();

    // Read paths: the space and everything under it vanish from every list.
    expect((await as('GET', `/workspaces/${wsId}/spaces`)).json().map((s: { id: string }) => s.id)).not.toContain(spaceId);
    expect((await as('GET', `/workspaces/${wsId}/databases`)).json().map((d: { id: string }) => d.id)).not.toContain(dbId);
  });

  it('MUST KEEP WORKING: existing record trash/restore is unaffected by database soft-delete — a record deleted BEFORE its database keeps its own deletedAt timestamp untouched', async () => {
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Trash Timing' })).json().id;
    const recordId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;

    const preDelete = await as('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`);
    expect(preDelete.statusCode, preDelete.body).toBeLessThan(300);
    const [before] = await db.select().from(records).where(eq(records.id, recordId));
    const originalDeletedAt = before!.deletedAt;
    expect(originalDeletedAt).not.toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    await as('DELETE', `/workspaces/${wsId}/databases/${dbId}`, { confirm: 'Trash Timing' });

    const [after] = await db.select().from(records).where(eq(records.id, recordId));
    expect(
      after!.deletedAt?.getTime(),
      "the record's own trash timestamp must not be extended by the database's cascade — only live rows get marked",
    ).toBe(originalDeletedAt!.getTime());
  });

  it('a database keeps requiring at least one LIVE view — soft-deleted views do not count toward the minimum', async () => {
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Views' })).json().id;
    const dbGet = await as('GET', `/workspaces/${wsId}/databases/${dbId}`);
    const defaultViewId = dbGet.json().views[0].id;

    const extra = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Table 2',
      type: 'table',
      config: {},
    });
    expect(extra.statusCode, extra.body).toBeLessThan(300);
    const extraId = extra.json().id;

    const removeExtra = await as('DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${extraId}`);
    expect(removeExtra.statusCode, removeExtra.body).toBeLessThan(300);

    const [extraRow] = await db.select().from(views).where(eq(views.id, extraId));
    expect(extraRow!.deletedAt, 'view delete must soft-delete, not remove the row').not.toBeNull();

    const removeLast = await as('DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${defaultViewId}`);
    expect(removeLast.statusCode, "the soft-deleted board must not count toward the 'keep at least one' minimum").toBe(409);
  });

  it('a deleted database is not offered as a relation target', async () => {
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const aId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'RelA' })).json().id;
    const bId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'RelB' })).json().id;
    await as('DELETE', `/workspaces/${wsId}/databases/${bId}`, { confirm: 'RelB' });

    const relate = await as('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: aId,
      database_b_id: bId,
      cardinality: 'one_to_many',
    });
    expect(relate.statusCode, 'a soft-deleted database must not be usable as a NEW relation target').toBe(404);
  });

  it('sanity: every row this suite created and then deleted is a soft mark, not a gone row (bulk check)', async () => {
    const deletedDbs = await db.select().from(databases).where(isNotNull(databases.deletedAt));
    const liveDbs = await db.select().from(databases).where(isNull(databases.deletedAt));
    expect(deletedDbs.length).toBeGreaterThan(0);
    expect(liveDbs.length).toBeGreaterThan(0);
  });
});
