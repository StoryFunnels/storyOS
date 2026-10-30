import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DatabasesService } from '../src/databases/databases.service';

/**
 * #1157 — a pack install records the databases it created or adopted (pack_install_items). Since #1156 matching is by name inside ONE
 * space, so a database moved out of that space (or a space renamed) was not found again and a re-install built a second set. A
 * re-install of a pack the workspace has installed now finds its databases by the TRACKED id first, wherever they live now.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let pack: Manifest;

interface Manifest {
  slug: string;
  name: string;
  databases: Array<{ name: string; space: string }>;
  relations: Array<{ from: string; to: string; from_field: string }>;
  agents?: unknown[];
}
const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const newSpace = async (ws: string, name: string) => (await as('POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
const dbsOf = async (ws: string) =>
  ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name !== 'Members');
const install = (ws: string, manifest: unknown, target?: string) =>
  as('POST', `/workspaces/${ws}/packs/install`, { manifest, ...(target ? { target_space_id: target } : {}) });
const preview = (ws: string, manifest: unknown, target?: string) =>
  as('POST', `/workspaces/${ws}/packs/preview`, { manifest, ...(target ? { target_space_id: target } : {}) });
const move = (ws: string, id: string, spaceId: string) => as('PATCH', `/workspaces/${ws}/databases/${id}`, { space_id: spaceId });
const idOf = async (ws: string, name: string, space?: string) =>
  (await dbsOf(ws)).filter((d) => d.name === name && (!space || d.spaceId === space)).map((d) => d.id);
const detail = async (ws: string, id: string) =>
  (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: Array<{ displayName: string; type: string; relation?: { target_database_id: string } }> };
const countOf = async (ws: string) => (await dbsOf(ws)).length;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Provenance');
  const list = (await as('GET', '/packs/registry')).json() as { data?: Array<{ slug: string }> } | Array<{ slug: string }>;
  for (const { slug } of Array.isArray(list) ? list : list.data ?? []) {
    const m = ((await as('GET', `/packs/registry/${slug}`)).json() as { manifest?: Manifest }).manifest;
    if (!m) continue;
    const spaces = new Set(m.databases.map((d) => d.space.trim().toLowerCase()));
    const names = new Set(m.databases.map((d) => d.name.trim().toLowerCase()));
    if (spaces.size === 1 && m.databases.length >= 2 && m.relations?.length && !m.agents?.length && names.size === m.databases.length) { pack = m; break; }
  }
  expect(pack).toBeTruthy();
}, 180_000);
afterAll(async () => { await app.close(); });

describe('#1157 re-install finds the pack\'s databases by what the install tracked, wherever they live now', () => {
  it('a database moved to another space is found again: no second set, relations intact, items still tracked', async () => {
    const ws = await newWs('Moved');
    const home = await newSpace(ws, 'Pack home');
    const elsewhere = await newSpace(ws, 'Moved to');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    const moved = pack.databases[0]!.name;
    const movedId = (await idOf(ws, moved, home))[0]!;
    expect((await move(ws, movedId, elsewhere)).statusCode).toBe(200);
    const before = await countOf(ws);

    const pv = (await preview(ws, pack, home)).json().databases as Array<{ name: string; action: string }>;
    expect(pv.find((d) => d.name === moved)!.action, 'preview tells the same story as the install: reuse, not create').toBe('reuse');

    const again = await install(ws, pack, home);
    expect(again.statusCode, again.body).toBe(201);
    expect(await countOf(ws), 'no second set').toBe(before);
    expect(await idOf(ws, moved)).toEqual([movedId]);
    expect((again.json().databases as Array<{ name: string; action: string; id: string }>).find((d) => d.name === moved)).toMatchObject({ action: 'reused', id: movedId });
    const rel = pack.relations.find((r) => r.from === moved || r.to === moved)!;
    const fromId = (await idOf(ws, rel.from))[0]!;
    const field = (await detail(ws, fromId)).fields.find((f) => f.type === 'relation' && f.displayName === rel.from_field);
    expect(field!.relation!.target_database_id).toBe((await idOf(ws, rel.to))[0]);
    // still tracked: a third install is still clean
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    expect(await countOf(ws)).toBe(before);
  });

  it('every database moved out, with no target: still found (the manifest\'s own space is not asked for)', async () => {
    const ws = await newWs('All moved');
    const sink = await newSpace(ws, 'Sink');
    expect((await install(ws, pack)).statusCode).toBe(201);
    for (const d of pack.databases) expect((await move(ws, (await idOf(ws, d.name))[0]!, sink)).statusCode).toBe(200);
    const before = await countOf(ws);
    expect((await install(ws, pack)).statusCode).toBe(201);
    expect(await countOf(ws)).toBe(before);
  });

  it('the pack\'s space was renamed (no target): no second set, and no second space', async () => {
    const ws = await newWs('Renamed');
    const res = await install(ws, pack);
    expect(res.statusCode, res.body).toBe(201);
    const spaceId = (res.json().spaces as Array<{ id: string }>)[0]!.id;
    const ren = await as('PATCH', `/workspaces/${ws}/spaces/${spaceId}`, { name: 'Renamed home' });
    expect(ren.statusCode, ren.body).toBeLessThan(300);
    const before = await countOf(ws);
    const spacesBefore = ((await as('GET', `/workspaces/${ws}/spaces`)).json() as unknown[]).length;
    expect((await install(ws, pack)).statusCode).toBe(201);
    expect(await countOf(ws), 'no second set').toBe(before);
    expect(((await as('GET', `/workspaces/${ws}/spaces`)).json() as unknown[]).length, 'no new empty space').toBe(spacesBefore);
  });

  it('a tracked database in the TRASH is not resurrected: the install falls back to name-in-space and builds a fresh one', async () => {
    const ws = await newWs('Trashed');
    const home = await newSpace(ws, 'Trash home');
    const elsewhere = await newSpace(ws, 'Trash elsewhere');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    const name = pack.databases[0]!.name;
    const id = (await idOf(ws, name, home))[0]!;
    await move(ws, id, elsewhere);
    const del = await as('DELETE', `/workspaces/${ws}/databases/${id}`, { confirm: name, sever_relations: true });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const again = await install(ws, pack, home);
    expect(again.statusCode, again.body).toBe(201);
    expect(await idOf(ws, name), 'one live database of that name, a new one').toHaveLength(1);
    expect(await idOf(ws, name, home)).toHaveLength(1);
  });

  it('a tracked database the installer cannot EDIT is not used and not described: same outcome as if it were not there', async () => {
    const ws = await newWs('No edit');
    const home = await newSpace(ws, 'No edit home');
    const elsewhere = await newSpace(ws, 'No edit elsewhere');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    const name = pack.databases[0]!.name;
    const id = (await idOf(ws, name, home))[0]!;
    await move(ws, id, elsewhere);
    const dbs = app.get(DatabasesService, { strict: false });
    const real = dbs.list.bind(dbs);
    const spy = vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) =>
      (await real(...a)).map((d) => (d.id === id ? { ...d, my_access: 'viewer' as const } : d))) as never);
    try {
      const pv = await preview(ws, pack, home);
      expect(pv.statusCode, pv.body).toBeLessThan(300);
      expect(pv.json().databases.find((d: { name: string }) => d.name === name).action, 'not usable, so would be created').toBe('create');
      expect(pv.body, 'no id or space of the one it cannot edit').not.toContain(id);
      expect(pv.body).not.toContain('No edit elsewhere');
      const res = await install(ws, pack, home);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.body).not.toContain('No edit elsewhere');
    } finally {
      spy.mockRestore();
    }
    expect((await idOf(ws, name, elsewhere))[0], 'the moved one is untouched where it is').toBe(id);
  });
});

describe('#1157 an explicit target is respected', () => {
  it('installing into a DIFFERENT space than where the pack lives builds a new set there (as #1156)', async () => {
    const ws = await newWs('Different target');
    const a = await newSpace(ws, 'Space A');
    const b = await newSpace(ws, 'Space B');
    expect((await install(ws, pack, a)).statusCode).toBe(201);
    const res = await install(ws, pack, b);
    expect(res.statusCode, res.body).toBe(201);
    for (const d of pack.databases) expect(await idOf(ws, d.name, b), `${d.name} is in B`).toHaveLength(1);
  });

  it('into the home space while only SOME databases moved: the ones that stayed and the ones that left are both found', async () => {
    const ws = await newWs('Partly moved');
    const home = await newSpace(ws, 'Partly home');
    const away = await newSpace(ws, 'Partly away');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    await move(ws, (await idOf(ws, pack.databases[0]!.name, home))[0]!, away);
    const before = await countOf(ws);
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    expect(await countOf(ws)).toBe(before);
  });
});

describe('#1157 what must keep working (#1156, #1095)', () => {
  it('an untouched re-install is idempotent; a same-named database in the target that this pack did not put there is still a 409', async () => {
    const ws = await newWs('Keep working');
    const home = await newSpace(ws, 'Keep home');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    const first = (await dbsOf(ws)).map((d) => d.id).sort();
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    expect((await dbsOf(ws)).map((d) => d.id).sort()).toEqual(first);

    const ws2 = await newWs('Keep 409');
    const target = await newSpace(ws2, 'Has one');
    await as('POST', `/workspaces/${ws2}/databases`, { space_id: target, name: pack.databases[0]!.name });
    expect((await install(ws2, pack, target)).statusCode).toBe(409);
  });

  it('a lookalike in the home space does not beat the tracked one that was moved away', async () => {
    const ws = await newWs('Lookalike vs tracked');
    const home = await newSpace(ws, 'LvT home');
    const away = await newSpace(ws, 'LvT away');
    expect((await install(ws, pack, home)).statusCode).toBe(201);
    const name = pack.databases[0]!.name;
    const tracked = (await idOf(ws, name, home))[0]!;
    await move(ws, tracked, away);
    const hand = await as('POST', `/workspaces/${ws}/databases`, { space_id: home, name });
    expect(hand.statusCode).toBe(201);
    // the preview reads the views of the SAME database the install will use (the tracked one has the pack's views, the lookalike none)
    const pvViews = ((await preview(ws, pack, home)).json().views as Array<{ name: string; action: string }>).filter((v) => v.name.startsWith(`${name}.`));
    expect(pvViews.length, 'the pack has views on this database').toBeGreaterThan(0);
    expect(pvViews.filter((v) => v.action === 'create'), 'none of them would be created again').toEqual([]);
    const res = await install(ws, pack, home);
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().databases as Array<{ name: string; id: string }>).find((d) => d.name === name)!.id, 'the tracked one, not the lookalike').toBe(tracked);
    expect(await idOf(ws, name), 'nothing new was created').toHaveLength(2);
  });
});
