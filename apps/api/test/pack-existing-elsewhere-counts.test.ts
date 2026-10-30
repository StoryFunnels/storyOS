import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DatabasesService } from '../src/databases/databases.service';

/**
 * Ticket #1169 — a preview database's `existing_elsewhere` (#1156) also says how many records the reusable database holds
 * (`record_count`) and which fields the pack would add to it (`fields_added`), so the install review needs no second call.
 *
 * Both are present ONLY when the database is reusable and the person can edit it (the one case `database_id` is present). Anything else
 * (type clash, two matches, no edit access, no access at all) carries nothing extra, so a count can never confirm a database the review
 * is deliberately not naming.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const newSpace = async (ws: string, name: string) => (await as('POST', `/workspaces/${ws}/spaces`, { name })).json().id as string;
const preview = (ws: string, manifest: unknown, resolutions?: unknown, token = admin.token) =>
  as('POST', `/workspaces/${ws}/packs/preview`, { manifest, ...(resolutions ? { resolutions } : {}) }, token);

/** A one-database pack: Clients with Industry (text), Budget (number), Notes (rich_text). */
const pack = (overrides: Array<{ name: string; type: string }> = [{ name: 'Industry', type: 'text' }, { name: 'Budget', type: 'number' }, { name: 'Notes', type: 'rich_text' }]) => ({
  format_version: 1,
  slug: 'elsewhere-counts',
  name: 'Elsewhere Counts',
  version: '1.0.0',
  summary: 'A pack whose Clients may already exist elsewhere',
  databases: [{ action: 'create', name: 'Clients', space: 'Counts Pack Space', fields: overrides }],
});

/** A Clients database in its own space, with `fields` (display name + type) and `records` live records, then `trashed` more moved to the trash. */
async function seedClients(ws: string, spaceName: string, fields: Array<{ name: string; type: string }>, records: number, trashed = 0) {
  const space = await newSpace(ws, spaceName);
  const made = await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Clients' });
  expect(made.statusCode, made.body).toBe(201);
  const id = made.json().id as string;
  for (const f of fields) {
    const r = await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: f.name, type: f.type });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }
  const toTrash: string[] = [];
  for (let i = 0; i < records + trashed; i++) {
    const r = await as('POST', `/workspaces/${ws}/databases/${id}/records`, { values: { name: `Client ${i}` } });
    expect(r.statusCode, r.body).toBe(201);
    if (i >= records) toTrash.push(r.json().id as string);
  }
  for (const rec of toTrash) {
    const d = await as('DELETE', `/workspaces/${ws}/databases/${id}/records/${rec}`);
    expect(d.statusCode, d.body).toBeLessThan(300);
  }
  return { id, space };
}
const clientsItem = (body: { databases: Array<{ name: string; existing_elsewhere?: Record<string, unknown> }> }) => body.databases.find((d) => d.name === 'Clients')!;

/** Make the installer's access to the named databases read-only, or hide them from the installer altogether (the same seam #1156's tests use). */
function limitAccess(ids: string[], mode: 'viewer' | 'hidden') {
  const dbs = app.get(DatabasesService, { strict: false });
  const real = dbs.list.bind(dbs);
  return vi.spyOn(dbs, 'list').mockImplementation((async (...a: Parameters<typeof dbs.list>) => {
    const all = await real(...a);
    if (mode === 'hidden') return all.filter((d) => !ids.includes(d.id));
    return all.map((d) => (ids.includes(d.id) ? { ...d, my_access: 'viewer' as const } : d));
  }) as never);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Elsewhere Counts');
  guest = await signUpUser(app, 'Elsewhere Counts Guest');
}, 120_000);
afterAll(async () => {
  await app?.close();
});

describe('record_count and fields_added on a reusable existing_elsewhere (#1169)', () => {
  it('counts the live records (the trashed ones are not records any more) and lists exactly the fields the pack would add', async () => {
    const ws = await newWs('Counts');
    // 4 live + 2 trashed; Industry already exists with the pack's type, so only Budget and Notes would be added.
    const live = await seedClients(ws, 'Client Work', [{ name: 'Industry', type: 'text' }], 4, 2);
    const res = await preview(ws, pack());
    expect(res.statusCode, res.body).toBe(201);
    const item = clientsItem(res.json());
    expect(item.action, 'the pack still creates its own unless the person chooses reuse').toBe('create');
    expect(item.existing_elsewhere).toEqual({
      database_id: live.id,
      space_name: 'Client Work',
      adopted: false,
      reusable: true,
      record_count: 4,
      fields_added: [
        { name: 'Budget', type: 'number' },
        { name: 'Notes', type: 'rich_text' },
      ],
    });
  });

  it('zero records is a count of 0, present (not absent), and a database with every field already says so with []', async () => {
    const ws = await newWs('Zero');
    await seedClients(ws, 'Client Work', [{ name: 'Industry', type: 'text' }, { name: 'Budget', type: 'number' }, { name: 'Notes', type: 'rich_text' }], 0);
    const hint = clientsItem((await preview(ws, pack())).json()).existing_elsewhere!;
    expect(hint.reusable).toBe(true);
    expect(hint.record_count).toBe(0);
    expect(hint.fields_added).toEqual([]);
  });

  it('a field of the same name but another type is not counted as added (and makes the database not reusable, so no count at all)', async () => {
    const ws = await newWs('Clash');
    await seedClients(ws, 'Client Work', [{ name: 'Budget', type: 'text' }], 3);
    const hint = clientsItem((await preview(ws, pack())).json()).existing_elsewhere!;
    expect(hint.reusable).toBe(false);
    expect(hint.reason).toMatch(/Budget is a text here but this pack needs a number/);
    // the one editable match IS named (as #1156 specifies), but it carries no count and no field list: those are for a database that can be used
    expect(Object.keys(hint).sort(), 'nothing extra when not reusable').toEqual(['adopted', 'database_id', 'reason', 'reusable', 'space_name']);
  });

  it('with reuse chosen (adopted) the same count and fields come back, and agree with the item\'s own gains', async () => {
    const ws = await newWs('Adopted');
    const live = await seedClients(ws, 'Client Work', [{ name: 'Industry', type: 'text' }], 3);
    const item = clientsItem((await preview(ws, pack(), { Clients: { action: 'reuse' } })).json()) as unknown as {
      existing_elsewhere: Record<string, unknown>;
      gains?: { fields: Array<{ name: string; type: string }> };
    };
    expect(item.existing_elsewhere).toMatchObject({ database_id: live.id, adopted: true, reusable: true, record_count: 3 });
    expect(item.gains, 'an adopted database carries gains, and fields_added is the same list').toBeTruthy();
    expect(item.existing_elsewhere.fields_added).toEqual(item.gains!.fields);
  });

  it('no same-named database anywhere: no existing_elsewhere at all, as before', async () => {
    const ws = await newWs('Nothing elsewhere');
    expect(clientsItem((await preview(ws, pack())).json()).existing_elsewhere).toBeUndefined();
  });
});

describe('who may see the count (#1169)', () => {
  it('two editable matches: no count, no fields, no ids (ambiguous)', async () => {
    const ws = await newWs('Two matches');
    await seedClients(ws, 'Alpha', [], 5);
    await seedClients(ws, 'Bravo', [], 7);
    const hint = clientsItem((await preview(ws, pack())).json()).existing_elsewhere!;
    expect(hint.reusable).toBe(false);
    expect(Object.keys(hint).sort()).toEqual(['adopted', 'reason', 'reusable']);
  });

  it('a database the person can only READ: exactly the wording for one that is not there, and no count', async () => {
    const ws = await newWs('Read only');
    const live = await seedClients(ws, 'Client Work', [], 9);
    const spy = limitAccess([live.id], 'viewer');
    try {
      const res = await preview(ws, pack());
      expect(clientsItem(res.json()).existing_elsewhere).toEqual({ adopted: false, reusable: false, reason: 'There is no Clients database you can edit.' });
      expect(res.body).not.toMatch(/record_count|fields_added/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a database the person cannot see: no object, no count, no trace of its name or space', async () => {
    const ws = await newWs('Hidden');
    const live = await seedClients(ws, 'Hidden Space', [], 9);
    const spy = limitAccess([live.id], 'hidden');
    try {
      const res = await preview(ws, pack());
      expect(clientsItem(res.json()).existing_elsewhere).toBeUndefined();
      expect(res.body).not.toMatch(/record_count|fields_added|Hidden Space/);
    } finally {
      spy.mockRestore();
    }
  });

  it('a guest (the only role with partial access) cannot preview at all, so no count reaches them', async () => {
    const ws = await newWs('Guest');
    const live = await seedClients(ws, 'Client Work', [], 6);
    const visible = await newSpace(ws, 'Shared with the guest');
    const invite = await as('POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ space_id: visible, role: 'viewer' }] });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as('POST', '/invites/accept', { token }, guest.token);
    const res = await preview(ws, pack(), undefined, guest.token);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(live.id);
    expect(res.body).not.toMatch(/record_count/);
  });
});
