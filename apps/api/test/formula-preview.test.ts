import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { fields, records } from '../src/db/schema';

/**
 * ticket #1263 — POST .../fields/formula-preview: parse, type-check and evaluate a formula on up to 5 sample records, saving NOTHING.
 *
 * The central claim is that the preview is the SAME code path as save + read, so one test saves the formula for real and compares what
 * a GET returns with what the preview said. A preview with its own evaluator would pass every case it copied and drift on the rest.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ws: string;
let linesDb: string;
let quotesDb: string;
let restrictedDb: string;
let quoteLinkField: string;
let outsider: Person;

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(owner.token), payload: payload as never });
const preview = (db: string, body: unknown, token = owner.token) =>
  call(app, token, 'POST', `/workspaces/${ws}/databases/${db}/fields/formula-preview`, body);
const fieldCount = async (db: string) => (await rawDb.query.fields.findMany({ where: eq(fields.databaseId, db) })).length;
const recordsSnapshot = async (db: string) =>
  JSON.stringify(
    (await rawDb.query.records.findMany({ where: eq(records.databaseId, db) }))
      .map((r) => [r.id, r.values, r.computedValues, r.updatedAt])
      .sort(),
  );

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Preview Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Preview WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const mkDb = async (name: string) =>
    (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
  quotesDb = await mkDb('Quotes');
  linesDb = await mkDb('Lines');
  restrictedDb = await mkDb('Secret Lines');
  for (const [display_name, type] of [['Qty', 'number'], ['Price', 'number']] as const) {
    expect((await inject('POST', `/workspaces/${ws}/databases/${linesDb}/fields`, { display_name, type })).statusCode).toBe(201);
    expect((await inject('POST', `/workspaces/${ws}/databases/${restrictedDb}/fields`, { display_name, type })).statusCode).toBe(201);
  }
  await inject('POST', `/workspaces/${ws}/relations`, {
    database_a_id: linesDb, database_b_id: quotesDb, cardinality: 'one_to_many', field_a_name: 'Quote', field_b_name: 'Lines',
  });
  const lf = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}`)).json().fields;
  quoteLinkField = lf.find((f: { apiName: string }) => f.apiName === 'quote').id;

  // 7 lines (more than the 5-sample cap), created in order so "most recent" is checkable: line 7 is the newest.
  const quote = (await inject('POST', `/workspaces/${ws}/databases/${quotesDb}/records`, { values: { name: 'Q1' } })).json().id;
  for (let i = 1; i <= 7; i++) {
    const line = (await inject('POST', `/workspaces/${ws}/databases/${linesDb}/records`, { values: { name: `Line ${i}`, qty: i, price: 10 } })).json();
    if (i <= 3) {
      const link = await inject('PUT', `/workspaces/${ws}/databases/${linesDb}/records/${line.id}/links/${quoteLinkField}`, { record_ids: [quote] });
      expect(link.statusCode, link.body).toBeLessThan(300);
    }
  }
  await inject('POST', `/workspaces/${ws}/databases/${restrictedDb}/records`, { values: { name: 'Secret', qty: 99, price: 99 } });
  await setRestricted(app, owner.token, ws, 'database', restrictedDb);
  outsider = await joinAs(app, owner.token, ws, 'Outsider', 'member');
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('a valid formula returns its type and sample values (#1263 AC1)', () => {
  it('returns return_type and values on the 5 most recent records, newest first', async () => {
    const res = await preview(linesDb, { expression: '{Qty} * {Price}' });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.return_type).toBe('number');
    expect(body.errors).toEqual([]);
    expect(body.samples).toHaveLength(5);
    expect(body.samples.map((s: { title: string }) => s.title)).toEqual(['Line 7', 'Line 6', 'Line 5', 'Line 4', 'Line 3']);
    expect(body.samples.map((s: { value: number }) => s.value)).toEqual([70, 60, 50, 40, 30]);
    expect(body.samples[0]).toMatchObject({ number: expect.any(Number), record_id: expect.any(String) });
  });

  it('`samples` can ask for fewer, and can never ask for more than 5', async () => {
    const two = await preview(linesDb, { expression: '{Qty}', samples: 2 });
    expect(two.json().samples).toHaveLength(2);
    const many = await preview(linesDb, { expression: '{Qty}', samples: 50 });
    expect(many.statusCode).toBe(422); // the 5 cap is in the request schema
  });

  it('an empty database previews to valid with no samples', async () => {
    const empty = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Empty' })).json().id;
    await inject('POST', `/workspaces/${ws}/databases/${empty}/fields`, { display_name: 'N', type: 'number' });
    const res = await preview(empty, { expression: '{N} + 1' });
    expect(res.json()).toMatchObject({ valid: true, return_type: 'number', samples: [], errors: [] });
  });

  it('reports a text, a checkbox and a date result type', async () => {
    expect((await preview(linesDb, { expression: '"#" + format({Qty})' })).json()).toMatchObject({ return_type: 'text' });
    expect((await preview(linesDb, { expression: '{Qty} > 3' })).json()).toMatchObject({ return_type: 'checkbox' });
    expect((await preview(linesDb, { expression: 'add_days(today(), {Qty})' })).json()).toMatchObject({ return_type: 'date' });
  });

  it('evaluates a relation aggregate (a cross-record formula) the way a read does', async () => {
    const res = await preview(quotesDb, { expression: 'sum({Lines.Price}) + count({Lines})' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().return_type).toBe('number');
    expect(res.json().samples[0].value).toBe(33); // three linked lines at 10, plus a count of 3
  });

  it('ONE CODE PATH: what the preview says is what a saved formula then reads back as', async () => {
    const expr = 'if({Qty} > 3, {Qty} * {Price}, 0)';
    const previewed = (await preview(linesDb, { expression: expr })).json();
    const saved = await inject('POST', `/workspaces/${ws}/databases/${linesDb}/fields`, {
      display_name: 'Saved Total', type: 'formula', config: { expression: expr },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().config.result_type).toBe(previewed.return_type);
    for (const sample of previewed.samples) {
      const row = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}/records/${sample.record_id}`)).json();
      expect(row.values.saved_total, sample.title).toBe(sample.value);
    }
  });

  it('a formula over ANOTHER formula previews (the chain resolves like a read)', async () => {
    const res = await preview(linesDb, { expression: '{Saved Total} + 1' });
    expect(res.json().valid, res.body).toBe(true);
    expect(res.json().samples[0].value).toBe(71);
  });
});

describe('an invalid formula returns a positioned, actionable error and saves nothing (#1263 AC2)', () => {
  const cases: Array<{ name: string; expression: string; check: (e: Record<string, unknown>) => void }> = [
    {
      name: 'unknown field -> nearest field',
      expression: '{Qtty} * {Price}',
      check: (e) => {
        expect(e.position).toEqual({ start: 0, end: 6 });
        expect(e.suggestion).toBe('{Qty}');
        expect(e.got).toBe('Qtty');
      },
    },
    {
      name: 'unknown function -> nearest function',
      expression: 'rond({Qty}, 2)',
      check: (e) => {
        expect(e.position).toEqual({ start: 0, end: 4 });
        expect(e.suggestion).toBe('round');
      },
    },
    {
      name: 'wrong argument type -> expected vs got, on the argument',
      expression: 'round("abc", 2)',
      check: (e) => {
        expect(e.position).toEqual({ start: 6, end: 11 });
        expect(e.expected).toBe('number');
        expect(e.got).toBe('text');
      },
    },
    {
      name: 'unbalanced parenthesis -> position at the end',
      expression: 'round({Qty}, 2',
      check: (e) => {
        expect(e.message).toMatch(/Missing closing parenthesis/);
        expect(e.position).toEqual({ start: 14, end: 14 });
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: valid=false, positioned, and nothing is written`, async () => {
      const fieldsBefore = await fieldCount(linesDb);
      const snapshotBefore = await recordsSnapshot(linesDb);
      const res = await preview(linesDb, { expression: c.expression });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ valid: false, return_type: null, samples: [] });
      expect(body.errors).toHaveLength(1);
      expect(Object.keys(body.errors[0]).sort()).toEqual(['expected', 'got', 'message', 'position', 'suggestion']);
      c.check(body.errors[0]);
      expect(await fieldCount(linesDb)).toBe(fieldsBefore);
      expect(await recordsSnapshot(linesDb)).toBe(snapshotBefore);
    });
  }

  it('a VALID preview also leaves the field list and every record untouched', async () => {
    const fieldsBefore = await fieldCount(linesDb);
    const snapshotBefore = await recordsSnapshot(linesDb);
    const res = await preview(linesDb, { expression: '{Qty} * 2' });
    expect(res.json().valid).toBe(true);
    expect(await fieldCount(linesDb)).toBe(fieldsBefore);
    expect(await recordsSnapshot(linesDb)).toBe(snapshotBefore);
  });

  it('the SAVE path rejects the same formula with the same message (one compile, two callers)', async () => {
    const dry = (await preview(linesDb, { expression: '{Qtty} * {Price}' })).json();
    const saved = await inject('POST', `/workspaces/${ws}/databases/${linesDb}/fields`, {
      display_name: 'Bad', type: 'formula', config: { expression: '{Qtty} * {Price}' },
    });
    expect(saved.statusCode).toBe(422);
    expect(saved.json().error.message).toBe(`Formula error: ${dry.errors[0].message}`);
  });

  it('editing an existing formula: a self-reference is refused as on save; a non-formula field is a 422', async () => {
    const savedField = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'saved_total');
    const selfRef = await preview(linesDb, { expression: '{Saved Total} + 1', field: savedField.id });
    expect(selfRef.json().valid).toBe(false);
    expect(selfRef.json().errors[0].message).toMatch(/own field/);
    const qty = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'qty');
    expect((await preview(linesDb, { expression: '1', field: qty.id })).statusCode).toBe(422);
  });
});

describe('access: it is a read, with a read\'s rules (#1263)', () => {
  it('a member with no grant on a RESTRICTED database gets the same 404 as for a database that does not exist', async () => {
    const hidden = await preview(restrictedDb, { expression: '{Qty}' }, outsider.token);
    const absent = await preview('11111111-1111-4111-8111-111111111111', { expression: '{Qty}' }, outsider.token);
    expect(hidden.statusCode).toBe(404);
    expect(absent.statusCode).toBe(404);
    const strip = (b: string) => b.replace(/"request_id":"[^"]*"/, "");
    expect(strip(hidden.body)).toBe(strip(absent.body));
    expect(hidden.body).not.toContain('99');
  });

  it('a READ-scope token can dry-run (it is not an admin/write route); the owner still sees the values', async () => {
    const minted = await inject('POST', '/me/tokens', { name: 'ro', workspace_id: ws, scope: 'read' });
    expect(minted.statusCode, minted.body).toBeLessThan(300);
    const res = await preview(linesDb, { expression: '{Qty}' }, minted.json().token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().samples).toHaveLength(5);
  });

  it('an unauthenticated caller is refused', async () => {
    expect((await call(app, null, 'POST', `/workspaces/${ws}/databases/${linesDb}/fields/formula-preview`, { expression: '1' })).statusCode).toBe(401);
  });
});
