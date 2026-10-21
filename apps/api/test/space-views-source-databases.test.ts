import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { measureDb } from '../src/common/server-timing';
import { SpaceViewsService } from '../src/views/space-views.service';
import type { Membership } from '../src/workspaces/workspace-access.guard';

/**
 * ticket #1013 — each view in the space-views list says which databases it reads (`source_database_ids`), so the sidebar can draw its
 * source marks in the one request it already makes. An ordinary view reads its own database; a dashboard reads its own (if any) plus
 * every database its tiles and widgets name. A database the caller cannot read is OMITTED, never listed.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, spaceA: string, spaceB: string, dbA: string, dbSecret: string, dbB: string;
let guest: { token: string };
const as = (t: string, method: string, url: string, payload?: unknown) => call(app, t, method, url, payload);
const own = (method: string, url: string, payload?: unknown) => as(owner.token, method, url, payload);
type Row = { id: string; name: string; type: string; database_id: string | null; source_database_ids: string[] };
const list = async (t: string, space = spaceA) => ((await as(t, 'GET', `/workspaces/${ws}/spaces/${space}/views`)).json().data as Row[]);
const byName = (rows: Row[], name: string) => rows.find((r) => r.name === name)!;

/** A dashboard, with its config written straight to the row so a test can name any database (the API validates readable ones). */
async function dashboard(name: string, cfg: { tiles?: Array<string | null>; widgets?: Array<string | null>; space?: string; database?: string }) {
  const id = cfg.database
    ? (await own('POST', `/workspaces/${ws}/databases/${cfg.database}/views`, { name, type: 'dashboard' })).json().id as string
    : (await own('POST', `/workspaces/${ws}/spaces/${cfg.space ?? spaceA}/views`, { name, type: 'dashboard' })).json().id as string;
  const tiles = (cfg.tiles ?? []).map((d) => ({ id: randomUUID(), label: 't', op: 'count', ...(d ? { database_id: d } : {}) }));
  const widgets = (cfg.widgets ?? []).map((d) => ({ id: randomUUID(), type: 'bar', title: 'w', measure: { op: 'count' }, ...(d ? { database_id: d } : {}) }));
  await raw.execute(`UPDATE views SET config = config || '${JSON.stringify({ dashboard_tiles: tiles, dashboard_widgets: widgets })}'::jsonb WHERE id = '${id}'` as never);
  return id;
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Source Owner');
  ws = (await own('POST', '/workspaces', { name: 'Sources WS' })).json().id;
  spaceA = (await own('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  spaceB = (await own('POST', `/workspaces/${ws}/spaces`, { name: 'Elsewhere' })).json().id;
  dbA = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Tasks' })).json().id;
  dbSecret = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Secrets' })).json().id;
  dbB = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'Elsewhere DB' })).json().id;
  guest = await joinAs(app, owner.token, ws, 'Source Guest', 'guest', [{ database_id: dbA, role: 'viewer' }]);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1013 source_database_ids', () => {
  it('an ordinary view reads its own database', async () => {
    const rows = await list(owner.token);
    for (const v of rows.filter((r) => r.type !== 'dashboard')) expect(v.source_database_ids, v.name).toEqual([v.database_id]);
    expect(rows.some((r) => r.database_id === dbA)).toBe(true);
  });

  it('a space-level dashboard reads the distinct databases its tiles and widgets name, in order, without repeats; an unconfigured block reads nothing', async () => {
    await dashboard('Cross space', { tiles: [dbB, dbA, dbB], widgets: [dbA, dbSecret, null] });
    await dashboard('Unconfigured', { tiles: [null], widgets: [null] });
    await dashboard('Empty', {});
    const rows = await list(owner.token);
    expect(byName(rows, 'Cross space').source_database_ids).toEqual([dbB, dbA, dbSecret]);
    expect(byName(rows, 'Unconfigured').source_database_ids).toEqual([]);
    expect(byName(rows, 'Empty').source_database_ids).toEqual([]);
  });

  it('a database-owned dashboard reads its own database plus the others its blocks name (a block with none reads its own)', async () => {
    await dashboard('Owned', { database: dbA, tiles: [null, dbB], widgets: [dbSecret, null] });
    expect(byName(await list(owner.token), 'Owned').source_database_ids).toEqual([dbA, dbB, dbSecret]);
  });

  it('a GUEST sees only the databases they can read, and the response never contains the others\' ids', async () => {
    await dashboard('Mixed for a guest', { tiles: [dbA, dbSecret, dbB] });
    const res = await as(guest.token, 'GET', `/workspaces/${ws}/spaces/${spaceA}/views`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Row[];
    expect(byName(rows, 'Mixed for a guest').source_database_ids, 'the granted database only').toEqual([dbA]);
    for (const secret of [dbSecret, dbB]) expect(res.body, 'a database the guest cannot read is not leaked anywhere in the payload').not.toContain(secret);
    // control: the owner sees all three, so the filter (not the fixture) is what removed them
    expect(byName(await list(owner.token), 'Mixed for a guest').source_database_ids).toEqual([dbA, dbSecret, dbB]);
  });

  it('a deleted database, and a database id from ANOTHER workspace, are omitted', async () => {
    const gone = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Soon gone' })).json().id as string;
    const otherOwner = await signUpUser(app, 'Other Workspace Owner');
    const otherWs = (await as(otherOwner.token, 'POST', '/workspaces', { name: 'Other WS' })).json().id as string;
    const otherSpace = (await as(otherOwner.token, 'GET', `/workspaces/${otherWs}/spaces`)).json()[0].id as string;
    const foreign = (await as(otherOwner.token, 'POST', `/workspaces/${otherWs}/databases`, { space_id: otherSpace, name: 'Foreign' })).json().id as string;
    await dashboard('Dangling', { tiles: [dbA, gone, foreign] });
    await raw.execute(`UPDATE databases SET deleted_at = now() WHERE id = '${gone}'` as never); // soft-deleted, as the API does
    expect(byName(await list(owner.token), 'Dangling').source_database_ids).toEqual([dbA]);
  });

  it('no N+1: the number of statements does not grow with the number of dashboards (it grows with the distinct databases named)', async () => {
    const svc = app.get(SpaceViewsService);
    const membership = { workspaceId: ws, userId: (await own('GET', '/me')).json().id, role: 'admin', status: 'active' } as unknown as Membership;
    const fresh = (await own('POST', `/workspaces/${ws}/spaces`, { name: 'Counting' })).json().id as string;
    const countFor = async () => (await measureDb(() => svc.listForSpace(membership, fresh))).statements;
    await dashboard('c1', { space: fresh, tiles: [dbA, dbB] });
    const few = await countFor();
    for (let i = 0; i < 25; i++) await dashboard(`c${i + 2}`, { space: fresh, tiles: [dbA, dbB], widgets: [dbSecret] });
    const many = await countFor();
    const manyGuestless = await countFor();
    expect(many, `1 dashboard: ${few} statements, 26 dashboards: ${many}`).toBeLessThanOrEqual(few + 1);
    expect(manyGuestless).toBe(many);
  });
});
