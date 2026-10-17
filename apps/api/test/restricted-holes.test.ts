import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';

/**
 * #945 / ADR-0018 phase 1c — the routes that never asked access at all. Each case says WHO it matters for: where a guest can reach
 * the route it is live today; where only a member can, it matters once something is restricted (a restricted database in an OPEN
 * space is exactly the shape that exposes them, because the space door passes and nothing checks the database behind it).
 *
 * Fixture: space General (open) with db Tasks (open) and db Payroll (RESTRICTED, one record, one dashboard); space Back (RESTRICTED).
 *   bob   member, no grants          carol  member, editor on Back      erin   member, viewer on Back
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, general: string, back: string, tasks: string, payroll: string;
let payrollRec: string, taskRec: string, payrollView: string;
let bob: Person, carol: Person, erin: Person;
const SECRET = 'CEO salary 900k';
const as = (p: { token: string }, method: string, url: string, payload?: unknown) => call(app, p.token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const db = (id: string) => `/workspaces/${ws}/databases/${id}`;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'RH Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Holes WS' })).json().id;
  general = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  back = (await adm('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  tasks = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Tasks' })).json().id;
  payroll = (await adm('POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Payroll' })).json().id;
  taskRec = (await adm('POST', `${db(tasks)}/records`, { values: { name: 'a task' } })).json().id;
  payrollRec = (await adm('POST', `${db(payroll)}/records`, { values: { name: SECRET } })).json().id;
  const v = await adm('POST', `${db(payroll)}/views`, { name: 'Payroll overview', type: 'dashboard' });
  expect(v.statusCode, v.body).toBeLessThan(300);
  payrollView = v.json().id;
  bob = await joinAs(app, owner.token, ws, 'RH Bob', 'member');
  carol = await joinAs(app, owner.token, ws, 'RH Carol', 'member');
  erin = await joinAs(app, owner.token, ws, 'RH Erin', 'member');
  await setRestricted(app, owner.token, ws, 'database', payroll);
  await setRestricted(app, owner.token, ws, 'space', back);
  await grant(app, owner.token, ws, carol.id, { space_id: back }, 'editor');
  await grant(app, owner.token, ws, erin.id, { space_id: back }, 'viewer');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#945 (1) POST databases checks the SPACE it creates into — matters for members once a space is restricted', () => {
  it('bob (no grant on the restricted space) is told it does not exist, and nothing is created', async () => {
    const res = await as(bob, 'POST', `/workspaces/${ws}/databases`, { space_id: back, name: 'Planted by bob' });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).not.toContain('Back office');
    expect(JSON.stringify((await adm('GET', `/workspaces/${ws}/databases`)).json())).not.toContain('Planted by bob');
  });
  it('erin (viewer on the space) is refused 403; carol (editor) still creates — MUST KEEP WORKING', async () => {
    expect((await as(erin, 'POST', `/workspaces/${ws}/databases`, { space_id: back, name: 'Erin tries' })).statusCode).toBe(403);
    const ok = await as(carol, 'POST', `/workspaces/${ws}/databases`, { space_id: back, name: 'Carol adds' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await as(bob, 'POST', `/workspaces/${ws}/databases`, { space_id: general, name: 'Bob in open space' })).statusCode).toBe(201);
  });
});

describe('#945 (2) PATCH spaces/:space checks the caller can edit THAT space — matters for members once a space is restricted', () => {
  it('bob cannot rename a restricted space he cannot see; erin (viewer) gets 403; carol (editor) can', async () => {
    const res = await as(bob, 'PATCH', `/workspaces/${ws}/spaces/${back}`, { name: 'Defaced by bob' });
    expect(res.statusCode, res.body).toBe(404);
    expect((await as(erin, 'PATCH', `/workspaces/${ws}/spaces/${back}`, { name: 'Erin renames' })).statusCode).toBe(403);
    expect((await as(carol, 'PATCH', `/workspaces/${ws}/spaces/${back}`, { description: 'carol edits' })).statusCode).toBe(200);
    const list = (await adm('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    expect(list.find((s) => s.id === back)!.name).toBe('Back office');
  });
  it('a member can still rename an OPEN space — MUST KEEP WORKING', async () => {
    expect((await as(bob, 'PATCH', `/workspaces/${ws}/spaces/${general}`, { description: 'bob edits the open space' })).statusCode).toBe(200);
  });
});

describe('#945 (3) space-view writes check the DATABASE behind the view — matters for members (restricted db in an open space)', () => {
  it('bob cannot read, edit, move or delete the dashboard of a database he cannot see', async () => {
    const patch = await as(bob, 'PATCH', `/workspaces/${ws}/views/${payrollView}`, { name: 'Defaced by bob' });
    expect(patch.statusCode, patch.body).toBe(404);
    const move = await as(bob, 'POST', `/workspaces/${ws}/views/${payrollView}/move-to-space`);
    expect([404, 422], `move-to-space must not succeed: ${move.body}`).toContain(move.statusCode);
    expect(move.statusCode === 404 || !move.body.includes('moved'), move.body).toBe(true);
    expect((await as(bob, 'GET', `/workspaces/${ws}/views/${payrollView}`)).statusCode).toBe(404);
    expect((await as(bob, 'DELETE', `/workspaces/${ws}/views/${payrollView}`)).statusCode).toBe(404);
    const row = (await adm('GET', `/workspaces/${ws}/views/${payrollView}`)).json();
    expect(row.name, 'untouched').toBe('Payroll overview');
    expect(row.database_id ?? row.databaseId, 'still on its database').toBe(payroll);
  });
  it('carol (no grant on Payroll) is refused too, and the admin still edits it — MUST KEEP WORKING', async () => {
    expect((await as(carol, 'PATCH', `/workspaces/${ws}/views/${payrollView}`, { name: 'Carol defaces' })).statusCode).toBe(404);
    expect((await adm('PATCH', `/workspaces/${ws}/views/${payrollView}`, { name: 'Payroll overview' })).statusCode).toBe(200);
  });
});

describe('#945 (4) record watch routes check the record belongs to the database in the URL', () => {
  it("bob cannot watch, unwatch or list the watchers of Payroll's record through his own database id", async () => {
    const watch = await as(bob, 'POST', `${db(tasks)}/records/${payrollRec}/watch`);
    expect(watch.statusCode, watch.body).toBe(404);
    expect((await as(bob, 'GET', `${db(tasks)}/records/${payrollRec}/watchers`)).statusCode).toBe(404);
    expect((await as(bob, 'DELETE', `${db(tasks)}/records/${payrollRec}/watch`)).statusCode).toBe(404);
    const watchers = (await adm('GET', `${db(payroll)}/records/${payrollRec}/watchers`)).json();
    expect(watchers.watchers, 'bob is not subscribed to a record he cannot see').not.toContain(bob.id);
  });
  it('watching a record of the right database still works — MUST KEEP WORKING', async () => {
    expect((await as(bob, 'POST', `${db(tasks)}/records/${taskRec}/watch`)).statusCode).toBe(201);
    expect((await as(bob, 'GET', `${db(tasks)}/records/${taskRec}/watchers`)).json().watching).toBe(true);
  });
});

describe('#945 (5) batch-job polling checks the job belongs to the database in the URL', () => {
  it("bob cannot read the progress of a job on Payroll through Tasks' id", async () => {
    const job = await adm('POST', `${db(payroll)}/records/batch-jobs`, { op: 'update', record_ids: [payrollRec], values: { name: SECRET } });
    expect(job.statusCode, job.body).toBeLessThan(300);
    const jobId = job.json().id ?? job.json().job_id;
    const res = await as(bob, 'GET', `${db(tasks)}/records/batch-jobs/${jobId}`);
    expect(res.statusCode, res.body).toBe(404);
    expect((await adm('GET', `${db(payroll)}/records/batch-jobs/${jobId}`)).statusCode, 'the right database still reads it').toBe(200);
  });
});

describe('#945 (6) removing a member deletes their grants', () => {
  it('after removal no grant row survives, and a re-invited member does not get the old ones back', async () => {
    const frank = await joinAs(app, owner.token, ws, 'RH Frank', 'member');
    await grant(app, owner.token, ws, frank.id, { database_id: payroll }, 'viewer');
    expect(((await adm('GET', `/workspaces/${ws}/grants?user_id=${frank.id}`)).json().data as unknown[]).length).toBe(1);
    const members = (await adm('GET', `/workspaces/${ws}/members`)).json() as Array<{ id: string; user_id?: string; userId?: string }>;
    const m = members.find((x) => (x.user_id ?? x.userId) === frank.id)!;
    expect((await adm('DELETE', `/workspaces/${ws}/members/${m.id}`)).statusCode).toBe(200);
    const surviving = (await adm('GET', `/workspaces/${ws}/grants?user_id=${frank.id}`)).json().data as unknown[];
    expect(surviving, 'the grant must not outlive the membership').toEqual([]);
    const inv = await adm('POST', `/workspaces/${ws}/invites`, { email: frank.email, role: 'member' });
    await as(frank, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    expect((await as(frank, 'GET', `${db(payroll)}/records/${payrollRec}`)).statusCode, 'no resurrected access').toBe(404);
  });
});

describe('#945 (7) a member invite carries and applies its grants, or says no — never silently drops them', () => {
  it('a member invited with a database grant holds it after accepting', async () => {
    const gina = await joinAs(app, owner.token, ws, 'RH Gina', 'member', [{ database_id: payroll, role: 'viewer' }]);
    const res = await as(gina, 'GET', `${db(payroll)}/records/${payrollRec}`);
    expect(res.statusCode, 'the grant was dropped').toBe(200);
    expect(res.json().title).toBe(SECRET);
    expect((await as(gina, 'POST', `${db(payroll)}/records`, { values: { name: 'x' } })).statusCode, 'viewer, not creator').toBe(403);
  });
  it('a record-scoped grant on a member invite is refused at invite time (422), as on POST grants', async () => {
    const res = await adm('POST', `/workspaces/${ws}/invites`, { email: 'rh-nobody@example.com', role: 'member', grants: [{ record_id: payrollRec, role: 'viewer' }] });
    expect(res.statusCode, res.body).toBe(422);
  });
  it('an admin invite with grants is refused (422): an admin needs none', async () => {
    const res = await adm('POST', `/workspaces/${ws}/invites`, { email: 'rh-admin@example.com', role: 'admin', grants: [{ database_id: payroll, role: 'viewer' }] });
    expect(res.statusCode, res.body).toBe(422);
  });
});
