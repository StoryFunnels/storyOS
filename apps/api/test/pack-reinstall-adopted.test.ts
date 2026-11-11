import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { STARTER_PACKS } from '../src/packs/starter-packs';

/**
 * ticket #1222 - a pack that ADOPTS a database must leave it exactly as it was when the install fails, and a re-install onto an adopted
 * database must be idempotent for what it already added. A same-named field the person made is kept (and reported), never duplicated,
 * and an incompatible same-named field fails loudly with a message that names the field and why.
 */
let app: NestFastifyApplication;
let admin: { token: string };
const { pool } = connectTestDb();

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;
const manifest = (slug = 'adopted-reinstall') => ({
  format_version: 1,
  slug,
  name: 'Adopted Reinstall',
  version: '1.0.0',
  summary: 'A pack whose Issues may already exist',
  databases: [
    {
      action: 'create',
      name: 'Issues',
      space: 'Reinstall Pack Space',
      fields: [
        { name: 'Priority', type: 'select', options: [{ label: 'High' }, { label: 'Low' }] },
        { name: 'Due Date', type: 'date' },
      ],
    },
    { action: 'create', name: 'Sprints', space: 'Reinstall Pack Space', fields: [{ name: 'Goal', type: 'text' }] },
  ],
  relations: [{ from: 'Issues', to: 'Sprints', cardinality: 'one_to_many', from_field: 'Sprint', to_field: 'Issues' }],
});
const install = (ws: string, resolutions?: unknown) =>
  as('POST', `/workspaces/${ws}/packs/install`, { manifest: manifest(), ...(resolutions ? { resolutions } : {}) });

async function seedIssues(ws: string, fields: Array<{ name: string; type: string }>, spaceName = 'Elsewhere') {
  const space = (await as('POST', `/workspaces/${ws}/spaces`, { name: spaceName })).json().id as string;
  const made = await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Issues' });
  expect(made.statusCode, made.body).toBe(201);
  const id = made.json().id as string;
  for (const f of fields) {
    const r = await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: f.name, type: f.type });
    expect(r.statusCode, r.body).toBeLessThan(300);
  }
  return id;
}
/** Every field row of a database INCLUDING soft-deleted ones: a rollback that only hides rows leaves the names behind. */
const rawFields = async (id: string) =>
  (await pool.query('select display_name, type, deleted_at is not null as deleted from fields where database_id=$1 order by display_name', [id])).rows as Array<{
    display_name: string;
    type: string;
    deleted: boolean;
  }>;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Reinstall Adopted');
}, 120_000);
afterAll(async () => {
  await app?.close();
  await pool.end();
});

describe('ticket #1222 - installs onto an adopted database', () => {
  it('a failed install (a same-named TEXT field blocks the Sprint relation) leaves the adopted database exactly as it was, soft-deleted rows included', async () => {
    const ws = await newWs('Failed adopt');
    const id = await seedIssues(ws, [{ name: 'Sprint', type: 'text' }]);
    const before = await rawFields(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await install(ws, { Issues: { action: 'reuse', database_id: id } });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error.message).toMatch(/Sprint/);
      expect(await rawFields(id), `attempt ${attempt}`).toEqual(before);
    }
  });

  it('the built-in Dev Project OS onto an Issues with a text "Sprint" field: 422 and the adopted database is untouched, twice (the ticket repro)', async () => {
    const ws = await newWs('Dev project os');
    const id = await seedIssues(ws, [{ name: 'Sprint', type: 'text' }]);
    const before = await rawFields(id);
    const m = STARTER_PACKS.find((p) => p.slug === 'dev-project-os')!.manifest;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: m, resolutions: { Issues: { action: 'reuse', database_id: id } } });
      expect(res.statusCode, res.body).toBe(422);
      expect(await rawFields(id), `attempt ${attempt}`).toEqual(before);
    }
  });

  it('an incompatible same-named field fails with a message naming the field, its type and why, the preview says it up front, and nothing is left (Sprints included)', async () => {
    const ws = await newWs('Incompatible');
    const id = await seedIssues(ws, [{ name: 'Sprint', type: 'text' }]);
    const before = await rawFields(id);
    const pv = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: manifest(), resolutions: { Issues: { action: 'reuse', database_id: id } } });
    expect(pv.statusCode, pv.body).toBeLessThan(300);
    const gains = (pv.json().databases as Array<{ name: string; gains?: { fields: Array<{ name: string }>; not_applied: Array<Record<string, unknown>> } }>).find((d) => d.name === 'Issues')!.gains!;
    expect(gains.not_applied).toEqual([expect.objectContaining({ kind: 'relation', name: 'Issues.Sprint', blocks_install: true })]);
    expect(gains.fields.map((f) => f.name), 'preview does not promise a Sprint it cannot add').not.toContain('Sprint');
    const res = await install(ws, { Issues: { action: 'reuse', database_id: id } });
    expect(res.statusCode, res.body).toBe(422);
    const message = res.json().error.message as string;
    expect(message).toContain('"Issues.Sprint" already exists as a text field, but the pack needs a relation field there');
    expect(message).not.toMatch(/A field named "Sprint" already exists in this database/);
    expect(message).toContain('Nothing was installed.');
    expect(await rawFields(id)).toEqual(before);
    const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ name: string }>;
    expect(dbs.map((d) => d.name).filter((n) => n === 'Sprints'), 'the Sprints database the install made is gone').toEqual([]);
  });

  it('a field the person made with the same name and another type is kept on the database in the pack own space, and the result says so with the reason', async () => {
    const ws = await newWs('Kept');
    // In the pack's own space, so it is the database the pack means (not an adoption, which refuses a type clash up front).
    const id = await seedIssues(ws, [{ name: 'Due Date', type: 'text' }], 'Reinstall Pack Space');
    const res = await install(ws, { Issues: { action: 'reuse' } });
    expect(res.statusCode, res.body).toBe(201);
    const entry = (res.json().fields as Array<{ name: string; action: string; reason?: string }>).find((f) => f.name === 'Issues.Due Date')!;
    expect(entry.action).toBe('reused');
    expect(entry.reason).toBe('A "Due Date" field already exists as text; the pack wants date, so it is kept as it is.');
    const live = (await rawFields(id)).filter((f) => f.display_name === 'Due Date');
    expect(live).toEqual([{ display_name: 'Due Date', type: 'text', deleted: false }]);
  });

  it("a compatible same-named field (a select with the person's own options) is reused untouched, not duplicated", async () => {
    const ws = await newWs('Compatible');
    const id = await seedIssues(ws, []);
    const made = await as('POST', `/workspaces/${ws}/databases/${id}/fields`, { display_name: 'Priority', type: 'select', options: [{ label: 'Mine' }] });
    expect(made.statusCode, made.body).toBeLessThan(300);
    const res = await install(ws, { Issues: { action: 'reuse', database_id: id } });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().fields as Array<{ name: string; action: string; reason?: string }>).find((f) => f.name === 'Issues.Priority')).toMatchObject({ action: 'reused' });
    const detail = (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as { fields: Array<{ displayName: string; options?: Array<{ label: string }> }> };
    const priority = detail.fields.filter((f) => f.displayName === 'Priority');
    expect(priority).toHaveLength(1);
    expect(priority[0]!.options!.map((o) => o.label)).toEqual(['Mine']);
  });

  it('reinstall onto the adopted database (after an uninstall, and again on top of itself) succeeds, adds no duplicate and is stable', async () => {
    const ws = await newWs('Reinstall');
    const id = await seedIssues(ws, []);
    const adopt = { Issues: { action: 'reuse', database_id: id } };
    expect((await install(ws, adopt)).statusCode).toBe(201);
    const afterFirst = await rawFields(id);
    expect(afterFirst.map((f) => f.display_name)).toEqual(expect.arrayContaining(['Priority', 'Due Date', 'Sprint']));
    const installs = async () => (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    for (let round = 0; round < 2; round++) {
      const un = await as('POST', `/workspaces/${ws}/packs/${(await installs()).find((i) => i.slug === 'adopted-reinstall')!.id}/uninstall`);
      expect(un.statusCode, un.body).toBeLessThan(300);
      const again = await install(ws, { Issues: { action: 'reuse' }, Sprints: { action: 'reuse' } });
      expect(again.statusCode, `round ${round}: ${again.body}`).toBe(201);
      expect(await rawFields(id), `round ${round}`).toEqual(afterFirst);
    }
    const plain = await install(ws);
    expect(plain.statusCode, plain.body).toBeLessThan(300);
    expect(await rawFields(id)).toEqual(afterFirst);
  });
});
