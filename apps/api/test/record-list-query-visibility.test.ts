import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 — the record-level narrowing `AccessService.visibleRecordIds` adds to
 * `RecordsService.list`/`query`, and the `DatabasesService.assertAccess`
 * entry-gate fix that lets a record-scoped-only guest (#472) reach these
 * endpoints at all instead of 404-ing on the whole database.
 *
 * THIS IS A SECURITY BOUNDARY, so — per this session's own recurring lesson
 * — every assertion here uses a real guest with a real grant, never just an
 * admin/member sanity check.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let spaceId: string;
let dbId: string;
let otherDbId: string;
let recA: string;
let recB: string;
let recC: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { space_id?: string; database_id?: string; record_id?: string }, role: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...scope, role });
}

function idsOf(body: { data: Array<{ id: string }> }) {
  return body.data.map((r) => r.id).sort();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'VisListOwner');
  guest = await signUpUser(app, 'VisListGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474 List/Query WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Client briefs' })).json().id;
  otherDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Unrelated' })).json().id;

  const make = async (db: string, name: string) =>
    (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, { values: { name } })).json().id;
  recA = await make(dbId, 'Record A');
  recB = await make(dbId, 'Record B');
  recC = await make(dbId, 'Record C');

  // A grant is required to invite a guest at all — use recA's own grant as
  // the invite grant, so the guest starts with EXACTLY one record-scoped
  // grant and NOTHING at the space/database level.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: recA, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('#474: a guest with ONLY a record-scoped grant can list/query — narrowed to exactly that record', () => {
  it('GET /records — 200 (not 404), and returns ONLY recA', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json())).toEqual([recA]);
  });

  it('POST /records/query — same narrowing on the workhorse endpoint', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 50 });
    expect(res.statusCode, res.body).toBe(201);
    expect(idsOf(res.json())).toEqual([recA]);
  });

  it('recB and recC are simply ABSENT from the page — not a 403, not an empty-titled placeholder', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    const ids = idsOf(res.json());
    expect(ids).not.toContain(recB);
    expect(ids).not.toContain(recC);
  });

  it('a second record-scoped grant widens the visible set to exactly the two granted records', async () => {
    await setGrant({ record_id: recB }, 'viewer');
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(idsOf(res.json())).toEqual([recA, recB].sort());
  });

  it('ADVERSARIAL: a title search (q=) cannot be used to confirm recC exists — it never appears even when the query matches its title', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records?q=Record`);
    const ids = idsOf(res.json());
    expect(ids).not.toContain(recC);
  });
});

describe('#474: MUST KEEP WORKING — unrestricted access is unaffected', () => {
  it('a guest with NO grant anywhere on this workspace 404s on a totally unrelated database, same as before', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${otherDbId}/records`);
    expect(res.statusCode).toBe(404);
  });

  it('a guest with a DATABASE-level grant sees EVERY record — record-level narrowing never kicks in once a broader grant exists', async () => {
    const wideGuest = await signUpUser(app, 'VisListWideGuest');
    const wideGuestId = (await as(wideGuest.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: wideGuest.email,
      role: 'guest',
      grants: [{ database_id: dbId, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(wideGuest.token, 'POST', '/invites/accept', { token });
    void wideGuestId;

    const res = await as(wideGuest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(res.statusCode, res.body).toBe(200);
    expect(idsOf(res.json())).toEqual([recA, recB, recC].sort());
  });

  it('admin sees every record regardless of any guest grant configured above', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records`);
    expect(idsOf(res.json())).toEqual([recA, recB, recC].sort());
  });
});

describe('#474: aggregate() over a record-scoped guest — a count/sum must not include ungranted records', () => {
  it('count is narrowed to the granted records, not the whole database', async () => {
    // At this point the guest holds record-scoped grants on recA and recB
    // (from the describe block above) — 2 of 3 records in dbId.
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate`, { op: 'count' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().value).toBe(2);
  });

  it('admin sees the TRUE count over the same database, unaffected by the guest fixture above', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate`, { op: 'count' });
    expect(res.json().value).toBe(3);
  });
});

describe('#474: by-number lookup cannot be used to enumerate ungranted records', () => {
  let numberOfA: number;
  let numberOfC: number;

  it('setup: read the public numbers of recA (granted) and recC (NOT granted) as admin', async () => {
    numberOfA = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recA}`)).json().number;
    numberOfC = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recC}`)).json().number;
    expect(numberOfA).toEqual(expect.any(Number));
    expect(numberOfC).toEqual(expect.any(Number));
  });

  it('the guest CAN resolve their own granted record by number', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/by-number/${numberOfA}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().id).toBe(recA);
  });

  it('ADVERSARIAL: the guest CANNOT resolve recC by number, even though assertDb now lets them into the database at all', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/by-number/${numberOfC}`);
    expect(res.statusCode).toBe(404);
  });
});
