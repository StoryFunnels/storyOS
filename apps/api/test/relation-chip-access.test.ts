import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #469 — a guest granted one database of a related pair learned the OTHER
 * (denied) database's record titles through the relation chip, on three
 * routes: the records query body, the CSV export, and the links endpoint.
 * Vera's exact reproduction: a guest with `viewer` on "Wholesale Orders" but
 * no grant on "Roasts" still read each order's `roast` chip
 * `{id, title, number}`, the CSV's Roast column, and GET .../links/roast.
 *
 * Bound Vera established: the leak is the chip only — {id, title, number} —
 * never an arbitrary field on the far side. A "Cost per kg" field on Roasts
 * never travels either before or after this fix; this file does not
 * re-assert that bound, since the fix makes the whole chip absent, which is
 * strictly narrower than "some fields leak, others don't".
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ordersOnlyGuest: { token: string; email: string; id: string };
let roastsOnlyGuest: { token: string; email: string; id: string };
let bothGuest: { token: string; email: string; id: string };
let wsId: string;
let spaceId: string;
let ordersDb: string;
let roastsDb: string;
let roastField: { id: string; apiName: string }; // on Orders, -> Roasts
let ordersField: { id: string; apiName: string }; // on Roasts, -> Orders
let roastRecId: string;
let orderRecId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function inviteGuest(name: string, grants: Array<{ database_id: string }>) {
  const guest = await signUpUser(app, name);
  const guestId = (await as(guest.token, 'GET', '/me')).json().id;
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: grants.map((g) => ({ ...g, role: 'viewer' })),
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accept = await as(guest.token, 'POST', '/invites/accept', { token });
  expect(accept.statusCode, accept.body).toBeLessThan(300);
  return { ...guest, id: guestId };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RoasteryOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Roastery WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  ordersDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Wholesale Orders' })).json().id;
  roastsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Roasts' })).json().id;

  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: ordersDb,
    database_b_id: roastsDb,
    cardinality: 'one_to_many', // many orders (a) -> one roast (b)
    field_a_name: 'Roast',
    field_b_name: 'Orders',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);

  const orderFields = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ordersDb}`)).json().fields;
  roastField = orderFields.find((f: { apiName: string }) => f.apiName === 'roast');
  const roastsFields = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${roastsDb}`)).json().fields;
  ordersField = roastsFields.find((f: { apiName: string }) => f.apiName === 'orders');

  // #469 criterion 5: a rollup over the relation, so this file also proves the
  // shared fix reaches rollups (they derive their linked ids from the same
  // chips attachLinks writes) without a second patch.
  const rollup = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${roastsDb}/fields`, {
    display_name: 'Order Count',
    type: 'rollup',
    config: { relation_field_id: ordersField.id, op: 'count' },
  });
  expect(rollup.statusCode, rollup.body).toBeLessThan(300);

  roastRecId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${roastsDb}/records`, { values: { name: 'Ethiopia Guji' } })
  ).json().id;
  orderRecId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ordersDb}/records`, {
      values: { name: 'NW-1001 March restock', roast: [roastRecId] },
    })
  ).json().id;

  ordersOnlyGuest = await inviteGuest('OrdersOnlyGuest', [{ database_id: ordersDb }]);
  roastsOnlyGuest = await inviteGuest('RoastsOnlyGuest', [{ database_id: roastsDb }]);
  bothGuest = await inviteGuest('BothGuest', [{ database_id: ordersDb }, { database_id: roastsDb }]);
});

afterAll(async () => {
  await app.close();
});

describe('#469 relation chip readers do not leak a denied database through a chip', () => {
  it('sanity: the guest really is denied Roasts on the direct routes', async () => {
    expect((await as(ordersOnlyGuest.token, 'GET', `/workspaces/${wsId}/databases/${roastsDb}`)).statusCode).toBe(404);
    expect(
      (await as(ordersOnlyGuest.token, 'POST', `/workspaces/${wsId}/databases/${roastsDb}/records/query`, {})).statusCode,
    ).toBe(404);
  });

  it('the query response body omits the roast chip for a database the guest cannot see', async () => {
    const res = await as(ordersOnlyGuest.token, 'POST', `/workspaces/${wsId}/databases/${ordersDb}/records/query`, {});
    expect(res.statusCode, res.body).toBeLessThan(300);
    const order = res.json().data.find((r: { id: string }) => r.id === orderRecId);
    expect(order, 'the order itself must still be visible').toBeTruthy();
    expect(order.values['roast']).toBeUndefined();
  });

  it('the CSV export omits the roast title from the Roast column', async () => {
    const res = await as(ordersOnlyGuest.token, 'GET', `/workspaces/${wsId}/databases/${ordersDb}/export/csv`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain('Ethiopia Guji');
  });

  it('the links endpoint returns an empty list, not the denied database\'s record', async () => {
    const res = await as(
      ordersOnlyGuest.token,
      'GET',
      `/workspaces/${wsId}/databases/${ordersDb}/records/${orderRecId}/links/${roastField.apiName}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toEqual([]);
  });

  it('reverse direction: granted Roasts, denied Orders — the Orders chip and links are absent too', async () => {
    const query = await as(roastsOnlyGuest.token, 'POST', `/workspaces/${wsId}/databases/${roastsDb}/records/query`, {});
    expect(query.statusCode, query.body).toBeLessThan(300);
    const roast = query.json().data.find((r: { id: string }) => r.id === roastRecId);
    expect(roast.values['orders']).toBeUndefined();

    const links = await as(
      roastsOnlyGuest.token,
      'GET',
      `/workspaces/${wsId}/databases/${roastsDb}/records/${roastRecId}/links/${ordersField.apiName}`,
    );
    expect(links.statusCode, links.body).toBe(200);
    expect(links.json().data).toEqual([]);

    // The rollup counts a relation the guest cannot see into: zero, not the
    // real count of 1 — it derives from the same withheld chips, no second fix.
    const roastRow = query.json().data.find((r: { id: string }) => r.id === roastRecId);
    expect(roastRow.values['order_count']).toBe(0);
  });

  it('MUST KEEP WORKING: admin sees the chip, the CSV cell and the links row exactly as before', async () => {
    const query = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ordersDb}/records/query`, {});
    const order = query.json().data.find((r: { id: string }) => r.id === orderRecId);
    expect(order.values['roast']).toEqual([{ id: roastRecId, title: 'Ethiopia Guji', number: expect.any(Number) }]);

    const csv = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ordersDb}/export/csv`);
    expect(csv.body).toContain('Ethiopia Guji');

    const links = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ordersDb}/records/${orderRecId}/links/${roastField.apiName}`);
    expect(links.json().data).toEqual([{ id: roastRecId, title: 'Ethiopia Guji', number: expect.any(Number) }]);

    const roastQuery = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${roastsDb}/records/query`, {});
    const roast = roastQuery.json().data.find((r: { id: string }) => r.id === roastRecId);
    expect(roast.values['order_count']).toBe(1);
  });

  it('MUST KEEP WORKING: a guest granted BOTH databases still sees the chip', async () => {
    const res = await as(bothGuest.token, 'POST', `/workspaces/${wsId}/databases/${ordersDb}/records/query`, {});
    const order = res.json().data.find((r: { id: string }) => r.id === orderRecId);
    expect(order.values['roast']).toEqual([{ id: roastRecId, title: 'Ethiopia Guji', number: expect.any(Number) }]);
  });

  it('MUST KEEP WORKING: the deny side is unchanged — direct access to a denied database still 404s, never 403', async () => {
    const res = await as(ordersOnlyGuest.token, 'GET', `/workspaces/${wsId}/databases/${roastsDb}`);
    expect(res.statusCode).toBe(404);
  });
});
