import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';

/**
 * #943 AC6 / ADR-0018 — a token bound to a space or database acts with what its OWNER can really reach there, never more:
 *   - bound to a SPACE that contains a restricted database, it must not open that database unless the owner has a grant on it
 *     (a space binding is not a grant; the restriction is sticky);
 *   - bound to the restricted DATABASE itself, it gets nothing unless the owner holds a grant;
 *   - when the owner is granted it opens (at the grant's role, not creator); when the grant is revoked it closes on the very
 *     next call (the reach is computed from live rows, never cached on the token);
 *   - a token bound to something else does not become wider because its owner has a grant on the restricted database.
 * Every refusal is asserted on the response BODY: no title, no id, no value from the restricted side.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let mia: { token: string; id: string };
let ws: string, space: string, open: string, restricted: string;
let grantId = '';
let miaSpaceToken: string, miaDbToken = '', miaOpenToken: string, adminSpaceToken: string;
const SECRET = 'Project Nightingale payroll';
let secretRec: string;

const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
async function mint(as: string, resource_scope: unknown): Promise<string> {
  const res = await call(app, as, 'POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope: 'admin', resource_scope });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'RBT Owner');
  ws = (await adm('POST', '/workspaces', { name: 'RBT WS' })).json().id;
  space = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  open = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Open tasks' })).json().id;
  restricted = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Payroll' })).json().id;
  secretRec = (await adm('POST', `/workspaces/${ws}/databases/${restricted}/records`, { values: { name: SECRET } })).json().id;
  await adm('POST', `/workspaces/${ws}/databases/${open}/records`, { values: { name: 'ordinary task' } });
  await setRestricted(app, owner.token, ws, 'database', restricted);
  mia = await joinAs(app, owner.token, ws, 'RBT Mia', 'member');
  miaSpaceToken = await mint(mia.token, { space_ids: [space] });
  miaOpenToken = await mint(mia.token, { database_ids: [open] });
  adminSpaceToken = await mint(owner.token, { space_ids: [space] });
}, 240_000);
afterAll(async () => { await app.close(); });

/** What a token can see of the restricted database, as response bodies. */
async function peek(token: string) {
  const list = await call(app, token, 'GET', `/workspaces/${ws}/databases`);
  const detail = await call(app, token, 'GET', `/workspaces/${ws}/databases/${restricted}`);
  const query = await call(app, token, 'POST', `/workspaces/${ws}/databases/${restricted}/records/query`, { limit: 10 });
  const record = await call(app, token, 'GET', `/workspaces/${ws}/databases/${restricted}/records/${secretRec}`);
  const search = await call(app, token, 'GET', `/workspaces/${ws}/search?q=Nightingale`);
  const write = await call(app, token, 'POST', `/workspaces/${ws}/databases/${restricted}/records`, { values: { name: 'smuggled' } });
  return { list, detail, query, record, search, write };
}
const leaks = (r: Awaited<ReturnType<typeof peek>>) =>
  [r.list.body, r.detail.body, r.query.body, r.record.body, r.search.body].some((b) => b.includes(SECRET) || b.includes(secretRec) || b.includes('Payroll'));

describe('#943 a bound token never reaches a restricted database its owner cannot', () => {
  it('no grant: a token bound to the SPACE gets nothing of the restricted database — in any body — and one cannot even be MINTED bound to it', async () => {
    const refused = await call(app, mia.token, 'POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope: 'admin', resource_scope: { database_ids: [restricted] } });
    expect(refused.statusCode, 'minting a token bound to a database you cannot read').toBeGreaterThanOrEqual(400);
    expect(refused.body).not.toContain('Payroll');
    for (const [label, token] of [['space-bound', miaSpaceToken], ['bound elsewhere', miaOpenToken]] as const) {
      const r = await peek(token);
      expect(leaks(r), `${label} leaked`).toBe(false);
      expect(r.detail.statusCode, `${label} detail`).toBeGreaterThanOrEqual(400);
      expect(r.query.statusCode, `${label} query`).toBeGreaterThanOrEqual(400);
      expect(r.record.statusCode, `${label} record`).toBeGreaterThanOrEqual(400);
      expect(r.write.statusCode, `${label} write`).toBeGreaterThanOrEqual(400);
    }
    // and the space-bound token still sees the OPEN database beside it (the binding works; only the restricted one is closed)
    const list = await call(app, miaSpaceToken, 'GET', `/workspaces/${ws}/databases`);
    expect(list.body).toContain('Open tasks');
  });

  it('owner granted on the restricted database: the space-bound and database-bound tokens open it, as a VIEWER; a token bound elsewhere stays out', async () => {
    const made = await adm('POST', `/workspaces/${ws}/grants`, { user_id: mia.id, database_id: restricted, role: 'viewer' });
    expect(made.statusCode, made.body).toBeLessThan(300);
    grantId = made.json().id;
    miaDbToken = await mint(mia.token, { database_ids: [restricted] }); // mintable now that she can read it
    for (const [label, token] of [['space-bound', miaSpaceToken], ['database-bound', miaDbToken]] as const) {
      const r = await peek(token);
      expect(r.detail.statusCode, `${label} detail`).toBe(200);
      expect(r.query.body, `${label} query`).toContain(SECRET);
      expect(r.write.statusCode, `${label} must not write: the grant is viewer, not creator`).toBeGreaterThanOrEqual(400);
    }
    const elsewhere = await peek(miaOpenToken);
    expect(leaks(elsewhere), 'a token bound to a different database is not widened by its owner\'s grant').toBe(false);
  });

  it('grant revoked: the very next call is closed again, for both bound tokens (including the one minted while she held the grant)', async () => {
    expect((await adm('DELETE', `/workspaces/${ws}/grants/${grantId}`)).statusCode).toBeLessThan(300);
    for (const [label, token] of [['space-bound', miaSpaceToken], ['database-bound', miaDbToken]] as const) {
      const r = await peek(token);
      expect(leaks(r), `${label} still leaks after revocation`).toBe(false);
      expect(r.detail.statusCode, `${label}`).toBeGreaterThanOrEqual(400);
    }
  });

  it('an ADMIN owner is not narrowed by the restriction (admins always see): a token bound to the space reaches it, capped below admin', async () => {
    const r = await peek(adminSpaceToken);
    expect(r.detail.statusCode).toBe(200);
    expect(r.query.body).toContain(SECRET);
  });
});
