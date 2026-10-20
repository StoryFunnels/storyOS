import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { favorites, memberships, recordWatchers, userPreferences, viewerState } from '../src/db/schema';
import { ViewerStateService } from '../src/viewer-state/viewer-state.service';
import { VIEWER_STATE_KINDS } from '../src/viewer-state/viewer-state.kinds';

/**
 * ADR-0019 / #973 — per-viewer overrides are one row each in `viewer_state`, behind a registry of kinds. The lost-update race is
 * `viewer-state-lost-update.test.ts`. Here: access is the same for every kind, two people never see each other's override, the old
 * blob is backfilled and emptied, and a member's state leaves with their membership.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string, tasks: string, other: string, rel: string;
let view: string;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const filter = (value: string) => ({ filter: { and: [{ field: 'name', op: 'contains', value }] } });
const filterUrl = (viewId = view, db = tasks) => `/workspaces/${ws}/databases/${db}/views/${viewId}/personal-filter`;
const collUrl = (fieldId = rel, db = tasks) => `/workspaces/${ws}/databases/${db}/fields/${fieldId}/personal-collection-view`;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'VS Owner');
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'VS Access WS' })).json().id;
  space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  other = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Other' })).json().id;
  view = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/views`, { name: 'V', type: 'table' })).json().id;
  rel = (await as(owner.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: tasks, database_b_id: other, cardinality: 'one_to_many', field_a_name: 'Link' })).json().field_a.id;
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#973 access is the same for every kind', () => {
  it('a viewer-only guest can set, read and clear their OWN override on both kinds; the shape is unchanged', async () => {
    const guest = await joinAs(app, owner.token, ws, 'VS Guest', 'guest', [{ database_id: tasks, role: 'viewer' }]);
    expect((await as(guest.token, 'PUT', filterUrl(), filter('g'))).json()).toMatchObject({ filter: { and: [{ field: 'name', op: 'contains', value: 'g' }] } });
    expect((await as(guest.token, 'GET', filterUrl())).json().filter).toBeTruthy();
    expect((await as(guest.token, 'PUT', collUrl(), { sorts: [{ field: 'name', direction: 'asc' }] })).json()).toMatchObject({ config: { sorts: [{ field: 'name', direction: 'asc' }] } });
    expect((await as(guest.token, 'DELETE', filterUrl())).json()).toEqual({ cleared: true });
    expect((await as(guest.token, 'DELETE', filterUrl())).json(), 'clearing again is a no-op, not a 404').toEqual({ cleared: true });
    expect((await as(guest.token, 'GET', filterUrl())).json()).toEqual({ filter: null });
    expect((await as(guest.token, 'DELETE', collUrl())).json()).toEqual({ cleared: true });
  });

  it('a person with no access to the database gets a 404 on every kind and every verb, and nothing is written', async () => {
    const stranger = await joinAs(app, owner.token, ws, 'VS Stranger', 'guest', [{ database_id: other, role: 'viewer' }]);
    const before = (await raw.select().from(viewerState).where(eq(viewerState.userId, stranger.id))).length;
    for (const [method, url, body] of [
      ['GET', filterUrl(), undefined], ['PUT', filterUrl(), filter('x')], ['DELETE', filterUrl(), undefined],
      ['GET', collUrl(), undefined], ['PUT', collUrl(), { color_by: 'x' }], ['DELETE', collUrl(), undefined],
    ] as const) {
      const res = await as(stranger.token, method, url, body);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
    }
    expect((await raw.select().from(viewerState).where(eq(viewerState.userId, stranger.id))).length).toBe(before);
  });

  it('a view or field that is not in the database named in the URL is a 404 (no override on a shared object you were not pointed at)', async () => {
    expect((await as(owner.token, 'PUT', filterUrl(view, other), filter('x'))).statusCode).toBe(404);
    const stray = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Plain', type: 'text' })).json().id;
    expect((await as(owner.token, 'PUT', collUrl(stray), { color_by: 'x' })).statusCode, 'only a relation field has a collection').toBe(404);
  });

  it('a view of ANOTHER workspace cannot be targeted, even by its id', async () => {
    const outsider = await signUpUser(app, 'VS Outsider');
    const ws2 = (await as(outsider.token, 'POST', '/workspaces', { name: 'VS Other WS' })).json().id;
    const sp2 = (await as(outsider.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const db2 = (await as(outsider.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: sp2, name: 'Theirs' })).json().id;
    const view2 = (await as(outsider.token, 'POST', `/workspaces/${ws2}/databases/${db2}/views`, { name: 'T', type: 'table' })).json().id;
    // through MY workspace's URL, naming THEIR view
    expect((await as(owner.token, 'PUT', filterUrl(view2, tasks), filter('x'))).statusCode).toBe(404);
    expect((await raw.select().from(viewerState).where(eq(viewerState.targetId, view2))).length).toBe(0);
  });
});

describe('#973 overrides are per person', () => {
  it('two people each hold their own override on the same view; neither sees the other\'s, and one clearing does not touch the other', async () => {
    const a = await joinAs(app, owner.token, ws, 'VS A', 'member');
    const b = await joinAs(app, owner.token, ws, 'VS B', 'member');
    await as(a.token, 'PUT', filterUrl(), filter('alpha'));
    expect((await as(b.token, 'GET', filterUrl())).json()).toEqual({ filter: null });
    await as(b.token, 'PUT', filterUrl(), filter('beta'));
    expect((await as(a.token, 'GET', filterUrl())).json().filter.and[0].value).toBe('alpha');
    await as(a.token, 'DELETE', filterUrl());
    expect((await as(b.token, 'GET', filterUrl())).json().filter.and[0].value, 'B kept theirs').toBe('beta');
  });

  it('a filter and a collection view written at the same instant by one person both survive', async () => {
    const p = await joinAs(app, owner.token, ws, 'VS P', 'member');
    const [r1, r2] = await Promise.all([as(p.token, 'PUT', filterUrl(), filter('x')), as(p.token, 'PUT', collUrl(), { color_by: 'status' })]);
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
    expect((await as(p.token, 'GET', filterUrl())).json().filter).toBeTruthy();
    expect((await as(p.token, 'GET', collUrl())).json().config).toEqual({ color_by: 'status' });
  });

  it('a filter naming a field that no longer exists is pruned on READ, never rewritten in storage', async () => {
    const p = await joinAs(app, owner.token, ws, 'VS Pruner', 'member');
    const f = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Temp', type: 'text' })).json();
    await as(p.token, 'PUT', filterUrl(), { filter: { and: [{ field: f.apiName, op: 'contains', value: 'z' }, { field: 'name', op: 'contains', value: 'keep' }] } });
    await as(owner.token, 'DELETE', `/workspaces/${ws}/databases/${tasks}/fields/${f.id}`);
    const read = (await as(p.token, 'GET', filterUrl())).json().filter;
    expect(JSON.stringify(read)).not.toContain(f.apiName);
    expect(JSON.stringify(read)).toContain('keep');
    const stored = (await raw.select().from(viewerState).where(and(eq(viewerState.userId, p.id), eq(viewerState.kind, 'view_filter'))))[0]!;
    expect(JSON.stringify(stored.data), 'storage still holds what was written (keep-and-filter)').toContain(f.apiName);
  });
});

describe('#973 the old blob is backfilled into rows and emptied (the migration)', () => {
  const sqlFile = readFileSync(join(__dirname, '../drizzle/0114_viewer_state.sql'), 'utf8');
  // the data statements only: everything after the CREATE TABLE / FK / index statements
  const dataStatements = sqlFile.split('--> statement-breakpoint').map((s) => s.trim()).filter((s) => /^(--[^\n]*\n)*\s*(INSERT|UPDATE)/.test(s));

  it('keeps live entries as rows (workspace resolved through the view / field), drops dangling ones, empties the keys, keeps everything else, and a re-run changes nothing', async () => {
    expect(dataStatements).toHaveLength(3);
    const person = await joinAs(app, owner.token, ws, 'VS Migrated', 'member');
    const me = person.id;
    const ghostView = '00000000-0000-4000-8000-0000000000aa';
    const ghostField = '00000000-0000-4000-8000-0000000000bb';
    const f = { and: [{ field: 'name', op: 'contains', value: 'old' }] };
    const blob = {
      notifications: { assigned: false },
      viewFilters: { [view]: f, [ghostView]: f, 'not-a-uuid': f },
      collectionFilters: { [rel]: { color_by: 'old' }, [ghostField]: { color_by: 'gone' } },
    };
    await raw.insert(userPreferences).values({ userId: me, preferences: blob }).onConflictDoUpdate({ target: userPreferences.userId, set: { preferences: blob } });
    const entriesBefore = Object.keys(blob.viewFilters).length + Object.keys(blob.collectionFilters).length;
    expect(entriesBefore).toBe(5);

    for (const stmt of dataStatements) await raw.execute(sql.raw(stmt));

    const rows = await raw.select().from(viewerState).where(eq(viewerState.userId, me));
    expect(rows.map((r) => `${r.kind}:${r.targetId}`).sort(), '5 entries in, 2 live ones out; 3 dangling dropped').toEqual([`collection_view:${rel}`, `view_filter:${view}`].sort());
    expect(rows.every((r) => r.workspaceId === ws), 'the workspace came from the view / field\'s database').toBe(true);
    expect(rows.find((r) => r.kind === 'view_filter')!.data).toEqual(f);
    const after = (await raw.select().from(userPreferences).where(eq(userPreferences.userId, me)))[0]!.preferences as Record<string, unknown>;
    expect(after).not.toHaveProperty('viewFilters');
    expect(after).not.toHaveProperty('collectionFilters');
    expect(after.notifications, 'everything else in the blob is untouched').toEqual({ assigned: false });

    for (const stmt of dataStatements) await raw.execute(sql.raw(stmt)); // re-run
    expect((await raw.select().from(viewerState).where(eq(viewerState.userId, me))).length, 'idempotent').toBe(2);
    // and the migrated override is live through the endpoint
    expect((await as(person.token, 'GET', filterUrl())).json().filter).toBeTruthy();
  });
});

describe('#973 a member\'s per-viewer state leaves with their membership, and only from that workspace', () => {
  it('removing a member deletes their overrides, favourites and watches in THIS workspace; the same person\'s state in another workspace is untouched', async () => {
    const mate = await joinAs(app, owner.token, ws, 'VS Leaver', 'member');
    // a second workspace the person also belongs to
    const owner2 = await signUpUser(app, 'VS Owner 2');
    const ws2 = (await as(owner2.token, 'POST', '/workspaces', { name: 'VS Second WS' })).json().id;
    const sp2 = (await as(owner2.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const db2 = (await as(owner2.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: sp2, name: 'Second' })).json().id;
    const view2 = (await as(owner2.token, 'POST', `/workspaces/${ws2}/databases/${db2}/views`, { name: 'S', type: 'table' })).json().id;
    await joinAs(app, owner2.token, ws2, 'VS Leaver', 'member').catch(() => undefined); // a different person object; link the SAME user below
    await raw.insert(memberships).values({ workspaceId: ws2, userId: mate.id, role: 'member', status: 'active' });

    const rec = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'watched' } })).json().id as string;
    await as(mate.token, 'PUT', filterUrl(), filter('mine'));
    await as(mate.token, 'POST', `/workspaces/${ws}/favorites`, { target_type: 'database', target_id: tasks });
    await as(mate.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records/${rec}/watch`);
    await as(mate.token, 'PUT', filterUrl(view2, db2).replace(ws, ws2), filter('theirs')); // state in the SECOND workspace
    const mine = () => raw.select().from(viewerState).where(and(eq(viewerState.userId, mate.id), eq(viewerState.workspaceId, ws)));
    expect((await mine()).length).toBeGreaterThan(0);
    expect((await raw.select().from(favorites).where(and(eq(favorites.userId, mate.id), eq(favorites.workspaceId, ws)))).length).toBe(1);
    expect((await raw.select().from(recordWatchers).where(and(eq(recordWatchers.userId, mate.id), eq(recordWatchers.workspaceId, ws)))).length).toBe(1);

    const members = (await as(owner.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id?: string; userId?: string }>;
    const row = members.find((m) => (m.user_id ?? m.userId) === mate.id)!;
    expect((await as(owner.token, 'DELETE', `/workspaces/${ws}/members/${row.id}`)).statusCode).toBe(200);

    expect(await mine(), 'overrides gone from this workspace').toHaveLength(0);
    expect(await raw.select().from(favorites).where(and(eq(favorites.userId, mate.id), eq(favorites.workspaceId, ws)))).toHaveLength(0);
    expect(await raw.select().from(recordWatchers).where(and(eq(recordWatchers.userId, mate.id), eq(recordWatchers.workspaceId, ws)))).toHaveLength(0);
    expect((await raw.select().from(viewerState).where(and(eq(viewerState.userId, mate.id), eq(viewerState.workspaceId, ws2)))).length, 'the other workspace\'s state is untouched').toBe(1);
  });
});

describe('#973 GDPR erasure takes the same per-viewer state, in the workspace it was requested in', () => {
  it('erasing a member deletes their overrides and watches in THIS workspace (watchers survived erasure before); another workspace is untouched', async () => {
    const mate = await joinAs(app, owner.token, ws, 'VS Erased', 'member');
    const owner2 = await signUpUser(app, 'VS Owner 3');
    const ws2 = (await as(owner2.token, 'POST', '/workspaces', { name: 'VS Third WS' })).json().id;
    const sp2 = (await as(owner2.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const db2 = (await as(owner2.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: sp2, name: 'Third' })).json().id;
    const view2 = (await as(owner2.token, 'POST', `/workspaces/${ws2}/databases/${db2}/views`, { name: 'S', type: 'table' })).json().id;
    await raw.insert(memberships).values({ workspaceId: ws2, userId: mate.id, role: 'member', status: 'active' });
    const rec = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name: 'watched by erased' } })).json().id as string;
    await as(mate.token, 'PUT', filterUrl(), filter('mine'));
    await as(mate.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records/${rec}/watch`);
    await as(mate.token, 'PUT', `/workspaces/${ws2}/databases/${db2}/views/${view2}/personal-filter`, filter('theirs'));

    const members = (await as(owner.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id?: string; userId?: string }>;
    const row = members.find((m) => (m.user_id ?? m.userId) === mate.id)!;
    const res = await as(owner.token, 'POST', `/workspaces/${ws}/members/${row.id}/gdpr/anonymize`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().removed).toMatchObject({ viewer_state: 1, record_watchers: 1 });
    expect(await raw.select().from(viewerState).where(and(eq(viewerState.userId, mate.id), eq(viewerState.workspaceId, ws)))).toHaveLength(0);
    expect(await raw.select().from(recordWatchers).where(and(eq(recordWatchers.userId, mate.id), eq(recordWatchers.workspaceId, ws)))).toHaveLength(0);
    expect((await raw.select().from(viewerState).where(and(eq(viewerState.userId, mate.id), eq(viewerState.workspaceId, ws2)))).length, 'the other workspace\'s rows are not this request\'s to delete').toBe(1);
  });
});

describe('#973 pinned_tabs is a registered kind, ready for ticket #966', () => {
  it('is in the registry, validates its data, and refuses a view that is not on the database', async () => {
    expect(Object.keys(VIEWER_STATE_KINDS)).toEqual(expect.arrayContaining(['view_filter', 'collection_view', 'pinned_tabs']));
    const svc = app.get(ViewerStateService);
    const me = (await as(owner.token, 'GET', '/me')).json().id as string;
    const membership = (await raw.select().from(memberships).where(and(eq(memberships.userId, me), eq(memberships.workspaceId, ws))))[0]!;
    const v2 = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/views`, { name: 'Second', type: 'table' })).json().id as string;
    const set = await svc.set(membership as never, 'pinned_tabs', tasks, { view_ids: [v2, view] });
    expect(set.view_ids).toEqual([v2, view]);
    expect((await svc.get(membership as never, 'pinned_tabs', tasks))!.view_ids, 'order is the person\'s').toEqual([v2, view]);
    await expect(svc.set(membership as never, 'pinned_tabs', tasks, { view_ids: ['00000000-0000-4000-8000-0000000000cc'] })).rejects.toThrow(/View not found/);
    await expect(svc.set(membership as never, 'pinned_tabs', tasks, { view_ids: [view, view] })).rejects.toThrow(/twice/);
    await expect(svc.set(membership as never, 'pinned_tabs', tasks, { view_ids: ['not-a-uuid'] })).rejects.toThrow();
  });
});
