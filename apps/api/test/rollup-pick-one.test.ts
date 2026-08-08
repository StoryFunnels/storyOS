import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #286 — first/last rollups end to end: "Last Ticket by ID", "Status of the
 * latest Invoice", "a link to the newest one".
 *
 * The comparison rules themselves are unit-tested in
 * src/records/rollup-pick-one.test.ts; this file covers the parts only a real
 * database can prove — config validation, resolution through actual links, the
 * filter applying BEFORE the ordering, and freshness after a change.
 */

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let clientsDb: string;
let ticketsDb: string;
let clientFieldId: string; // relation field on Tickets → Clients
let ticketsFieldId: string; // inverse relation field on Clients → Tickets
/** Select values are written by option id, so the tests need the real ids. */
let statusOptionId: Record<string, string>;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

const addField = (db: string, body: unknown) => inject('POST', `/workspaces/${wsId}/databases/${db}/fields`, body);

async function client(name: string) {
  return (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name } })).json();
}

/** A ticket linked to `clientId`, so the pick-one rollup has candidates. */
async function ticket(clientId: string, values: Record<string, unknown>) {
  const rec = (await inject('POST', `/workspaces/${wsId}/databases/${ticketsDb}/records`, { values })).json();
  const link = await inject(
    'PUT',
    `/workspaces/${wsId}/databases/${ticketsDb}/records/${rec.id}/links/${clientFieldId}`,
    { record_ids: [clientId] },
  );
  expect(link.statusCode, link.body).toBeLessThan(300);
  return rec;
}

async function readClient(id: string) {
  return (await inject('GET', `/workspaces/${wsId}/databases/${clientsDb}/records/${id}`)).json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Rita');
  wsId = (await inject('POST', '/workspaces', { name: 'PickOne WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  clientsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  ticketsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  await addField(ticketsDb, { display_name: 'Opened', type: 'date' });
  const status = await addField(ticketsDb, {
    display_name: 'Status',
    type: 'select',
    options: [{ label: 'Open' }, { label: 'Closed' }],
  });
  statusOptionId = Object.fromEntries(
    (status.json().options as Array<{ id: string; label: string }>).map((o) => [o.label, o.id]),
  );

  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: ticketsDb,
    database_b_id: clientsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Client',
    field_b_name: 'Tickets',
  });
  const ticketFields = (await inject('GET', `/workspaces/${wsId}/databases/${ticketsDb}`)).json().fields;
  clientFieldId = ticketFields.find((f: { apiName: string }) => f.apiName === 'client').id;
  const clientFields = (await inject('GET', `/workspaces/${wsId}/databases/${clientsDb}`)).json().fields;
  ticketsFieldId = clientFields.find((f: { apiName: string }) => f.apiName === 'tickets').id;
});

afterAll(async () => {
  await app.close();
});

describe('first/last rollup config (#286)', () => {
  it('requires an order_by field', async () => {
    const res = await addField(clientsDb, {
      display_name: 'Broken Last',
      type: 'rollup',
      config: { relation_field_id: ticketsFieldId, op: 'last', target_field_api_name: 'name' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('order_by_field_api_name');
  });

  it('rejects an unknown or non-comparable order_by field', async () => {
    const missing = await addField(clientsDb, {
      display_name: 'Broken Last 2',
      type: 'rollup',
      config: { relation_field_id: ticketsFieldId, op: 'last', order_by_field_api_name: 'nope' },
    });
    expect(missing.statusCode).toBe(422);
    // The relation field on Tickets is multi-valued — there is no single value to
    // order by, so it's refused at config time rather than resolving to null forever.
    const bad = await addField(clientsDb, {
      display_name: 'Broken Last 3',
      type: 'rollup',
      config: { relation_field_id: ticketsFieldId, op: 'last', order_by_field_api_name: 'client' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('does NOT require a target field — omitting it means "link to the record"', async () => {
    const res = await addField(clientsDb, {
      display_name: 'Last Ticket Link',
      type: 'rollup',
      config: { relation_field_id: ticketsFieldId, op: 'last', order_by_field_api_name: 'number' },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('first/last rollup resolution (#286)', () => {
  it('orders by the public #id and returns the winning record\'s title', async () => {
    const created = await addField(clientsDb, {
      display_name: 'Last Ticket',
      type: 'rollup',
      config: {
        relation_field_id: ticketsFieldId,
        op: 'last',
        order_by_field_api_name: 'number',
        target_field_api_name: 'name',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = await addField(clientsDb, {
      display_name: 'First Ticket',
      type: 'rollup',
      config: {
        relation_field_id: ticketsFieldId,
        op: 'first',
        order_by_field_api_name: 'number',
        target_field_api_name: 'name',
      },
    });
    expect(first.statusCode, first.body).toBe(201);

    const acme = await client('Acme');
    await ticket(acme.id, { name: 'Printer jam' });
    await ticket(acme.id, { name: 'Laptop dead' });
    await ticket(acme.id, { name: 'VPN down' });

    const read = await readClient(acme.id);
    // Ordering by number, not by title — "VPN down" is newest, "Printer jam" oldest.
    expect(read.values.last_ticket).toBe('VPN down');
    expect(read.values.first_ticket).toBe('Printer jam');
  });

  it('is empty — not an error — for a client with no tickets', async () => {
    const empty = await client('Nobody');
    const read = await readClient(empty.id);
    expect(read.values.last_ticket).toBeNull();
  });

  it('returns a clickable chip (id + database_id) when no target field is set', async () => {
    const globex = await client('Globex');
    const newest = await ticket(globex.id, { name: 'Only ticket' });
    const read = await readClient(globex.id);
    expect(read.values.last_ticket_link).toMatchObject({
      id: newest.id,
      title: 'Only ticket',
      database_id: ticketsDb,
    });
  });

  it('resolves a select target to its LABEL, not the option id', async () => {
    const created = await addField(clientsDb, {
      display_name: 'Latest Status',
      type: 'rollup',
      config: {
        relation_field_id: ticketsFieldId,
        op: 'last',
        order_by_field_api_name: 'opened',
        target_field_api_name: 'status',
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const initech = await client('Initech');
    await ticket(initech.id, { name: 'Old', opened: '2026-01-01', status: statusOptionId['Open'] });
    await ticket(initech.id, { name: 'New', opened: '2026-06-01', status: statusOptionId['Closed'] });

    const read = await readClient(initech.id);
    expect(read.values.latest_status).toBe('Closed');
  });

  it('ignores related records whose ordering value is empty', async () => {
    const hooli = await client('Hooli');
    await ticket(hooli.id, { name: 'Dated', opened: '2026-02-01', status: statusOptionId['Open'] });
    await ticket(hooli.id, { name: 'Undated', status: statusOptionId['Closed'] }); // no `opened` at all
    const read = await readClient(hooli.id);
    // "the latest ticket" must not be the one with no date.
    expect(read.values.latest_status).toBe('Open');
  });

  it('applies the rollup filter BEFORE picking the winner', async () => {
    const created = await addField(clientsDb, {
      display_name: 'Latest Open Ticket',
      type: 'rollup',
      config: {
        relation_field_id: ticketsFieldId,
        op: 'last',
        order_by_field_api_name: 'opened',
        target_field_api_name: 'name',
        filter: { and: [{ field: 'status', op: 'eq', value: statusOptionId['Open'] }] },
      },
    });
    expect(created.statusCode, created.body).toBe(201);

    const umbrella = await client('Umbrella');
    await ticket(umbrella.id, { name: 'Old but open', opened: '2026-01-01', status: statusOptionId['Open'] });
    await ticket(umbrella.id, { name: 'Newer but closed', opened: '2026-09-01', status: statusOptionId['Closed'] });

    const read = await readClient(umbrella.id);
    // Without the filter the answer would be "Newer but closed".
    expect(read.values.latest_open_ticket).toBe('Old but open');
  });

  it('reflects a later change to the winning record on the next read', async () => {
    const stark = await client('Stark');
    const only = await ticket(stark.id, { name: 'Before rename', opened: '2026-03-01', status: statusOptionId['Open'] });
    const before = await readClient(stark.id);
    expect(before.values.latest_open_ticket).toBe('Before rename');

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${ticketsDb}/records/${only.id}`, {
      values: { name: 'After rename' },
    });
    expect(patch.statusCode, patch.body).toBeLessThan(300);

    // first/last resolves at READ time (deliberately not materialized), so this
    // needs no invalidation plumbing — but that's exactly the claim worth pinning.
    const after = await readClient(stark.id);
    expect(after.values.latest_open_ticket).toBe('After rename');
  });

  it('refuses to sort or filter by a first/last rollup instead of silently matching nothing', async () => {
    const sorted = await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records/query`, {
      sorts: [{ field: 'last_ticket', direction: 'desc' }],
    });
    expect(sorted.statusCode).toBe(422);
    const filtered = await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records/query`, {
      filter: { and: [{ field: 'last_ticket', op: 'eq', value: 'VPN down' }] },
    });
    expect(filtered.statusCode).toBe(422);
  });
});
