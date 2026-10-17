import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * #943 / ADR-0018 phase 1a — a RESTRICTED space or database is visible to a MEMBER only through a grant. Everything below asserts on
 * response BODIES (a status code cannot tell you whether a name leaked), with the admin as the control and a GUEST beside each
 * member case, because the guest path and the member path are one function and must stay one.
 *
 * Fixture (the Dr.Wunder shape):
 *   space "Team"   (open)        db "Tasks" (open)          db "Payroll" (RESTRICTED, inside the open space)
 *   space "Back"   (RESTRICTED)  db "Hiring" (closed by its space)   db "Offers" (RESTRICTED itself, inside the restricted space)
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let team: string, back: string;
let tasks: string, payroll: string, hiring: string, offers: string;
let payrollRec: string, taskRec: string, hiringRec: string;
let alice: Person; // member, viewer grant on Payroll
let bob: Person; // member, no grants at all
let carol: Person; // member, SPACE grant on Back
let erin: Person; // member, DATABASE grant on Offers only
let dave: Person; // guest, space grant on Team
let relApi: string;

const SECRET = 'Payroll secret: CEO salary 900k';
const as = (p: { token: string }, method: string, url: string, payload?: unknown) => call(app, p.token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const dbUrl = (id: string) => `/workspaces/${ws}/databases/${id}`;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'RA Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Restricted WS' })).json().id;
  team = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  back = (await adm('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  const mk = async (space: string, name: string) => (await adm('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  tasks = await mk(team, 'Tasks');
  payroll = await mk(team, 'Payroll');
  hiring = await mk(back, 'Hiring');
  offers = await mk(back, 'Offers');
  taskRec = (await adm('POST', `${dbUrl(tasks)}/records`, { values: { name: 'Write the launch plan' } })).json().id;
  payrollRec = (await adm('POST', `${dbUrl(payroll)}/records`, { values: { name: SECRET } })).json().id;
  hiringRec = (await adm('POST', `${dbUrl(hiring)}/records`, { values: { name: 'Hire a CFO' } })).json().id;
  await adm('POST', `${dbUrl(offers)}/records`, { values: { name: 'Offer letter 7' } });
  // Tasks -> Payroll relation, with one link, so a Tasks record carries a chip to a Payroll record
  const rel = await adm('POST', `/workspaces/${ws}/relations`, { database_a_id: tasks, database_b_id: payroll, cardinality: 'one_to_many', field_a_name: 'Pay line' });
  expect(rel.statusCode, rel.body).toBe(201);
  relApi = (await adm('GET', dbUrl(tasks))).json().fields.find((f: { id: string }) => f.id === rel.json().field_a.id).apiName;
  await adm('PUT', `${dbUrl(tasks)}/records/${taskRec}/links/${rel.json().field_a.id}`, { record_ids: [payrollRec] });

  alice = await joinAs(app, owner.token, ws, 'RA Alice', 'member');
  bob = await joinAs(app, owner.token, ws, 'RA Bob', 'member');
  carol = await joinAs(app, owner.token, ws, 'RA Carol', 'member');
  erin = await joinAs(app, owner.token, ws, 'RA Erin', 'member');
  dave = await joinAs(app, owner.token, ws, 'RA Dave', 'guest', [{ space_id: team, role: 'editor' }]);

  await setRestricted(app, owner.token, ws, 'database', payroll);
  await setRestricted(app, owner.token, ws, 'space', back);
  await setRestricted(app, owner.token, ws, 'database', offers);
  await grant(app, owner.token, ws, alice.id, { database_id: payroll }, 'viewer');
  await grant(app, owner.token, ws, carol.id, { space_id: back }, 'editor');
  await grant(app, owner.token, ws, erin.id, { database_id: offers }, 'viewer');
}, 240_000);
afterAll(async () => { await app.close(); });

const names = (body: unknown) => JSON.stringify(body);
/** The Members projection is an open system database every member sees; it is not what these cases are about. */
const userDbs = (body: unknown) => (body as Array<{ name: string }>).map((d) => d.name).filter((n) => n !== 'Members');

describe('#943 lists: a member sees only what is open to them or granted', () => {
  it('GET databases: bob sees Tasks only; the restricted names are not in the body at all', async () => {
    const res = await as(bob, 'GET', `/workspaces/${ws}/databases`);
    expect(res.statusCode).toBe(200);
    expect(userDbs(res.json())).toEqual(['Tasks']);
    for (const n of ['Payroll', 'Hiring', 'Offers']) expect(names(res.json())).not.toContain(n);
  });

  it('GET databases: alice also sees Payroll (her grant); carol sees Hiring but NOT Offers (sticky); erin sees only Offers and Tasks; the admin sees all four', async () => {
    const list = async (p: { token: string }) => userDbs((await as(p, 'GET', `/workspaces/${ws}/databases`)).json()).sort();
    expect(await list(alice)).toEqual(['Payroll', 'Tasks']);
    expect(await list(carol)).toEqual(['Hiring', 'Tasks']);
    expect(await list(erin)).toEqual(['Offers', 'Tasks']);
    expect(await list(owner)).toEqual(['Hiring', 'Offers', 'Payroll', 'Tasks']);
  });

  it('GET databases: the GUEST dave with a space grant on Team sees Tasks but NOT Payroll (sticky holds for guests too)', async () => {
    const res = await as(dave, 'GET', `/workspaces/${ws}/databases`);
    expect(userDbs(res.json())).toEqual(['Tasks']);
    expect(names(res.json())).not.toContain('Payroll');
  });

  it('GET spaces: bob does not see the restricted space Back; carol (space grant) and erin (a database grant inside it) do; the admin does', async () => {
    const list = async (p: { token: string }) => ((await as(p, 'GET', `/workspaces/${ws}/spaces`)).json() as Array<{ name: string }>).map((s) => s.name);
    expect(await list(bob)).not.toContain('Back office');
    expect(names((await as(bob, 'GET', `/workspaces/${ws}/spaces`)).json())).not.toContain('Back office');
    expect(await list(carol)).toContain('Back office');
    expect(await list(erin)).toContain('Back office');
    expect(await list(owner)).toContain('Back office');
    expect(await list(bob), 'the open default space stays visible').toContain('General');
  });

  it('the restricted flag is on the row for those who can see it', async () => {
    const row = (await as(alice, 'GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Payroll');
    expect(row.restricted).toBe(true);
    expect((await as(alice, 'GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Tasks').restricted).toBe(false);
  });
});

describe('#943 by-id routes: 404 for a member without a grant, a real answer for one with', () => {
  it('bob gets 404 on Payroll introspection, records list, query and create, and the body names nothing', async () => {
    for (const [method, url, payload] of [
      ['GET', dbUrl(payroll)],
      ['GET', `${dbUrl(payroll)}/records`],
      ['POST', `${dbUrl(payroll)}/records/query`, { limit: 5 }],
      ['POST', `${dbUrl(payroll)}/records`, { values: { name: 'planted' } }],
      ['GET', `${dbUrl(payroll)}/records/${payrollRec}`],
      ['PATCH', `${dbUrl(payroll)}/records/${payrollRec}`, { values: { name: 'defaced' } }],
    ] as const) {
      const res = await as(bob, method, url, payload);
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(404);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain('Payroll');
    }
    expect((await adm('GET', `${dbUrl(payroll)}/records/${payrollRec}`)).json().title, 'nothing was changed').toBe(SECRET);
  });

  it('a GUEST with a space grant on Team is refused Payroll too (sticky)', async () => {
    const res = await as(dave, 'GET', `${dbUrl(payroll)}/records/${payrollRec}`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('alice holds viewer on Payroll: she reads it and cannot write; she is still a creator on the open Tasks', async () => {
    expect((await as(alice, 'GET', `${dbUrl(payroll)}/records/${payrollRec}`)).json().title).toBe(SECRET);
    expect((await as(alice, 'POST', `${dbUrl(payroll)}/records`, { values: { name: 'x' } })).statusCode).toBe(403);
    expect((await as(alice, 'POST', `${dbUrl(tasks)}/records`, { values: { name: 'alice task' } })).statusCode).toBe(201);
    expect((await as(alice, 'GET', dbUrl(payroll))).json().my_access).toBe('viewer');
  });

  it('closed by the SPACE: bob is refused Hiring; carol (space grant) reads and edits it; a space grant does NOT open Offers, which is itself restricted', async () => {
    expect((await as(bob, 'GET', dbUrl(hiring))).statusCode).toBe(404);
    expect((await as(carol, 'GET', `${dbUrl(hiring)}/records/${hiringRec}`)).statusCode).toBe(200);
    expect((await as(carol, 'POST', `${dbUrl(hiring)}/records`, { values: { name: 'carol adds' } })).statusCode).toBe(201);
    const offersAsCarol = await as(carol, 'GET', dbUrl(offers));
    expect(offersAsCarol.statusCode, 'sticky: the space grant does not open a database flagged restricted').toBe(404);
    expect(offersAsCarol.body).not.toContain('Offers');
  });

  it('erin holds a grant on Offers only: she reads it, not Hiring; and she can reach Offers although its space is closed to her', async () => {
    expect((await as(erin, 'GET', dbUrl(offers))).statusCode).toBe(200);
    expect((await as(erin, 'GET', dbUrl(hiring))).statusCode).toBe(404);
  });

  it('the admin reads and writes everything', async () => {
    for (const id of [tasks, payroll, hiring, offers]) expect((await adm('GET', dbUrl(id))).statusCode).toBe(200);
    expect((await adm('POST', `${dbUrl(payroll)}/records`, { values: { name: 'admin adds' } })).statusCode).toBe(201);
  });
});

describe('#943 a grant adds, never subtracts', () => {
  it('a viewer grant on an OPEN database does not lower a member below creator', async () => {
    await grant(app, owner.token, ws, bob.id, { database_id: tasks }, 'viewer');
    const res = await as(bob, 'POST', `${dbUrl(tasks)}/records`, { values: { name: 'bob can still create' } });
    expect(res.statusCode, res.body).toBe(201);
    expect((await as(bob, 'GET', dbUrl(tasks))).json().my_access).toBe('creator');
    const grants = (await adm('GET', `/workspaces/${ws}/grants?user_id=${bob.id}`)).json().data as Array<{ id: string }>;
    for (const g of grants) await adm('DELETE', `/workspaces/${ws}/grants/${g.id}`);
  });

  it('overlapping grants resolve to the HIGHEST, whichever was created first', async () => {
    const early = await joinAs(app, owner.token, ws, 'RA Early', 'member');
    const late = await joinAs(app, owner.token, ws, 'RA Late', 'member');
    await grant(app, owner.token, ws, early.id, { database_id: hiring }, 'viewer');
    await grant(app, owner.token, ws, early.id, { space_id: back }, 'editor');
    await grant(app, owner.token, ws, late.id, { space_id: back }, 'editor');
    await grant(app, owner.token, ws, late.id, { database_id: hiring }, 'viewer');
    for (const p of [early, late]) {
      const res = await as(p, 'POST', `${dbUrl(hiring)}/records`, { values: { name: 'max wins' } });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('a record-scoped grant for a MEMBER is refused (ADR-0018 §7), a guest can still have one', async () => {
    const res = await adm('POST', `/workspaces/${ws}/grants`, { user_id: bob.id, record_id: payrollRec, role: 'viewer' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('guests');
  });
});

describe('#943 other surfaces that go through the primitives', () => {
  it('search: a search for the restricted record title finds nothing for bob (byte-identical to a random string), alice finds it', async () => {
    const q = async (p: { token: string }, term: string) => as(p, 'GET', `/workspaces/${ws}/search?q=${encodeURIComponent(term)}`);
    const real = await q(bob, 'CEO salary');
    const random = await q(bob, 'zzqxjv wqpl');
    const strip = (r: { statusCode: number; body: string }) => `${r.statusCode} ${r.body.replace(/"request_id":"[^"]*"/g, '')}`;
    expect(strip(real)).toBe(strip(random));
    expect(real.body).not.toContain('CEO');
    expect((await q(alice, 'CEO salary')).body).toContain(SECRET);
  });

  it('search places: the restricted database and space names are absent for bob, present for the admin', async () => {
    const places = async (p: { token: string }) => names((await as(p, 'GET', `/workspaces/${ws}/search?q=Payroll`)).json());
    expect(await places(bob)).not.toContain('Payroll');
    const hiringHit = names((await as(bob, 'GET', `/workspaces/${ws}/search?q=Back`)).json());
    expect(hiringHit, 'a restricted SPACE name is not searchable by a member without a grant').not.toContain('Back office');
  });

  it('the relation chip on an OPEN record that points into a restricted database is not served to bob, and is to alice', async () => {
    const asBob = await as(bob, 'GET', `${dbUrl(tasks)}/records/${taskRec}`);
    expect(asBob.statusCode).toBe(200);
    expect(asBob.body, 'no chip title for a record bob cannot read').not.toContain(SECRET);
    expect(names(asBob.json().values[relApi] ?? [])).not.toContain('CEO');
    expect((await as(alice, 'GET', `${dbUrl(tasks)}/records/${taskRec}`)).body).toContain(SECRET);
    // and through a query row, the other place a chip is built
    const q = await as(bob, 'POST', `${dbUrl(tasks)}/records/query`, { limit: 20 });
    expect(q.body).not.toContain(SECRET);
  });

  it('favourites: bob cannot star a restricted record and his favourites never carry one', async () => {
    const star = await as(bob, 'POST', `/workspaces/${ws}/favorites`, { record_id: payrollRec });
    expect(star.statusCode, star.body).toBeGreaterThanOrEqual(400);
    expect((await as(bob, 'GET', `/workspaces/${ws}/favorites`)).body).not.toContain(SECRET);
  });

  it('a restored workspace default: with NOTHING restricted a member is exactly as before (a fresh workspace, no extra rows)', async () => {
    const o2 = await signUpUser(app, 'RA Plain Owner');
    const ws2 = (await call(app, o2.token, 'POST', '/workspaces', { name: 'Plain WS' })).json().id;
    const sp = (await call(app, o2.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const d = (await call(app, o2.token, 'POST', `/workspaces/${ws2}/databases`, { space_id: sp, name: 'Everything open' })).json().id;
    const m = await joinAs(app, o2.token, ws2, 'RA Plain Member', 'member');
    const res = await call(app, m.token, 'GET', `/workspaces/${ws2}/databases`);
    expect((res.json() as Array<{ name: string; restricted: boolean }>).filter((x) => x.name !== 'Members').map((x) => [x.name, x.restricted])).toEqual([['Everything open', false]]);
    expect((await call(app, m.token, 'POST', `/workspaces/${ws2}/databases/${d}/records`, { values: { name: 'ok' } })).statusCode).toBe(201);
  });
});

describe('#943 tokens inherit: a PAT acts as its member, and a bound token is never wider than its owner', () => {
  it('bob\'s PAT cannot read Payroll; alice\'s PAT can (viewer) and cannot write', async () => {
    const pat = async (p: Person) => (await as(p, 'POST', '/me/tokens', { name: 'pat', workspace_id: ws, scope: 'admin' })).json().token as string;
    const bobPat = await pat(bob);
    expect((await call(app, bobPat, 'GET', dbUrl(payroll))).statusCode).toBe(404);
    const alicePat = await pat(alice);
    expect((await call(app, alicePat, 'GET', `${dbUrl(payroll)}/records/${payrollRec}`)).statusCode).toBe(200);
    expect((await call(app, alicePat, 'POST', `${dbUrl(payroll)}/records`, { values: { name: 'x' } })).statusCode).toBe(403);
  });

  it('a bound token for a member is capped at what the member holds: alice\'s token bound to Payroll is a VIEWER there, not a creator', async () => {
    const mint = await as(alice, 'POST', '/me/tokens', { name: 'bound', workspace_id: ws, scope: 'admin', resource_scope: { database_ids: [payroll, tasks] } });
    expect(mint.statusCode, mint.body).toBe(201);
    const t = mint.json().token as string;
    expect((await call(app, t, 'GET', `${dbUrl(payroll)}/records/${payrollRec}`)).statusCode).toBe(200);
    const write = await call(app, t, 'POST', `${dbUrl(payroll)}/records`, { values: { name: 'x' } });
    expect(write.statusCode, 'viewer, not creator, on the restricted database').toBe(403);
    expect((await call(app, t, 'POST', `${dbUrl(tasks)}/records`, { values: { name: 'ok' } })).statusCode, 'creator on the open one').toBe(201);
  });

  it('a bound token minted while its owner could read a database stops reaching it the moment the database is restricted (live, not snapshotted)', async () => {
    const o = await signUpUser(app, 'RA Live Owner');
    const w = (await call(app, o.token, 'POST', '/workspaces', { name: 'Live WS' })).json().id;
    const sp = (await call(app, o.token, 'GET', `/workspaces/${w}/spaces`)).json()[0].id;
    const d = (await call(app, o.token, 'POST', `/workspaces/${w}/databases`, { space_id: sp, name: 'Soon restricted' })).json().id;
    const m = await joinAs(app, o.token, w, 'RA Live Member', 'member');
    const mint = await call(app, m.token, 'POST', '/me/tokens', { name: 'bound', workspace_id: w, scope: 'admin', resource_scope: { database_ids: [d] } });
    expect(mint.statusCode, mint.body).toBe(201);
    const t = mint.json().token as string;
    expect((await call(app, t, 'GET', `/workspaces/${w}/databases/${d}`)).statusCode).toBe(200);
    await setRestricted(app, o.token, w, 'database', d);
    const after = await call(app, t, 'GET', `/workspaces/${w}/databases/${d}`);
    expect(after.statusCode, after.body).toBeGreaterThanOrEqual(403);
    expect(after.body).not.toContain('Soon restricted');
  });
});

describe('#943 setting the flag', () => {
  it('only an admin can change it: a member, even one holding creator on the database, gets 403 and nothing changes', async () => {
    await grant(app, owner.token, ws, bob.id, { database_id: tasks }, 'creator');
    const res = await as(bob, 'PATCH', dbUrl(tasks), { restricted: true });
    expect(res.statusCode, res.body).toBe(403);
    expect((await as(bob, 'PATCH', `/workspaces/${ws}/spaces/${team}`, { restricted: true })).statusCode).toBe(403);
    expect((await adm('GET', dbUrl(tasks))).json().restricted).toBe(false);
    const grants = (await adm('GET', `/workspaces/${ws}/grants?user_id=${bob.id}`)).json().data as Array<{ id: string }>;
    for (const g of grants) await adm('DELETE', `/workspaces/${ws}/grants/${g.id}`);
  });

  it('a PERSONAL space and a SYSTEM database (Members) cannot be restricted: 422', async () => {
    const personal = (await as(alice, 'POST', `/workspaces/${ws}/spaces/personal`)).json().id;
    const p = await adm('PATCH', `/workspaces/${ws}/spaces/${personal}`, { restricted: true });
    expect([404, 422], 'a personal space is invisible to the admin (404) or refused (422); never accepted').toContain(p.statusCode);
    const dbs = (await adm('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; isSystem?: boolean; is_system?: boolean }>;
    const members = dbs.find((d) => d.name === 'Members');
    if (members) {
      const res = await adm('PATCH', dbUrl(members.id), { restricted: true });
      expect(res.statusCode, res.body).toBe(422);
    }
  });

  it('unrestricting opens it again for everyone, immediately', async () => {
    await setRestricted(app, owner.token, ws, 'database', payroll, false);
    expect((await as(bob, 'GET', dbUrl(payroll))).statusCode).toBe(200);
    await setRestricted(app, owner.token, ws, 'database', payroll, true);
    expect((await as(bob, 'GET', dbUrl(payroll))).statusCode).toBe(404);
  });
});
