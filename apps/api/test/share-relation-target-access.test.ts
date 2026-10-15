import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Publishing a view with `include_relation_api_names` checked only that the name is a relation field of THIS database.
 * It never asked whether the publisher can read the database the relation points at, so a guest with an `editor` grant on
 * database A could publish a link whose relation chips carry the TITLES of records in database B, which they have no
 * grant on, to anonymous visitors.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let guest: { token: string; email: string };
let ws: string;
let srcDb: string;
let tgtDb: string;
let viewId: string;
let relApi: string;
const SECRET = 'Acquisition target: Zanzibar Holdings';

const inject = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Share Owner');
  guest = await signUpUser(app, 'Share Guest');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'Share Rel WS' })).json().id;
  const open = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const closed = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Board only' })).json().id;
  srcDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: open, name: 'Client tasks' })).json().id;
  tgtDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: closed, name: 'Deals' })).json().id;
  const rel = await inject(owner.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: srcDb, database_b_id: tgtDb, cardinality: 'one_to_many', field_a_name: 'Deal' });
  expect(rel.statusCode, rel.body).toBe(201);
  const target = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${tgtDb}/records`, { values: { name: SECRET } })).json();
  const rec = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${srcDb}/records`, { values: {} })).json();
  await inject(owner.token, 'PUT', `/workspaces/${ws}/databases/${srcDb}/records/${rec.id}/links/${rel.json().field_a.id}`, { record_ids: [target.id] });
  const detail = (await inject(owner.token, 'GET', `/workspaces/${ws}/databases/${srcDb}`)).json();
  viewId = detail.views[0].id;
  relApi = detail.fields.find((f: { id: string }) => f.id === rel.json().field_a.id).apiName;
  const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ database_id: srcDb, role: 'editor' }] });
  expect(inv.statusCode, inv.body).toBe(201);
  expect((await inject(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! })).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

const share = (token: string, include: string[]) =>
  inject(token, 'POST', `/workspaces/${ws}/databases/${srcDb}/views/${viewId}/share`, { include_relation_api_names: include });

describe('publishing relation chips needs read access to the relation target', () => {
  it('a guest with editor on the source but NO grant on the target cannot publish the relation, and no token is minted', async () => {
    const res = await share(guest.token, [relApi]);
    // on main this minted a token; what an anonymous visitor then gets is the evidence
    const anon = res.statusCode === 201 ? ((b) => { const i = b.indexOf(SECRET); return i < 0 ? 'no title' : b.slice(Math.max(0, i - 80), i + SECRET.length + 20); })((await inject(null, 'GET', `/public/views/${res.json().token}`)).body) : '';
    expect(res.statusCode, `served token ${res.body}; anonymous page: ${anon}`).toBe(422);
    expect(res.body).not.toContain('token');
    expect(res.body).not.toContain(SECRET);
    expect(res.body, 'the refusal must not say the target exists (same wording as an unknown relation)').toContain('is not a relation field on this database');
  });

  it('the guest CAN publish the view without the relation (their own data), and the anonymous page carries no chip', async () => {
    const res = await share(guest.token, []);
    expect(res.statusCode, res.body).toBe(201);
    const page = await inject(null, 'GET', `/public/views/${res.json().token}`);
    expect(page.statusCode).toBe(200);
    expect(page.body).not.toContain(SECRET);
  });

  it('MUST KEEP WORKING: an admin publishes with the relation and anonymous visitors see the chip title', async () => {
    const res = await share(owner.token, [relApi]);
    expect(res.statusCode, res.body).toBe(201);
    const page = await inject(null, 'GET', `/public/views/${res.json().token}`);
    expect(page.body).toContain(SECRET);
  });

  it('a guest who DOES hold a grant on the target can publish it', async () => {
    await inject(owner.token, 'POST', `/workspaces/${ws}/grants`, { user_id: (await inject(guest.token, 'GET', '/me')).json().id, database_id: tgtDb, role: 'viewer' });
    const res = await share(guest.token, [relApi]);
    expect(res.statusCode, res.body).toBe(201);
  });
});
