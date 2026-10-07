import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, truncateAll } from './helpers/db';
import { databases, fields, spaces, views, workspaces } from '../src/db/schema';
import { migrateNumberFieldRefs } from '../src/views/migrate-number-field-refs';
import { scanNumberFieldRefs } from '../src/views/scan-number-field-refs';

const { db, pool } = connectTestDb();

let wsId: string;
let dbId: string;

/** One view per config shape the migration must cover, plus controls that must
 * be left untouched. */
let vFilter: string;
let vNestedFilter: string;
let vSort: string;
let vHiddenFieldIds: string;
let vDashboardTile: string;
let vDashboardWidget: string;
let vSummaryWidget: string;
let vFormRelationFilter: string;
/** A database where `number` is a REAL user field (a synced GitHub issue
 * number). The resolver says real fields win, so here `field: 'number'` means
 * the user's field, with different values from the record number — rewriting
 * it to `id` would silently change what the view selects. These views really
 * do reference `number`; the migration must still leave them alone.
 *
 * The first version of this test used a view filtering on `a_real_user_field`,
 * which never referenced `number` at all, so it passed whether or not the
 * migration was database-aware. It now tests the case its name claims. */
let vUserFieldNamedNumber: string;
let vUserFieldNamedNumberSort: string;
/** Control: an unrelated filter, which is all the old fixture ever proved. */
let vUnrelatedField: string;
/** `number` was a user field here but is soft-deleted, so it no longer
 * shadows the system field and this view must migrate. */
let vDeletedUserFieldDb: string;
/** Space-level: no single database, so `number` is ambiguous. Left alone and
 * reported as unresolved rather than guessed at. */
let vSpaceView: string;
let firstRun: Awaited<ReturnType<typeof migrateNumberFieldRefs>>;
let vAlreadyId: string;
let vNoConfig: string;
let vTrashed: string;

beforeAll(async () => {
  await truncateAll(pool);

  const [ws] = await db.insert(workspaces).values({ name: '764 WS', slug: '764-ws' }).returning();
  wsId = ws!.id;
  const [space] = await db.insert(spaces).values({ workspaceId: wsId, name: 'General', slug: 'general' }).returning();
  const [database] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId: space!.id, name: 'Tasks', apiSlug: 'tasks' })
    .returning();
  dbId = database!.id;

  async function makeView(name: string, config: Record<string, unknown>, onDb: string = dbId) {
    const [row] = await db
      .insert(views)
      .values({ databaseId: onDb, name, type: 'table', config })
      .returning();
    return row!.id;
  }

  const [githubDb] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId: space!.id, name: 'GitHub issues', apiSlug: 'github-issues' })
    .returning();
  await db
    .insert(fields)
    .values({ databaseId: githubDb!.id, displayName: 'number', apiName: 'number', type: 'number', isSystem: false });
  const [deletedFieldDb] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId: space!.id, name: 'Had a number field', apiSlug: 'had-number' })
    .returning();
  await db.insert(fields).values({
    databaseId: deletedFieldDb!.id,
    displayName: 'number',
    apiName: 'number',
    type: 'number',
    isSystem: false,
    deletedAt: new Date(),
  });

  vFilter = await makeView('Filter', { filters: { field: 'number', op: 'eq', value: 1 } });
  vNestedFilter = await makeView('Nested filter', {
    filters: { and: [{ field: 'name', op: 'eq', value: 'x' }, { or: [{ field: 'number', op: 'gt', value: 5 }] }] },
  });
  vSort = await makeView('Sort', { sorts: [{ field: 'name', direction: 'asc' }, { field: 'number', direction: 'desc' }] });
  vHiddenFieldIds = await makeView('Hidden field ids', { hidden_field_ids: ['__sys_number'] });
  vDashboardTile = await makeView('Dashboard tile', {
    dashboard_tiles: [{ id: '11111111-1111-1111-1111-111111111111', op: 'sum', field_api_name: 'number' }],
  });
  vDashboardWidget = await makeView('Dashboard widget', {
    dashboard_widgets: [
      {
        id: '22222222-2222-2222-2222-222222222222',
        type: 'bar',
        group_by_field_api_name: 'number',
        measure: { op: 'sum', field_api_name: 'number' },
        filter: { field: 'number', op: 'lt', value: 10 },
      },
    ],
  });
  vSummaryWidget = await makeView('Summary widget', {
    summary_widgets: [{ id: '33333333-3333-3333-3333-333333333333', type: 'stat', op: 'count', field_api_name: 'number' }],
  });
  vFormRelationFilter = await makeView('Form relation filter', {
    form: { fields: [{ field_id: '44444444-4444-4444-4444-444444444444', relation_filter: { field: 'number', op: 'eq', value: 3 } }] },
  });
  vUserFieldNamedNumber = await makeView(
    'User field named number',
    { filters: { field: 'number', op: 'eq', value: 42 } },
    githubDb!.id,
  );
  vUserFieldNamedNumberSort = await makeView(
    'User field named number (sort)',
    { sorts: [{ field: 'number', direction: 'desc' }] },
    githubDb!.id,
  );
  vUnrelatedField = await makeView('Unrelated field', { filters: { field: 'a_real_user_field', op: 'eq', value: 'x' } });
  vDeletedUserFieldDb = await makeView(
    'Soft-deleted user field',
    { filters: { field: 'number', op: 'eq', value: 7 } },
    deletedFieldDb!.id,
  );
  const [spaceView] = await db
    .insert(views)
    .values({ spaceId: space!.id, databaseId: null, name: 'Space view', type: 'table', config: { filters: { field: 'number', op: 'eq', value: 9 } } })
    .returning();
  vSpaceView = spaceView!.id;
  vAlreadyId = await makeView('Already id', { filters: { field: 'id', op: 'eq', value: 1 } });
  vNoConfig = await makeView('No config', {});
  vTrashed = await makeView('Trashed', { filters: { field: 'number', op: 'eq', value: 1 } });
  await db.update(views).set({ deletedAt: new Date() }).where(eq(views.id, vTrashed));
});

afterAll(async () => {
  await pool.end();
});

async function configOf(viewId: string) {
  const [row] = await db.select({ config: views.config }).from(views).where(eq(views.id, viewId));
  return row!.config as Record<string, unknown>;
}

describe('#764 — migrate stored view configs off the deprecated `number` api_name', () => {
  it('the pre-migration scan finds every reference (excluding trashed views)', async () => {
    const hits = await scanNumberFieldRefs(db);
    const ids = hits.map((h) => h.viewId);
    expect(ids).toEqual(
      expect.arrayContaining([
        vFilter,
        vNestedFilter,
        vSort,
        vHiddenFieldIds,
        vDashboardTile,
        vDashboardWidget,
        vSummaryWidget,
        vFormRelationFilter,
      ]),
    );
    // These two genuinely reference `number` — they are excluded because it is the user's own field there.
    expect(ids).not.toContain(vUserFieldNamedNumber);
    expect(ids).not.toContain(vUserFieldNamedNumberSort);
    expect(ids).toContain(vDeletedUserFieldDb);
    expect(hits.find((h) => h.viewId === vSpaceView)?.reason).toBe('space_view_unresolved');
    expect(ids).not.toContain(vUnrelatedField);
    expect(ids).not.toContain(vAlreadyId);
    expect(ids).not.toContain(vNoConfig);
    // Trashed views are excluded from the scan on purpose — unreachable, never compiled.
    expect(ids).not.toContain(vTrashed);
  });

  it('migrates a top-level filter leaf', async () => {
    firstRun = await migrateNumberFieldRefs(db);
    const config = await configOf(vFilter);
    expect(config.filters).toEqual({ field: 'id', op: 'eq', value: 1 });
  });

  it('migrates a filter leaf nested inside and/or', async () => {
    const config = await configOf(vNestedFilter);
    expect(config.filters).toEqual({
      and: [{ field: 'name', op: 'eq', value: 'x' }, { or: [{ field: 'id', op: 'gt', value: 5 }] }],
    });
  });

  it('migrates a sort key, leaving other sort keys untouched', async () => {
    const config = await configOf(vSort);
    expect(config.sorts).toEqual([{ field: 'name', direction: 'asc' }, { field: 'id', direction: 'desc' }]);
  });

  it('migrates the synthetic system-field id in hidden_field_ids', async () => {
    const config = await configOf(vHiddenFieldIds);
    expect(config.hidden_field_ids).toEqual(['__sys_id']);
  });

  it('migrates a dashboard tile\'s field_api_name', async () => {
    const config = await configOf(vDashboardTile);
    expect((config.dashboard_tiles as Array<{ field_api_name: string }>)[0]!.field_api_name).toBe('id');
  });

  it('migrates a dashboard widget\'s group_by_field_api_name, measure.field_api_name, and filter', async () => {
    const config = await configOf(vDashboardWidget);
    const widget = (config.dashboard_widgets as Array<Record<string, unknown>>)[0]!;
    expect(widget.group_by_field_api_name).toBe('id');
    expect((widget.measure as { field_api_name: string }).field_api_name).toBe('id');
    expect(widget.filter).toEqual({ field: 'id', op: 'lt', value: 10 });
  });

  it('migrates a summary widget\'s field_api_name', async () => {
    const config = await configOf(vSummaryWidget);
    expect((config.summary_widgets as Array<{ field_api_name: string }>)[0]!.field_api_name).toBe('id');
  });

  it('migrates a form field\'s relation_filter', async () => {
    const config = await configOf(vFormRelationFilter);
    const field = (config.form as { fields: Array<Record<string, unknown>> }).fields[0]!;
    expect(field.relation_filter).toEqual({ field: 'id', op: 'eq', value: 3 });
  });

  it('MUST KEEP WORKING: a view filtering or sorting on a real user field named `number` is untouched', async () => {
    expect((await configOf(vUserFieldNamedNumber)).filters).toEqual({ field: 'number', op: 'eq', value: 42 });
    expect((await configOf(vUserFieldNamedNumberSort)).sorts).toEqual([{ field: 'number', direction: 'desc' }]);
    expect((await configOf(vUnrelatedField)).filters).toEqual({ field: 'a_real_user_field', op: 'eq', value: 'x' });
  });

  it('a soft-deleted user field named `number` no longer shadows the system one, so its view migrates', async () => {
    expect((await configOf(vDeletedUserFieldDb)).filters).toEqual({ field: 'id', op: 'eq', value: 7 });
  });

  it('a space-level view is left alone, because `number` there is ambiguous', async () => {
    expect((await configOf(vSpaceView)).filters).toEqual({ field: 'number', op: 'eq', value: 9 });
  });

  it('reports what it deliberately skipped, so a skip is never silent', () => {
    expect(firstRun.skippedUserField).toBe(2);
    expect(firstRun.skippedSpaceView).toBe(1);
  });

  it('leaves an already-`id` filter and an empty config alone', async () => {
    expect((await configOf(vAlreadyId)).filters).toEqual({ field: 'id', op: 'eq', value: 1 });
    expect(await configOf(vNoConfig)).toEqual({});
  });

  it('does not touch a trashed view\'s config', async () => {
    const config = await configOf(vTrashed);
    expect(config.filters).toEqual({ field: 'number', op: 'eq', value: 1 });
  });

  it('the post-migration scan finds nothing but the one reference nobody can resolve automatically', async () => {
    const hits = await scanNumberFieldRefs(db);
    expect(hits).toEqual([
      { viewId: vSpaceView, name: 'Space view', locations: ['filters'], reason: 'space_view_unresolved' },
    ]);
  });

  it('is idempotent: running it again migrates nothing and changes EVERY view not at all', async () => {
    // Every view, trashed ones included, not just one fixture: if this ever runs
    // on each boot, "twice equals once" has to hold for the whole table.
    const snapshot = async () =>
      (await db.select({ id: views.id, config: views.config, updatedAt: views.updatedAt }).from(views)).sort((a, b) =>
        a.id.localeCompare(b.id),
      );
    const before = await snapshot();
    expect(before.length).toBeGreaterThan(10);
    const result = await migrateNumberFieldRefs(db);
    expect(result.migrated).toBe(0);
    expect(result.skippedUserField).toBe(firstRun.skippedUserField);
    expect(result.skippedSpaceView).toBe(firstRun.skippedSpaceView);
    expect(await snapshot()).toEqual(before);
  });
});
