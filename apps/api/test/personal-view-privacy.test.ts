import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';

/**
 * Ticket #1051 — a personal view is private from everyone else, admins included (ADR-0017). Every by-id route on a database's
 * views treats another member's personal view as not there, and removing a member from one workspace removes their personal
 * views in THAT workspace only.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let owner: Person;
let wsA: string;
let wsB: string;
let dbA: string;
let dbB: string;

const cfg = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const personal = async (token: string, ws: string, db: string, name: string): Promise<string> =>
  (await fx(token, 'POST', `/workspaces/${ws}/databases/${db}/views/personal`, { name, type: 'table', config: cfg })).id;
const viewsOf = (ws: string, db: string) => `/workspaces/${ws}/databases/${db}/views`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Privacy Admin');
  for (const name of ['Privacy A', 'Privacy B']) {
    const ws = (await fx(admin.token, 'POST', '/workspaces', { name })).id;
    const space = (await fx(admin.token, 'GET', `/workspaces/${ws}/spaces`))[0].id;
    const db = (await fx(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: `${name} DB` })).id;
    if (name === 'Privacy A') [wsA, dbA] = [ws, db];
    else [wsB, dbB] = [ws, db];
  }
  owner = await joinAs(app, admin.token, wsA, 'Privacy Owner', 'member');
  // The same person in a second workspace.
  const inv = await fx(admin.token, 'POST', `/workspaces/${wsB}/invites`, { email: owner.email, role: 'member' });
  await fx(owner.token, 'POST', '/invites/accept', { token: new URL(inv.accept_url).searchParams.get('token')! });
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe("#1051 another member's personal view is a 404 on every by-id route, for an admin too", () => {
  let mine: string;
  beforeAll(async () => {
    mine = await personal(owner.token, wsA, dbA, 'Owner only');
  });

  it.each([
    ['PATCH', '', { name: 'Hijacked' }],
    ['POST', '/duplicate', undefined],
    ['POST', '/default', undefined],
    ['POST', '/share', {}],
    ['POST', '/publish', undefined],
    ['DELETE', '', undefined],
  ])('%s …/views/:view%s', async (method, suffix, payload) => {
    const res = await call(app, admin.token, method, `${viewsOf(wsA, dbA)}/${mine}${suffix}`, payload);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the view is untouched and still the owner’s', async () => {
    const res = await call(app, owner.token, 'PATCH', `${viewsOf(wsA, dbA)}/${mine}`, { name: 'Still mine' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().ownerUserId).toBe(owner.id);
  });

  it('a deleted personal view stays private in the trash, and cannot be restored by someone else', async () => {
    const gone = await personal(owner.token, wsA, dbA, 'Trashed lens');
    expect((await call(app, owner.token, 'DELETE', `${viewsOf(wsA, dbA)}/${gone}`)).statusCode).toBeLessThan(300);
    const adminTrash = await fx(admin.token, 'GET', `${viewsOf(wsA, dbA)}/trash`);
    expect(adminTrash.map((v: { id: string }) => v.id)).not.toContain(gone);
    const ownerTrash = await fx(owner.token, 'GET', `${viewsOf(wsA, dbA)}/trash`);
    expect(ownerTrash.map((v: { id: string }) => v.id)).toContain(gone);
    expect((await call(app, admin.token, 'POST', `${viewsOf(wsA, dbA)}/${gone}/restore`)).statusCode).toBe(404);
    expect((await call(app, owner.token, 'POST', `${viewsOf(wsA, dbA)}/${gone}/restore`)).statusCode).toBeLessThan(300);
  });

  it('the owner cannot make a personal view the database default, and a duplicate of it stays personal', async () => {
    const res = await call(app, owner.token, 'POST', `${viewsOf(wsA, dbA)}/${mine}/default`);
    expect(res.statusCode, res.body).toBe(422);
    const copy = await call(app, owner.token, 'POST', `${viewsOf(wsA, dbA)}/${mine}/duplicate`);
    expect(copy.statusCode, copy.body).toBeLessThan(300);
    expect(copy.json().ownerUserId).toBe(owner.id);
  });
});

describe('#1051 removing a member deletes their personal views in that workspace only', () => {
  it('a member removed from A keeps their personal views in B', async () => {
    const inA = await personal(owner.token, wsA, dbA, 'Lens in A');
    const inB = await personal(owner.token, wsB, dbB, 'Lens in B');
    const members = await fx(admin.token, 'GET', `/workspaces/${wsA}/members`);
    const list = (Array.isArray(members) ? members : members.data) as Array<{ id: string; user_id?: string; userId?: string }>;
    const membership = list.find((m) => (m.user_id ?? m.userId) === owner.id)!;
    expect(membership, JSON.stringify(list[0])).toBeDefined();
    expect((await call(app, admin.token, 'DELETE', `/workspaces/${wsA}/members/${membership.id}`)).statusCode).toBeLessThan(300);

    const stillInB = await call(app, owner.token, 'PATCH', `${viewsOf(wsB, dbB)}/${inB}`, { name: 'Lens in B, kept' });
    expect(stillInB.statusCode, stillInB.body).toBe(200);
    const goneInA = await call(app, admin.token, 'PATCH', `${viewsOf(wsA, dbA)}/${inA}`, { name: 'x' });
    expect(goneInA.statusCode).toBe(404);
  });
});
