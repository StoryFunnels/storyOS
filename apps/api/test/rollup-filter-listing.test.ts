import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import { fields, recordLinks, records } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { RecordsService } from '../src/records/records.service';
import { FieldsService } from '../src/fields/fields.service';

/**
 * Ticket #1314 — a rollup whose FILTER names a relation of the linked database (a person's payments for ONE event) made every
 * listing of the database fail with a server error. Synthetic data only: People, Payments, Events, generated here.
 *
 * Root cause: the filtered rollup fetched its linked records with `db.query.records.findMany({ where })`. Drizzle's relational query
 * builder rewrites EVERY column inside that `where` to the root table's alias, including the columns of the `EXISTS (SELECT 1 FROM
 * record_links ...)` subquery a relation filter compiles to, so it asked for `records.relation_id` and Postgres answered "column
 * records.relation_id does not exist".
 */

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string };
let wsId: string;
let peopleDb: string;
let paymentsDb: string;
let eventsDb: string;
let paymentsOfPersonFieldId: string; // relation field on People -> Payments
let eventFieldId: string; // relation field on Payments -> Events
let personFieldOnPayments: string;
let paymentsRelationId: string;
const eventIds: string[] = [];
const personIds: string[] = [];

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function makeDb(spaceId: string, name: string) {
  return (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json()
    .id as string;
}

async function fieldIdOf(dbId: string, apiName: string) {
  const list = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json()
    .fields as Array<{ apiName: string; id: string }>;
  return list.find((f) => f.apiName === apiName)!.id;
}

async function queryAll(dbId: string, token = admin.token) {
  return inject(
    'POST',
    `/workspaces/${wsId}/databases/${dbId}/records/query`,
    { limit: 200 },
    token,
  );
}

type Row = { id: string; title: string; values: Record<string, unknown> };
const byTitle = (rows: Row[], title: string) => rows.find((r) => r.title === title)!;

async function addRollup(name: string, config: Record<string, unknown>) {
  return inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/fields`, {
    display_name: name,
    type: 'rollup',
    config: { relation_field_id: paymentsOfPersonFieldId, ...config },
  });
}

const PEOPLE = 40;
const SUMMIT_FILTER = () => ({ field: 'event', op: 'has', value: [eventIds[0]] });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'Rae');
  wsId = (await inject('POST', '/workspaces', { name: 'Rollup Filter WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  peopleDb = await makeDb(spaceId, 'People');
  paymentsDb = await makeDb(spaceId, 'Payments');
  eventsDb = await makeDb(spaceId, 'Events');
  await inject('POST', `/workspaces/${wsId}/databases/${paymentsDb}/fields`, {
    display_name: 'Amount',
    type: 'number',
  });

  const pp = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: paymentsDb,
    database_b_id: peopleDb,
    cardinality: 'one_to_many',
    field_a_name: 'Person',
    field_b_name: 'Payments',
  });
  expect(pp.statusCode, pp.body).toBe(201);
  paymentsRelationId = pp.json().id;
  const pe = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: paymentsDb,
    database_b_id: eventsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Event',
    field_b_name: 'Payments',
  });
  expect(pe.statusCode, pe.body).toBe(201);
  paymentsOfPersonFieldId = await fieldIdOf(peopleDb, 'payments');
  eventFieldId = await fieldIdOf(paymentsDb, 'event');
  personFieldOnPayments = await fieldIdOf(paymentsDb, 'person');

  for (const name of ['Summit', 'Gala']) {
    eventIds.push(
      (
        await inject('POST', `/workspaces/${wsId}/databases/${eventsDb}/records`, {
          values: { name },
        })
      ).json().id,
    );
  }
  for (let i = 0; i < PEOPLE; i++) {
    personIds.push(
      (
        await inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/records`, {
          values: { name: `Person ${i}` },
        })
      ).json().id,
    );
  }
  // Person i has (i % 3) + 1 payments of 10 each; payment j is for event j % 2 (0 = Summit, 1 = Gala).
  for (let i = 0; i < PEOPLE; i++) {
    for (let j = 0; j < (i % 3) + 1; j++) {
      const pay = (
        await inject('POST', `/workspaces/${wsId}/databases/${paymentsDb}/records`, {
          values: { name: `P${i}-${j}`, amount: 10 },
        })
      ).json();
      expect(
        (
          await inject(
            'PUT',
            `/workspaces/${wsId}/databases/${paymentsDb}/records/${pay.id}/links/${personFieldOnPayments}`,
            { record_ids: [personIds[i]] },
          )
        ).statusCode,
      ).toBeLessThan(300);
      expect(
        (
          await inject(
            'PUT',
            `/workspaces/${wsId}/databases/${paymentsDb}/records/${pay.id}/links/${eventFieldId}`,
            { record_ids: [eventIds[j % 2]] },
          )
        ).statusCode,
      ).toBeLessThan(300);
    }
  }
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('ticket #1314: a rollup filtered on a relation of the linked records', () => {
  let summitApi: string;

  it('lists the whole database with correct filtered rollup values (sum, count, first, collect-free read path)', async () => {
    const created = await addRollup('Summit Total', {
      op: 'sum',
      target_field_api_name: 'amount',
      filter: SUMMIT_FILTER(),
    });
    expect(created.statusCode, created.body).toBe(201);
    summitApi = created.json().apiName as string;
    const count = await addRollup('Summit Count', { op: 'count', filter: SUMMIT_FILTER() });
    expect(count.statusCode, count.body).toBe(201);
    const first = await addRollup('Summit First', {
      op: 'first',
      order_by_field_api_name: 'amount',
      target_field_api_name: 'amount',
      filter: SUMMIT_FILTER(),
    });
    expect(first.statusCode, first.body).toBe(201);

    const res = await queryAll(peopleDb);
    expect(res.statusCode, res.body).toBeLessThan(300);
    const rows = res.json().data as Row[];
    expect(rows).toHaveLength(PEOPLE);
    // Person i: payments j = 0..(i%3); the Summit ones are the even j (0, 2): i%3==0 -> 1, 1 -> 1, 2 -> 2 of them.
    for (let i = 0; i < PEOPLE; i++) {
      const row = byTitle(rows, `Person ${i}`);
      const n = [1, 1, 2][i % 3]!;
      expect(row.values[summitApi], `sum, Person ${i}`).toBe(n * 10);
      expect(row.values[count.json().apiName], `count, Person ${i}`).toBe(n);
      expect(row.values[first.json().apiName], `first, Person ${i}`).toBe(10);
    }
    // The read-time path (a single record GET) agrees.
    const one = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${peopleDb}/records/${personIds[2]}`,
    );
    expect(one.statusCode, one.body).toBeLessThan(300);
    expect(one.json().values[summitApi]).toBe(20);
    // And the materialized value the filter/sort path reads agrees too.
    const filtered = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${peopleDb}/records/query`,
      {
        filter: { field: summitApi, op: 'gt', value: 10 },
        limit: 200,
      },
    );
    expect(filtered.statusCode, filtered.body).toBeLessThan(300);
    expect((filtered.json().data as Row[]).length).toBe(
      Array.from({ length: PEOPLE }, (_, i) => i).filter((i) => i % 3 === 2).length,
    );
  });

  it('an unfiltered rollup over the same relation is unchanged', async () => {
    const created = await addRollup('All Payments', { op: 'sum', target_field_api_name: 'amount' });
    expect(created.statusCode, created.body).toBe(201);
    const rows = (await queryAll(peopleDb)).json().data as Row[];
    for (let i = 0; i < PEOPLE; i++)
      expect(byTitle(rows, `Person ${i}`).values[created.json().apiName]).toBe(((i % 3) + 1) * 10);
  });
});

describe('ticket #1314: a filter the engine cannot run is refused when the field is created or changed', () => {
  it('refuses at create with a 422 naming the problem, and stores nothing', async () => {
    const bad = await addRollup('Broken Filter', {
      op: 'count',
      filter: { field: 'event', op: 'has', value: ['not-a-uuid'] },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().error.message).toMatch(/rollup filter cannot be evaluated/);
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${peopleDb}`)).json()
      .fields as Array<{ displayName: string }>;
    expect(list.some((f) => f.displayName === 'Broken Filter')).toBe(false);
    // the database still lists
    expect((await queryAll(peopleDb)).statusCode).toBeLessThan(300);
  });

  it('refuses at update, and leaves the stored config as it was', async () => {
    const ok = await addRollup('Editable', { op: 'count', filter: SUMMIT_FILTER() });
    expect(ok.statusCode, ok.body).toBe(201);
    const id = ok.json().id as string;
    const bad = await inject('PATCH', `/workspaces/${wsId}/databases/${peopleDb}/fields/${id}`, {
      config: {
        relation_field_id: paymentsOfPersonFieldId,
        op: 'count',
        filter: { field: 'event', op: 'has', value: ['not-a-uuid'] },
      },
    });
    expect(bad.statusCode, bad.body).toBe(422);
    const [stored] = await db.select().from(fields).where(eq(fields.id, id));
    expect((stored!.config as { filter: unknown }).filter).toEqual(SUMMIT_FILTER());
  });

  it('still accepts a valid filter on a relation, a number and an option-free field', async () => {
    const a = await addRollup('Valid A', {
      op: 'count',
      filter: { and: [SUMMIT_FILTER(), { field: 'amount', op: 'gte', value: 10 }] },
    });
    expect(a.statusCode, a.body).toBe(201);
    const b = await addRollup('Valid B', {
      op: 'count',
      filter: { field: 'event', op: 'is_empty' },
    });
    expect(b.statusCode, b.body).toBe(201);
  });
});

describe('ticket #1314: a computed field that fails leaves a null cell, never a failed listing', () => {
  it('a rollup whose stored filter cannot compile reads null; every other field is computed; one log line', async () => {
    const broken = await addRollup('Will Break', {
      op: 'sum',
      target_field_api_name: 'amount',
      filter: SUMMIT_FILTER(),
    });
    expect(broken.statusCode, broken.body).toBe(201);
    const fine = await addRollup('Stays Fine', { op: 'sum', target_field_api_name: 'amount' });
    expect(fine.statusCode, fine.body).toBe(201);
    // Simulate a field definition that went bad after it was stored (a renamed/deleted target field, a hand-edited config).
    const [row] = await db.select().from(fields).where(eq(fields.id, broken.json().id));
    await db
      .update(fields)
      .set({
        config: {
          ...(row!.config as object),
          filter: { field: 'gone_field', op: 'eq', value: 'x' },
        },
      })
      .where(eq(fields.id, broken.json().id));

    const warn = vi
      .spyOn(
        (app.get(RecordsService) as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    for (let i = 0; i < 3; i++) {
      const res = await queryAll(peopleDb);
      expect(res.statusCode, res.body).toBeLessThan(300);
      const rows = res.json().data as Row[];
      expect(byTitle(rows, 'Person 2').values[broken.json().apiName]).toBeNull();
      expect(byTitle(rows, 'Person 2').values[fine.json().apiName]).toBe(30);
    }
    const one = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${peopleDb}/records/${personIds[2]}`,
    );
    expect(one.statusCode, one.body).toBeLessThan(300);
    expect(one.json().values[broken.json().apiName]).toBeNull();
    const mine = warn.mock.calls.filter((c) => String(c[0]).includes(broken.json().id));
    expect(mine).toHaveLength(1); // once per field, not once per request
    expect(String(mine[0]![0])).not.toMatch(/Person|@/); // no row data in the line
    warn.mockRestore();
  });

  it('a formula whose evaluation throws reads null for that field only', async () => {
    const good = await inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/fields`, {
      display_name: 'Twice',
      type: 'formula',
      config: { expression: '1 + 1' },
    });
    expect(good.statusCode, good.body).toBe(201);
    const bad = await inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/fields`, {
      display_name: 'Boom',
      type: 'formula',
      config: { expression: '2 + 2' },
    });
    expect(bad.statusCode, bad.body).toBe(201);
    const [row] = await db.select().from(fields).where(eq(fields.id, bad.json().id));
    await db
      .update(fields)
      .set({
        config: { ...(row!.config as object), ast: { kind: 'call', name: 'no_such_fn', args: [] } },
      })
      .where(eq(fields.id, bad.json().id));
    const warn = vi
      .spyOn(
        (app.get(RecordsService) as unknown as { logger: { warn: (m: string) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    const res = await queryAll(peopleDb);
    expect(res.statusCode, res.body).toBeLessThan(300);
    const rows = res.json().data as Row[];
    expect(byTitle(rows, 'Person 0').values[bad.json().apiName]).toBeNull();
    expect(byTitle(rows, 'Person 0').values[good.json().apiName]).toBe(2);
    await queryAll(peopleDb);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(bad.json().id))).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('ticket #1314: a formula whose page-level inputs fail to load', () => {
  it('reads null for the formula and still lists (200)', async () => {
    const f = await inject('POST', `/workspaces/${wsId}/databases/${peopleDb}/fields`, {
      display_name: 'Page Level',
      type: 'formula',
      config: { expression: '3 + 3' },
    });
    expect(f.statusCode, f.body).toBe(201);
    const svc = app.get(RecordsService) as unknown as {
      loadRelatedBags: () => Promise<unknown>;
      logger: { warn: (m: string) => void };
    };
    const spy = vi
      .spyOn(svc, 'loadRelatedBags')
      .mockRejectedValue(new Error('simulated page-level failure'));
    const warn = vi.spyOn(svc.logger, 'warn').mockImplementation(() => undefined);
    const res = await queryAll(peopleDb);
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(byTitle(res.json().data as Row[], 'Person 0').values[f.json().apiName]).toBeNull();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(f.json().id)).length).toBe(1);
    spy.mockRestore();
    warn.mockRestore();
    const again = await queryAll(peopleDb);
    expect(byTitle(again.json().data as Row[], 'Person 0').values[f.json().apiName]).toBe(6);
  });
});

describe('ticket #1314: the filtered rollup does not widen what a caller may read', () => {
  it('a guest granted People but not Payments lists People (200) and sees no payment totals', async () => {
    const guest = await signUpUser(app, 'PeopleOnlyGuest');
    const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ database_id: peopleDb, role: 'viewer' }],
    });
    expect(invite.statusCode, invite.body).toBeLessThan(300);
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    expect(
      (await inject('POST', '/invites/accept', { token }, guest.token)).statusCode,
    ).toBeLessThan(300);

    const sum = (await inject('GET', `/workspaces/${wsId}/databases/${peopleDb}`))
      .json()
      .fields.find((f: { displayName: string }) => f.displayName === 'Summit Total');
    const asGuest = await queryAll(peopleDb, guest.token);
    expect(asGuest.statusCode, asGuest.body).toBeLessThan(300);
    const row = byTitle(asGuest.json().data as Row[], 'Person 2');
    expect(row.values[sum.apiName] ?? null).toBeNull(); // the admin sees 20
    expect(
      byTitle((await queryAll(peopleDb)).json().data as Row[], 'Person 2').values[sum.apiName],
    ).toBe(20);
  });
});

describe('ticket #1314: scale', () => {
  it("fetches the linked records of a very large page without exceeding a statement's parameter limit", async () => {
    // 70,000 ids is past the 65,535 parameters one statement can bind: unchunked, this is the failure a 3,300-person database
    // with several payments each walks into. Only the first PEOPLE payments exist; the rest are ids that name nothing.
    const real = await db
      .select({ id: records.id })
      .from(records)
      .where(eq(records.databaseId, paymentsDb));
    const ids = [...real.map((r) => r.id), ...Array.from({ length: 70_000 }, () => randomUUID())];
    const rows = await (
      app.get(RecordsService) as unknown as {
        fetchRollupTargetRows: (d: Db, i: string[]) => Promise<unknown[]>;
      }
    ).fetchRollupTargetRows(db, ids);
    expect(rows).toHaveLength(real.length);
  });

  it('lists a few thousand synthetic people with a filtered rollup', async () => {
    // Direct inserts: building thousands of records through HTTP would take minutes and prove nothing more.
    const bulkPeople = await makeDb(
      (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
      'Bulk People',
    );
    const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: paymentsDb,
      database_b_id: bulkPeople,
      cardinality: 'one_to_many',
      field_a_name: 'Bulk Person',
      field_b_name: 'Bulk Payments',
    });
    expect(rel.statusCode, rel.body).toBe(201);
    const bulkPaymentsField = await fieldIdOf(bulkPeople, 'bulk_payments');
    const amountId = await fieldIdOf(paymentsDb, 'amount');
    const N = 3300;
    const personRows = Array.from({ length: N }, (_, i) => ({
      id: randomUUID(),
      databaseId: bulkPeople,
      title: `Bulk ${i}`,
      number: i + 1,
    }));
    for (let i = 0; i < personRows.length; i += 1000)
      await db.insert(records).values(personRows.slice(i, i + 1000));
    const payRows = personRows.flatMap((p, i) =>
      Array.from({ length: 3 }, (_, j) => ({
        id: randomUUID(),
        databaseId: paymentsDb,
        title: `B${i}-${j}`,
        values: { [amountId]: 5 },
        owner: p.id,
        ev: eventIds[j % 2]!,
      })),
    );
    for (let i = 0; i < payRows.length; i += 1000) {
      await db
        .insert(records)
        .values(
          payRows
            .slice(i, i + 1000)
            .map(({ id, databaseId, title, values }) => ({ id, databaseId, title, values })),
        );
    }
    const eventRelationId = (await db.query.relations.findFirst({
      where: (r, { eq: e }) => e(r.databaseBId, eventsDb),
    }))!.id;
    for (let i = 0; i < payRows.length; i += 2000) {
      const slice = payRows.slice(i, i + 2000);
      await db
        .insert(recordLinks)
        .values(
          slice.map((p) => ({
            relationId: rel.json().id as string,
            fromRecordId: p.id,
            toRecordId: p.owner,
          })),
        );
      await db
        .insert(recordLinks)
        .values(
          slice.map((p) => ({ relationId: eventRelationId, fromRecordId: p.id, toRecordId: p.ev })),
        );
    }
    const created = await inject('POST', `/workspaces/${wsId}/databases/${bulkPeople}/fields`, {
      display_name: 'Summit Sum',
      type: 'rollup',
      config: {
        relation_field_id: bulkPaymentsField,
        op: 'sum',
        target_field_api_name: 'amount',
        filter: SUMMIT_FILTER(),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${bulkPeople}/records/query`, {
      limit: 200,
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const page = res.json().data as Row[];
    expect(page).toHaveLength(200);
    for (const r of page) expect(r.values[created.json().apiName], r.title).toBe(10); // payments j=0 and j=2 are for Summit: 2 x 5
  }, 120_000);
});

describe('ticket #1314: the formula dry-run has a bounded wait', () => {
  it('returns a clear timeout error when the sample evaluation does not finish, and still previews normally otherwise', async () => {
    const svc = app.get(FieldsService);
    const records = app.get(RecordsService);
    const original = records.previewFormulaSamples.bind(records);
    const previousTimeout = svc.formulaPreviewTimeoutMs;
    svc.formulaPreviewTimeoutMs = 40;
    const spy = vi
      .spyOn(records, 'previewFormulaSamples')
      .mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const slow = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${peopleDb}/fields/formula-preview`,
      { expression: '1 + 1' },
    );
    expect(Date.now() - started).toBeLessThan(1500);
    expect(slow.statusCode, slow.body).toBe(504);
    expect(slow.json().error.code).toBe('formula_preview_timeout');
    expect(slow.json().error.message).toMatch(/did not finish within/);

    spy.mockImplementation(original);
    svc.formulaPreviewTimeoutMs = previousTimeout;
    const ok = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${peopleDb}/fields/formula-preview`,
      { expression: '1 + 1' },
    );
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    expect(ok.json().valid).toBe(true);
    spy.mockRestore();
  });
});
