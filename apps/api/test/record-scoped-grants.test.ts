import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { accessGrants, records } from '../src/db/schema';

/**
 * #472 — a third scope on access_grants: recordId, alongside spaceId/databaseId.
 * access_grants_scope_xor widened from "exactly one of two" to "exactly one of
 * three"; AccessService.effectiveForRecord takes the max of a space grant, a
 * database grant, and a record grant ("highest grant wins", same rule, third
 * scope). Enforcement lives on RecordsController's get/update/remove via the
 * new RecordsService.assertRecordAccess.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let spaceId: string;
let dbId: string;
let recA: string;
let recB: string;
const { db } = connectTestDb();

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { space_id?: string; database_id?: string; record_id?: string }, role: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...scope, role });
}

async function listGrantsFor(recordId: string) {
  const res = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json();
  const list = Array.isArray(res) ? res : res.data;
  return list.filter((g: { record_id?: string; recordId?: string }) => (g.record_id ?? g.recordId) === recordId);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RecGrantOwner');
  guest = await signUpUser(app, 'RecGrantGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '472 WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Shared briefs' })).json().id;
  recA = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;
  recB = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;

  // A throwaway grant is required to invite a guest at all — placed on a
  // record neither test below touches, then left in place (harmless).
  const bystander = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: bystander, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('a record grant reaches ONLY the named record (#472)', () => {
  it('a guest with zero space/database grant, only a record grant on recA, can read and write recA', async () => {
    await setGrant({ record_id: recA }, 'editor');
    const get = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recA}`);
    expect(get.statusCode, get.body).toBe(200);
    const patch = await as(guest.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recA}`, { values: {} });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
  });

  it('the SAME guest cannot reach recB — the grant does not leak to a sibling record', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recB}`);
    expect(res.statusCode).toBe(404);
  });

  it('a viewer-rank record grant can read but not write (403, not 404)', async () => {
    await setGrant({ record_id: recB }, 'viewer');
    expect((await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recB}`)).statusCode).toBe(200);
    const patch = await as(guest.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recB}`, { values: {} });
    expect(patch.statusCode).toBe(403);
  });
});

describe('highest grant wins, extended to the third scope, in both orders (#472 AC6)', () => {
  it('a space grant (viewer) THEN a record grant (editor) on a record inside it — editor wins', async () => {
    await setGrant({ space_id: spaceId }, 'viewer');
    await setGrant({ record_id: recA }, 'editor');
    const patch = await as(guest.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recA}`, { values: {} });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
  });

  it('a record grant (viewer) THEN a space grant (editor) covering it — editor still wins (order does not matter)', async () => {
    await setGrant({ record_id: recA }, 'viewer');
    await setGrant({ space_id: spaceId }, 'editor');
    const patch = await as(guest.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recA}`, { values: {} });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
  });
});

describe('MN-125 the third time: concurrent record grants upsert to ONE row, revoke actually revokes (#472 AC4)', () => {
  it('concurrent grants on the same (user, record) collapse to one row', async () => {
    const results = await Promise.all([
      setGrant({ record_id: recB }, 'viewer'),
      setGrant({ record_id: recB }, 'editor'),
      setGrant({ record_id: recB }, 'commenter'),
    ]);
    expect(results.every((r) => r.statusCode < 300), JSON.stringify(results.map((r) => r.statusCode))).toBe(true);
    expect(await listGrantsFor(recB), 'the unique index must collapse these to one row').toHaveLength(1);
  });

  it('revoking the record grant actually removes access — not just the row count', async () => {
    // recB currently also carries the "viewer-rank record grant" from an
    // earlier describe block via space_id — isolate: remove any space grant
    // first so only the record grant is in play.
    const all = (await as(admin.token, 'GET', `/workspaces/${wsId}/grants`)).json().data as Array<{
      id: string;
      space_id?: string | null;
      record_id?: string | null;
    }>;
    for (const g of all.filter((x) => x.space_id)) await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${g.id}`);

    const [target] = await listGrantsFor(recB);
    const res = await as(admin.token, 'DELETE', `/workspaces/${wsId}/grants/${target.id}`);
    expect(res.statusCode, res.body).toBeLessThan(300);

    expect(await listGrantsFor(recB), 'a "successful" revoke that leaves a row behind leaves access behind').toHaveLength(0);
    const after = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recB}`);
    expect(after.statusCode, 'access must be GONE, not just the row').toBe(404);
  });
});

describe('MUST KEEP WORKING: exactly-one-of-three, and the two pre-existing scopes (#472)', () => {
  it('refuses a grant naming two scopes, and one naming none', async () => {
    const two = await setGrant({ space_id: spaceId, record_id: recA }, 'viewer');
    const none = await as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, role: 'viewer' });
    expect(two.statusCode).toBeGreaterThanOrEqual(400);
    expect(none.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses a record_id from a different workspace', async () => {
    const otherAdmin = await signUpUser(app, 'OtherWsAdminForGrants');
    const otherWs = (await as(otherAdmin.token, 'POST', '/workspaces', { name: 'Other WS' })).json().id;
    const otherSpace = (await as(otherAdmin.token, 'GET', `/workspaces/${otherWs}/spaces`)).json()[0].id;
    const otherDb = (await as(otherAdmin.token, 'POST', `/workspaces/${otherWs}/databases`, { space_id: otherSpace, name: 'Foreign' })).json().id;
    const foreignRec = (await as(otherAdmin.token, 'POST', `/workspaces/${otherWs}/databases/${otherDb}/records`, { values: {} })).json().id;

    const res = await setGrant({ record_id: foreignRec }, 'viewer');
    expect(res.statusCode).toBe(404);
  });

  it('space- and database-scoped grants are unaffected by the widened CHECK', async () => {
    const spaceGrant = await setGrant({ space_id: spaceId }, 'viewer');
    expect(spaceGrant.statusCode, spaceGrant.body).toBeLessThan(300);
    const dbGrant = await setGrant({ database_id: dbId }, 'contributor');
    expect(dbGrant.statusCode, dbGrant.body).toBeLessThan(300);
  });
});

describe('cascade: deleting a record removes its grants (#472 AC8, the databaseId FK precedent applied to recordId)', () => {
  it('a hard-deleted record leaves no dangling grant row', async () => {
    const doomed = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json().id;
    await setGrant({ record_id: doomed }, 'viewer');
    expect(await listGrantsFor(doomed)).toHaveLength(1);

    await db.delete(records).where(eq(records.id, doomed));

    const [row] = await db.select().from(accessGrants).where(eq(accessGrants.recordId, doomed));
    expect(row, 'the FK cascade must remove the grant, not leave a dangling row matching a recycled id').toBeUndefined();
  });
});
