import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * #1083 — `PATCH /views/:view` (the view-first route, #306) wrote a database view's `config` as sent, while
 * `PATCH /databases/:db/views/:view` validates it, mints the form token server-side (#1041), keeps the service-owned
 * `share` block and checks newly public relation fields (#1071). A database's view now saves through that same update.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let guest: { token: string; email: string };
let ws: string, openSpace: string, srcDb: string, tgtDb: string, nameFieldId: string, relFieldId: string;
let db: ReturnType<typeof connectTestDb>;
const CHOSEN = 'client-chosen-token-1083-aaaaaaaaaaaaaaaa';

const inject = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });
const formConfig = (fieldIds: string[], form: Record<string, unknown>) => ({
  sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {},
  form: { title: 'Intake', fields: fieldIds.map((field_id) => ({ field_id })), ...form },
});
const createForm = async (token: string, fieldIds: string[]) => {
  const res = await inject(token, 'POST', `/workspaces/${ws}/databases/${srcDb}/views`, { name: 'Intake', type: 'form', config: formConfig(fieldIds, { access: 'members' }) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const patchById = (token: string, viewId: string, body: unknown) => inject(token, 'PATCH', `/workspaces/${ws}/views/${viewId}`, body);
const storedConfig = async (viewId: string) =>
  (await db.pool.query(`SELECT config FROM views WHERE id = $1`, [viewId])).rows[0].config as { form?: { public_token?: string }; share?: { public_token?: string }; hidden_field_ids?: string[]; dashboard_tiles?: unknown[] };

beforeAll(async () => {
  app = await createTestApp();
  db = connectTestDb();
  owner = await signUpUser(app, 'Views Owner');
  guest = await signUpUser(app, 'Views Guest');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'View By Id WS' })).json().id;
  openSpace = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const closed = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Board only' })).json().id;
  srcDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: openSpace, name: 'Client tasks' })).json().id;
  tgtDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: closed, name: 'Deals' })).json().id;
  const rel = await inject(owner.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: srcDb, database_b_id: tgtDb, cardinality: 'one_to_many', field_a_name: 'Deal' });
  expect(rel.statusCode, rel.body).toBe(201);
  relFieldId = rel.json().field_a.id;
  const detail = (await inject(owner.token, 'GET', `/workspaces/${ws}/databases/${srcDb}`)).json();
  nameFieldId = detail.fields.find((f: { type: string; api_name?: string }) => f.type === 'title' || f.api_name === 'name').id;
  // Editor on the source's space (this route's door), no grant on the target's space.
  const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ space_id: openSpace, role: 'editor' }] });
  expect(inv.statusCode, inv.body).toBe(201);
  expect((await inject(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! })).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await db.pool.end(); await app.close(); });

describe('PATCH /views/:view applies the database-scoped validation to a database view (#1083)', () => {
  it('a client-chosen form token is neither stored nor served', async () => {
    const id = await createForm(owner.token, [nameFieldId]);
    const res = await patchById(owner.token, id, { config: formConfig([nameFieldId], { access: 'public', public_token: CHOSEN }) });
    expect(res.statusCode, res.body).toBe(200);
    const token = (await storedConfig(id)).form?.public_token;
    expect(token, 'the form is published with a server-minted token').toBeTruthy();
    expect(token).not.toBe(CHOSEN);
    expect((await inject(null, 'GET', `/public/forms/${CHOSEN}`)).statusCode).toBe(404);
    expect((await inject(null, 'GET', `/public/forms/${token}`)).statusCode).toBe(200);
  });

  it('a guest cannot make a form public with a relation to a database they cannot read', async () => {
    const id = await createForm(guest.token, [nameFieldId, relFieldId]);
    const res = await patchById(guest.token, id, { config: formConfig([nameFieldId, relFieldId], { access: 'link' }) });
    expect(res.statusCode, res.body).toBe(422);
    expect((await storedConfig(id)).form?.public_token).toBeUndefined();
  });

  it('config the database-scoped validator rejects is refused', async () => {
    const id = await createForm(owner.token, [nameFieldId]);
    const unknownField = await patchById(owner.token, id, { config: { hidden_field_ids: ['00000000-0000-4000-8000-000000000000'] } });
    expect(unknownField.statusCode, unknownField.body).toBe(422);
    const malformed = await patchById(owner.token, id, { config: { sorts: 'not-a-list' } });
    expect(malformed.statusCode, malformed.body).toBe(400);
    expect((await storedConfig(id)).hidden_field_ids).toEqual([]);
  });

  it('the service-owned share block is kept when config is replaced', async () => {
    const view = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${srcDb}/views`, { name: 'Shared', type: 'table' })).json();
    const shared = await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${srcDb}/views/${view.id}/share`, {});
    expect(shared.statusCode, shared.body).toBeLessThan(300);
    const before = (await storedConfig(view.id)).share;
    expect(before?.public_token).toBeTruthy();
    const res = await patchById(owner.token, view.id, { config: { sorts: [], share: { public_token: CHOSEN } } });
    expect(res.statusCode, res.body).toBe(200);
    expect((await storedConfig(view.id)).share).toEqual(before);
  });
});

describe('MUST KEEP WORKING through PATCH /views/:view', () => {
  it('renames and refiles a database view', async () => {
    const id = await createForm(owner.token, [nameFieldId]);
    const folder = await inject(owner.token, 'POST', `/workspaces/${ws}/spaces/${openSpace}/folders`, { name: 'Forms' });
    expect(folder.statusCode, folder.body).toBe(201);
    const res = await patchById(owner.token, id, { name: 'Renamed intake', folder_id: folder.json().id });
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await db.pool.query(`SELECT name, folder_id FROM views WHERE id = $1`, [id]);
    expect(rows[0]).toEqual({ name: 'Renamed intake', folder_id: folder.json().id });
  });

  it('edits a space dashboard; share and form are not taken from the body', async () => {
    const dash = await inject(owner.token, 'POST', `/workspaces/${ws}/spaces/${openSpace}/views`, { name: 'Space metrics', type: 'dashboard' });
    expect(dash.statusCode, dash.body).toBe(201);
    const tiles = [{ id: '10000000-0000-4000-8000-000000000001', label: 'Tasks', op: 'count', database_id: srcDb }];
    const res = await patchById(owner.token, dash.json().id, {
      name: 'Space KPIs',
      config: { dashboard_tiles: tiles, share: { public_token: CHOSEN }, form: { access: 'public', public_token: CHOSEN } },
    });
    expect(res.statusCode, res.body).toBe(200);
    const stored = await storedConfig(dash.json().id);
    expect(stored.dashboard_tiles).toEqual([expect.objectContaining(tiles[0])]);
    expect(stored.share).toBeUndefined();
    expect(stored.form).toBeUndefined();
  });
});
