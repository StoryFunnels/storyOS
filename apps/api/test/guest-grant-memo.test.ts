import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';

/**
 * #861 — a guest's `access_grants` are read ONCE per request, and the memo that makes that so
 * cannot outlive the request. Two halves, because the second is the one that matters:
 *
 *   1. the saving: count the `access_grants` statements for the same GET a guest makes;
 *   2. REVOCATION STAYS IMMEDIATE (MN-125 shipped "revoke reported success, access persisted"
 *      once): grant -> the guest reads -> revoke -> the guest's NEXT request is refused. Tested
 *      directly, not reasoned from the memo's scope. Also grant widening, and a revocation
 *      racing a request that already memoised.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let dbId: string;
let rec: string;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const recUrl = (id: string) => `/workspaces/${wsId}/databases/${dbId}/records/${id}`;

/** `access_grants` statements the pool receives while `fn` runs. */
async function grantReads(fn: () => Promise<unknown>): Promise<number> {
  const pool = (app.get(DB) as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
  const original = pool.query.bind(pool);
  let n = 0;
  pool.query = (...args: unknown[]) => {
    const text = String((args[0] as { text?: string })?.text ?? args[0]);
    if (/from "access_grants"/i.test(text) && /^\s*select/i.test(text)) n += 1;
    return original(...args);
  };
  try {
    await fn();
  } finally {
    pool.query = original;
  }
  return n;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Memo Admin');
  guest = await signUpUser(app, 'Memo Guest');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'memo ws' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'shared one' } })).json().id;
  // A guest with a throwaway grant (so they are a member), whose real grant we add/revoke below.
  const other = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'other' } })).json().id as string;
  const inv = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email, role: 'guest', grants: [{ record_id: other, role: 'viewer' }],
  });
  expect(inv.statusCode, inv.body).toBeLessThan(300);
  await as(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  const me = (await as(guest.token, 'GET', '/me')).json();
  guestId = (me.user?.id ?? me.id) as string;
}, 120_000);

afterAll(async () => {
  await app.close();
});

const grant = (payload: Record<string, unknown>) => as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...payload });

describe('#861 — the saving', () => {
  it('a record-scoped guest reads access_grants once per GET /records/:id; an admin reads none', async () => {
    const g = await grant({ record_id: rec, role: 'viewer' });
    expect(g.statusCode, g.body).toBeLessThan(300);
    let status = 0;
    const guestReads = await grantReads(async () => {
      status = (await as(guest.token, 'GET', recUrl(rec))).statusCode;
    });
    expect(status).toBe(200);
    // Before the memo this request read access_grants twice (measured 2026-10-09; the no-memo
    // mutation of this test fails it with exactly that). Total statement counts are NOT asserted:
    // background work (position repair, select-option loads) lands in the window at random.
    expect(guestReads, 'access_grants reads for one guest GET').toBeLessThanOrEqual(1);
    const adminReads = await grantReads(() => as(admin.token, 'GET', recUrl(rec)));
    expect(adminReads, 'admin/member resolve no grants and acquire none').toBe(0);
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.json().id}`);
  });
});

describe('#861 x #857 — the memo is the OUTER interceptor, so mention narrowing shares it', () => {
  it('a guest GET whose body carries a record mention still reads access_grants once (not once for the access check and again for the narrowing)', async () => {
    const hidden = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'hidden target' } })).json().id as string;
    const doc = await as(admin.token, 'PUT', `${recUrl(rec)}/document`, {
      content: [{ type: 'paragraph', content: [{ type: 'mention', props: { kind: 'record', id: hidden, label: 'hidden target' } }] }],
      expected_version: 0,
    });
    expect(doc.statusCode, doc.body).toBeLessThan(300);
    const g = await grant({ record_id: rec, role: 'viewer' });
    await as(guest.token, 'GET', `${recUrl(rec)}/document`); // warm-up
    let body = '';
    const reads = await grantReads(async () => {
      const res = await as(guest.token, 'GET', `${recUrl(rec)}/document`);
      expect(res.statusCode, res.body).toBe(200);
      body = res.body;
    });
    expect(body, 'the narrowing really ran on this response').toContain('[restricted]');
    // Registered the other way round, the narrowing resolves OUTSIDE the memo's store and the same
    // request reads access_grants twice: correctness holds, the saving silently does not.
    expect(reads, 'access_grants reads for a guest GET that goes through the narrowing').toBeLessThanOrEqual(1);
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.json().id}`);
  });
});

describe('#861 — REVOCATION STAYS IMMEDIATE (the criterion that matters)', () => {
  it('grant -> guest reads -> revoke -> the guest\'s NEXT request is refused', async () => {
    const g = await grant({ record_id: rec, role: 'viewer' });
    expect(g.statusCode, g.body).toBeLessThan(300);
    expect((await as(guest.token, 'GET', recUrl(rec))).statusCode, 'granted: readable').toBe(200);
    expect((await as(guest.token, 'GET', recUrl(rec))).statusCode, 'still readable on a second request').toBe(200);

    const revoked = await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.json().id}`);
    expect(revoked.statusCode, revoked.body).toBeLessThan(300);
    expect(revoked.json().removed).toBeGreaterThanOrEqual(1);

    const after = await as(guest.token, 'GET', recUrl(rec));
    expect(after.statusCode, `revoked: the very next request must be refused, got ${after.body}`).toBe(404);
    const list = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {});
    expect(JSON.stringify(list.json()), 'and the list no longer carries the record').not.toContain('shared one');
  });

  it('widening is immediate too: a new database grant is honoured by the next request', async () => {
    expect((await as(guest.token, 'GET', recUrl(rec))).statusCode).toBe(404);
    const g = await grant({ database_id: dbId, role: 'viewer' });
    expect(g.statusCode, g.body).toBeLessThan(300);
    expect((await as(guest.token, 'GET', recUrl(rec))).statusCode, 'newly granted: readable on the next request').toBe(200);
    await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.json().id}`);
    expect((await as(guest.token, 'GET', recUrl(rec))).statusCode, 'and refused again after the revoke').toBe(404);
  });

  it('a revoke that lands WHILE another request is in flight does not leak into the next one', async () => {
    const g = await grant({ record_id: rec, role: 'viewer' });
    // Many concurrent guest reads, a revoke in the middle, then a fresh one: the fresh one is refused.
    const reads = Array.from({ length: 8 }, () => as(guest.token, 'GET', recUrl(rec)));
    const revoke = as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.json().id}`);
    await Promise.all([...reads, revoke]);
    const next = await as(guest.token, 'GET', recUrl(rec));
    expect(next.statusCode, 'a memo from an earlier request must not be remembered').toBe(404);
  });
});
