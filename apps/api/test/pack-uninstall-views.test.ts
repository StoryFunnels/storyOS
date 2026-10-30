import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PackManifest } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { PACK_REGISTRY } from '../src/packs/registry';

/**
 * Ticket #1153 — uninstalling a pack removes the views the install created and the person has not edited.
 *
 * Before the fix `installViews` hashed the manifest's REQUEST while `ViewsService.create` stored a config with defaults filled in
 * (a Board's group-by), so every pack view read as "Changed since install" on uninstall and none was ever removed.
 */

let app: NestFastifyApplication;
let admin: { token: string };
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Uninstall Views');
}, 90_000);
afterAll(async () => { await app?.close(); });

type Res = { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason?: string }> };

/** Support Inbox plus extra views: a second Board-less table, and one NAMED like the database's own default view. */
function manifestWithViews(slug: string): PackManifest {
  const base = PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest;
  const m = structuredClone(base) as PackManifest;
  m.slug = slug;
  m.views = [
    ...m.views,
    { database: 'Tickets', name: 'Everything', type: 'table', config: {} },
    { database: 'Tickets', name: 'All records', type: 'table', config: {} },
  ] as never;
  return m;
}

const newWs = async () => (await as('POST', '/workspaces', { name: `Uninstall views ${Date.now()}` })).json().id as string;
async function install(ws: string, m: unknown, resolutions?: unknown) {
  const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, resolutions });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function installId(ws: string, slug: string) {
  const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
  return list.find((i) => i.slug === slug)!.id;
}
async function uninstall(ws: string, slug: string): Promise<Res> {
  const res = await as('POST', `/workspaces/${ws}/packs/${await installId(ws, slug)}/uninstall`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
async function ticketsDb(ws: string) {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  return dbs.find((d) => d.name === 'Tickets')!.id;
}
async function viewsOf(ws: string, dbId: string) {
  const det = (await as('GET', `/workspaces/${ws}/databases/${dbId}`)).json() as { views: Array<{ id: string; name: string; isDefault: boolean }> };
  return det.views;
}
const REUSE = Object.fromEntries(["Tickets", "Triage", "Tickets.Board", "Tickets.Everything", "Tickets.Notify on status change"].map((k) => [k, { action: "reuse" }]));
const names = (vs: Array<{ name: string }>) => vs.map((v) => v.name).sort();

describe('#1153 uninstall and the views the install created', () => {
  it('removes every untouched pack view, keeps the default view, and the database still has a view', async () => {
    const ws = await newWs();
    await install(ws, manifestWithViews('views-clean'));
    const db = await ticketsDb(ws);
    expect(names(await viewsOf(ws, db))).toEqual(['All records', 'Board', 'Everything']);

    const out = await uninstall(ws, 'views-clean');
    expect(out.removed.filter((r) => r.kind === 'view').map((r) => r.name).sort()).toEqual(['Tickets.Board', 'Tickets.Everything']);
    expect(out.kept.filter((k) => k.kind === 'view')).toEqual([]);
    const after = await viewsOf(ws, db);
    expect(names(after)).toEqual(['All records']);
    expect(after[0]!.isDefault).toBe(true);
  }, 90_000);

  it('keeps a view the person edited and says so; removes its untouched siblings; leaves their own view and the data', async () => {
    const ws = await newWs();
    await install(ws, manifestWithViews('views-edited'));
    const db = await ticketsDb(ws);
    const live = await viewsOf(ws, db);

    const rename = await as('PATCH', `/workspaces/${ws}/databases/${db}/views/${live.find((v) => v.name === 'Everything')!.id}`, { name: 'Everything (mine)' });
    expect(rename.statusCode, rename.body).toBe(200);
    const own = await as('POST', `/workspaces/${ws}/databases/${db}/views`, { name: 'My own table', type: 'table', config: {} });
    expect(own.statusCode, own.body).toBe(201);

    const out = await uninstall(ws, 'views-edited');
    expect(out.removed.filter((r) => r.kind === 'view').map((r) => r.name)).toEqual(['Tickets.Board']);
    const keptView = out.kept.find((k) => k.kind === 'view')!;
    expect(keptView.name).toBe('Tickets.Everything');
    expect(keptView.reason).toBe('Changed since install.');
    expect(names(await viewsOf(ws, db))).toEqual(['All records', 'Everything (mine)', 'My own table']);
    // The sample record the pack seeded is still there: uninstall never deletes data.
    const records = await as('GET', `/workspaces/${ws}/databases/${db}/records`);
    expect(records.json().data.length).toBeGreaterThan(0);
  }, 90_000);

  it('a view the install only REUSED (it existed before) is never removed; another pack\'s views are untouched', async () => {
    const ws = await newWs();
    await install(ws, manifestWithViews('views-first'));
    const db = await ticketsDb(ws);
    // A second pack lands on the same database and finds "Everything" and "Board" already there.
    const second = manifestWithViews('views-second');
    await install(ws, second, REUSE);

    const out = await uninstall(ws, 'views-second');
    expect(out.removed.filter((r) => r.kind === 'view')).toEqual([]);
    expect(out.kept.filter((k) => k.kind === 'view').every((k) => k.reason === 'Existed before the install.')).toBe(true);
    expect(names(await viewsOf(ws, db))).toEqual(['All records', 'Board', 'Everything']);

    // The first pack still owns them and removes them cleanly.
    const first = await uninstall(ws, 'views-first');
    expect(first.removed.filter((r) => r.kind === 'view').map((r) => r.name).sort()).toEqual(['Tickets.Board', 'Tickets.Everything']);
  }, 120_000);

  it('a re-install after uninstall works and brings the views back', async () => {
    const ws = await newWs();
    const m = manifestWithViews('views-again');
    await install(ws, m);
    await uninstall(ws, 'views-again');
    await install(ws, m, REUSE);
    const db = await ticketsDb(ws);
    expect(names(await viewsOf(ws, db))).toEqual(['All records', 'Board', 'Everything']);
    const out = await uninstall(ws, 'views-again');
    expect(out.removed.filter((r) => r.kind === 'view')).toHaveLength(2);
  }, 120_000);
});
