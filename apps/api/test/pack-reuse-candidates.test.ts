import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DatabasesService } from '../src/databases/databases.service';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { databases } from '../src/db/schema';

/**
 * Ticket #1176 - with SEVERAL same-named databases the person picks WHICH one a pack reuses: `resolutions[name] = {action:'reuse',
 * database_id}`, and the preview lists the `candidates` (editable ones only, each with its own verdict). The id must be a candidate:
 * a read-only, built-in, personal-space, Linear-mirrored or type-clashing database is never adopted, and an unknown id reads as "not there".
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const newSpace = async (ws: string, name: string) => (await as('POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
const manifest = (slug = 'reuse-candidates') => ({
  format_version: 1,
  slug,
  name: 'Reuse Candidates',
  version: '1.0.0',
  summary: 'A pack whose Clients may exist in several spaces',
  databases: [{ action: 'create', name: 'Clients', space: 'Candidates Pack Space', fields: [{ name: 'Industry', type: 'text' }, { name: 'Budget', type: 'number' }] }],
});
const preview = (ws: string, resolutions?: unknown, token = admin.token, slug?: string) =>
  as('POST', `/workspaces/${ws}/packs/preview`, { manifest: manifest(slug), ...(resolutions ? { resolutions } : {}) }, token);
const install = (ws: string, resolutions?: unknown, slug?: string) =>
  as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest(slug), ...(resolutions ? { resolutions } : {}) });
const reuse = (database_id?: string) => ({ Clients: { action: 'reuse', ...(database_id ? { database_id } : {}) } });

async function seedClients(ws: string, spaceName: string, fields: Array<{ name: string; type: string }>, records = 0) {
  const space = await newSpace(ws, spaceName);
  const made = await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Clients' });
  expect(made.statusCode, made.body).toBe(201);
  const id = made.json().id as string;
  for (const f of fields) {
    const r = await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: f.name, type: f.type });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }
  for (let i = 0; i < records; i++) {
    expect((await as('POST', `/workspaces/${ws}/databases/${id}/records`, { values: { name: `Client ${i}` } })).statusCode).toBe(201);
  }
  return { id, space };
}
const hintOf = (body: { databases: Array<{ name: string; existing_elsewhere?: Record<string, unknown> }> }) => body.databases.find((d) => d.name === 'Clients')!.existing_elsewhere as
  | { database_id?: string; adopted: boolean; reusable: boolean; reason?: string; candidates?: Array<Record<string, unknown>> }
  | undefined;
const fieldsOf = async (ws: string, id: string) => ((await as('GET', `/workspaces/${ws}/databases/${id}`)).json().fields as Array<{ displayName: string }>).map((f) => f.displayName).sort();
const clientsDbs = async (ws: string) =>
  ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name === 'Clients');

function limitAccess(ids: string[]) {
  const dbs = app.get(DatabasesService, { strict: false });
  const real = dbs.list.bind(dbs);
  return vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) => {
    const all = await real(...a);
    return all.map((d) => (ids.includes(d.id) ? { ...d, my_access: 'viewer' as const } : d));
  }) as never);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Reuse Candidates');
  guest = await signUpUser(app, 'Reuse Candidates Guest');
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('candidates in the preview (#1176)', () => {
  it('two same-named editable databases: both listed with space, reusable, count and fields; the ambiguous object still works for older clients', async () => {
    const ws = await newWs('Two');
    const a = await seedClients(ws, 'Alpha', [{ name: 'Industry', type: 'text' }], 5);
    const b = await seedClients(ws, 'Bravo', [], 2);
    const hint = hintOf((await preview(ws)).json())!;
    expect(hint.reusable).toBe(false);
    expect(hint.reason).toBe('Can\'t use one: you have more than one Clients database (in Alpha and Bravo). Create a new one here.');
    expect(hint.database_id, 'the old ambiguous shape: no single id').toBeUndefined();
    const byId = new Map(hint.candidates!.map((c) => [c.database_id as string, c]));
    expect(byId.get(a.id)).toEqual({ database_id: a.id, space_name: 'Alpha', reusable: true, record_count: 5, fields_added: [{ name: 'Budget', type: 'number' }] });
    expect(byId.get(b.id)).toEqual({
      database_id: b.id, space_name: 'Bravo', reusable: true, record_count: 2,
      fields_added: [{ name: 'Industry', type: 'text' }, { name: 'Budget', type: 'number' }],
    });
    expect(hint.candidates).toHaveLength(2);
  });

  it('a type-clash candidate is listed reusable:false with the reason (field and both types) and no count', async () => {
    const ws = await newWs('Clash');
    const ok = await seedClients(ws, 'Alpha', [], 1);
    const bad = await seedClients(ws, 'Bravo', [{ name: 'Budget', type: 'text' }], 9);
    const cands = hintOf((await preview(ws)).json())!.candidates!;
    expect(cands.find((c) => c.database_id === ok.id)!.reusable).toBe(true);
    expect(cands.find((c) => c.database_id === bad.id)).toEqual({
      database_id: bad.id, space_name: 'Bravo', reusable: false, reason: 'Budget is a text here but this pack needs a number.',
    });
  });

  it('a single candidate keeps the old fields and also appears in candidates', async () => {
    const ws = await newWs('Single');
    const one = await seedClients(ws, 'Alpha', [], 3);
    const hint = hintOf((await preview(ws)).json())!;
    expect(hint).toMatchObject({ database_id: one.id, space_name: 'Alpha', adopted: false, reusable: true, record_count: 3 });
    expect(hint.candidates).toEqual([expect.objectContaining({ database_id: one.id, reusable: true, record_count: 3 })]);
  });

  it('a read-only database is not listed (and its id is not in the response)', async () => {
    const ws = await newWs('Viewer');
    const ro = await seedClients(ws, 'Alpha', [], 4);
    const rw = await seedClients(ws, 'Bravo', [], 1);
    const spy = limitAccess([ro.id]);
    try {
      const res = await preview(ws);
      expect(res.body).not.toContain(ro.id);
      const hint = hintOf(res.json())!;
      expect(hint.candidates!.map((c) => c.database_id)).toEqual([rw.id]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a database in a personal space is never a candidate', async () => {
    const ws = await newWs('Personal');
    const personal = (await as('POST', `/workspaces/${ws}/spaces/personal`, {})).json() as { id: string };
    const db = app.get<Db>(DB);
    const [row] = await db.insert(databases).values({ workspaceId: ws, spaceId: personal.id, name: 'Clients', apiSlug: 'clients-personal' }).returning();
    const shared = await seedClients(ws, 'Alpha', [], 1);
    const res = await preview(ws);
    expect(res.body).not.toContain(row!.id);
    expect(hintOf(res.json())).toMatchObject({ database_id: shared.id, reusable: true });
    const sent = await install(ws, reuse(row!.id));
    expect(sent.statusCode, sent.body).toBe(422);
    expect(sent.json().error.message).toBe('There is no Clients database you can edit.');
  });

  it('a Linear mirror (the importer\'s Linear ID field) is listed reusable:false "synced from Linear" and refused if sent', async () => {
    const ws = await newWs('Linear');
    const mirror = await seedClients(ws, 'Engineering (Linear)', [{ name: 'Linear ID', type: 'text' }], 800);
    const mine = await seedClients(ws, 'StoryOS', [], 12);
    const hint = hintOf((await preview(ws)).json())!;
    const m = hint.candidates!.find((c) => c.database_id === mirror.id)!;
    expect(m.reusable).toBe(false);
    expect(m.reason).toMatch(/synced from Linear/);
    expect(m.record_count, 'no count for what cannot be used').toBeUndefined();
    expect(hint.candidates!.find((c) => c.database_id === mine.id)!.reusable).toBe(true);
    const before = await fieldsOf(ws, mirror.id);
    const res = await install(ws, reuse(mirror.id));
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/synced from Linear/);
    expect(await fieldsOf(ws, mirror.id), 'untouched').toEqual(before);
  });

  it('a lone Linear mirror is not adoptable even without a database_id', async () => {
    const ws = await newWs('Lone mirror');
    const mirror = await seedClients(ws, 'Engineering (Linear)', [{ name: 'Linear ID', type: 'text' }], 3);
    expect(hintOf((await preview(ws)).json())).toMatchObject({ database_id: mirror.id, reusable: false });
    expect((await install(ws, reuse())).statusCode).toBe(422);
  });

  it('a guest cannot preview at all, so no candidate reaches them', async () => {
    const ws = await newWs('Guest');
    const live = await seedClients(ws, 'Alpha', [], 2);
    const visible = await newSpace(ws, 'Shared');
    const invite = await as('POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ space_id: visible, role: 'viewer' }] });
    await as('POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! }, guest.token);
    const res = await preview(ws, undefined, guest.token);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(live.id);
  });
});

describe('picking one with database_id (#1176)', () => {
  it('adopts EXACTLY the chosen database; the other is untouched; preview with the same choice shows it adopted', async () => {
    const ws = await newWs('Pick');
    const a = await seedClients(ws, 'Alpha', [], 1);
    const b = await seedClients(ws, 'Bravo', [], 1);
    const shown = hintOf((await preview(ws, reuse(b.id))).json())!;
    expect(shown).toMatchObject({ database_id: b.id, adopted: true, reusable: true });
    const res = await install(ws, reuse(b.id));
    expect(res.statusCode, res.body).toBe(201);
    expect(await fieldsOf(ws, b.id)).toEqual(expect.arrayContaining(['Industry', 'Budget']));
    expect(await fieldsOf(ws, a.id), 'the other Clients is untouched').not.toContain('Budget');
    expect((await clientsDbs(ws)).length, 'no third Clients was made').toBe(2);
    expect((res.json().databases as Array<{ id: string; action: string }>).find((d) => d.id === b.id)!.action).toBe('reused');
  });

  it('no database_id with two candidates is the ambiguous refusal, as before', async () => {
    const ws = await newWs('Ambiguous');
    await seedClients(ws, 'Alpha', [], 1);
    await seedClients(ws, 'Bravo', [], 1);
    const res = await install(ws, reuse());
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/more than one Clients database \(in Alpha and Bravo\)/);
  });

  it('no database_id with ONE candidate adopts it, as before', async () => {
    const ws = await newWs('One');
    const only = await seedClients(ws, 'Alpha', [], 1);
    expect((await install(ws, reuse())).statusCode).toBe(201);
    expect(await fieldsOf(ws, only.id)).toContain('Budget');
  });

  it('a type-clash candidate sent by id is refused 422 with its reason, and nothing is changed', async () => {
    const ws = await newWs('Clash install');
    await seedClients(ws, 'Alpha', [], 1);
    const bad = await seedClients(ws, 'Bravo', [{ name: 'Budget', type: 'text' }], 1);
    const res = await install(ws, reuse(bad.id));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe('Budget is a text here but this pack needs a number.');
    expect(await fieldsOf(ws, bad.id)).not.toContain('Industry');
  });

  it('an unknown id, a read-only database\'s id and another workspace\'s id are all the same 422, with no leak', async () => {
    const ws = await newWs('Unknown');
    const ro = await seedClients(ws, 'Alpha', [], 1);
    await seedClients(ws, 'Bravo', [], 1);
    const other = await newWs('Elsewhere');
    const foreign = await seedClients(other, 'Zed', [], 1);
    const wording = 'There is no Clients database you can edit.';
    const unknown = await install(ws, reuse('00000000-0000-4000-8000-000000000000'));
    const foreignRes = await install(ws, reuse(foreign.id));
    const spy = limitAccess([ro.id]);
    let viewer;
    try {
      viewer = await install(ws, reuse(ro.id));
    } finally {
      spy.mockRestore();
    }
    for (const r of [unknown, foreignRes, viewer]) {
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error.message).toBe(wording);
    }
    expect(await fieldsOf(ws, ro.id)).not.toContain('Budget');
  });

  it('a malformed database_id, or database_id on a non-reuse action, is refused by the schema', async () => {
    const ws = await newWs('Schema');
    await seedClients(ws, 'Alpha', [], 1);
    expect((await install(ws, { Clients: { action: 'reuse', database_id: 'nope' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await install(ws, { Clients: { action: 'skip', database_id: '00000000-0000-4000-8000-000000000000' } })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a built-in (system) database id is refused and not changed', async () => {
    const ws = await newWs('System');
    expect((await as('POST', `/workspaces/${ws}/agents/ensure`)).statusCode).toBeLessThan(300);
    const members = ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; isSystem?: boolean }>).find((d) => d.isSystem && d.name === 'Members')!;
    const m = { ...manifest('sys-pick'), databases: [{ action: 'create', name: 'Members', space: 'Sys Pack Space', fields: [{ name: 'Pack field', type: 'text' }] }] };
    const before = await fieldsOf(ws, members.id);
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, resolutions: { Members: { action: 'reuse', database_id: members.id } } });
    expect(res.statusCode, res.body).toBe(422);
    expect(await fieldsOf(ws, members.id)).toEqual(before);
  });

  it('re-install is idempotent via the tracked id (database_id ignored once tracked), and uninstall leaves the adopted database and its records', async () => {
    const ws = await newWs('Idempotent');
    await seedClients(ws, 'Alpha', [], 1);
    const b = await seedClients(ws, 'Bravo', [], 3);
    expect((await install(ws, reuse(b.id))).statusCode).toBe(201);
    const again = await install(ws);
    expect(again.statusCode, again.body).toBeLessThan(300);
    expect((await clientsDbs(ws)).length, 'still two').toBe(2);
    const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    const un = await as('POST', `/workspaces/${ws}/packs/${list.find((i) => i.slug === 'reuse-candidates')!.id}/uninstall`);
    expect(un.statusCode, un.body).toBeLessThan(300);
    expect((await clientsDbs(ws)).map((d) => d.id), 'the adopted database survives uninstall').toContain(b.id);
    const recs = (await as('GET', `/workspaces/${ws}/databases/${b.id}/records?limit=50`)).json() as { data: unknown[] };
    expect(recs.data.length).toBe(3);
  });
});
