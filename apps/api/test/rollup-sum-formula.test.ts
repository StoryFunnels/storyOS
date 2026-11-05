import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { records } from '../src/db/schema';

/**
 * ticket #1200 (Packs G6) — Deal Desk's Quote Lines need `total = qty × price` shown as money, and a Quote needs a
 * rollup SUM of those totals. Two gaps, one scenario:
 *   1. a formula's result could not be currency (formulaConfigSchema.format was plain|percent only);
 *   2. a rollup sum/avg/min/max accepted only a stored `number` field, so it refused a formula target outright.
 *
 * The scenario is built in beforeAll the way a pack would build it: Quotes <- Quote Lines, line total as a formula.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ws: string;
let quotesDb: string;
let linesDb: string;
let quoteField: string; // relation field on Lines -> Quotes
let linesField: string; // inverse relation field on Quotes -> Lines
let totalFieldId: string; // the currency formula on Lines

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const field = (db: string, body: unknown) => inject('POST', `/workspaces/${ws}/databases/${db}/fields`, body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quoteRow = async (id: string) =>
  (await inject('GET', `/workspaces/${ws}/databases/${quotesDb}/records/${id}`)).json();
const stored = async (id: string, fieldId: string) =>
  ((await rawDb.query.records.findFirst({ where: eq(records.id, id), columns: { computedValues: true } }))!
    .computedValues as Record<string, unknown>)[fieldId];
/** The materialized value is written by a fire-and-forget cascade; poll instead of sleeping a fixed time. */
async function storedEventually(id: string, fieldId: string, want: unknown): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < 60; i++) {
    last = await stored(id, fieldId);
    if (last === want) return last;
    await sleep(50);
  }
  return last;
}
async function addLine(quote: string, qty: number, price: number, name = `Line ${qty}x${price}`) {
  const line = (await inject('POST', `/workspaces/${ws}/databases/${linesDb}/records`, { values: { name, qty, price } })).json();
  const link = await inject('PUT', `/workspaces/${ws}/databases/${linesDb}/records/${line.id}/links/${quoteField}`, { record_ids: [quote] });
  expect(link.statusCode, link.body).toBeLessThan(300);
  return line.id as string;
}
async function newQuote(name: string) {
  return (await inject('POST', `/workspaces/${ws}/databases/${quotesDb}/records`, { values: { name } })).json().id as string;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Quoter');
  ws = (await inject('POST', '/workspaces', { name: 'Quote WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  quotesDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Quotes' })).json().id;
  linesDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Quote Lines' })).json().id;
  await field(quotesDb, { display_name: 'Discount', type: 'number' });
  await field(linesDb, { display_name: 'Qty', type: 'number' });
  await field(linesDb, { display_name: 'Price', type: 'number' });
  await inject('POST', `/workspaces/${ws}/relations`, {
    database_a_id: linesDb, database_b_id: quotesDb, cardinality: 'one_to_many', field_a_name: 'Quote', field_b_name: 'Lines',
  });
  const lf = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}`)).json().fields;
  quoteField = lf.find((f: { apiName: string }) => f.apiName === 'quote').id;
  const qf = (await inject('GET', `/workspaces/${ws}/databases/${quotesDb}`)).json().fields;
  linesField = qf.find((f: { apiName: string }) => f.apiName === 'lines').id;
});

afterAll(async () => {
  await app.close();
});

describe('a formula can be currency (ticket #1200)', () => {
  it('stores format + currency_code + precision on CREATE and echoes them back', async () => {
    const res = await field(linesDb, {
      display_name: 'Line Total', type: 'formula',
      config: { expression: '{Qty} * {Price}', format: 'currency', currency_code: 'EUR', precision: 2 },
    });
    expect(res.statusCode, res.body).toBe(201);
    totalFieldId = res.json().id;
    expect(res.json().config).toMatchObject({ result_type: 'number', format: 'currency', currency_code: 'EUR', precision: 2 });
    const reread = (await inject('GET', `/workspaces/${ws}/databases/${linesDb}`)).json().fields.find((f: { id: string }) => f.id === totalFieldId);
    expect(reread.config).toMatchObject({ format: 'currency', currency_code: 'EUR', precision: 2 });
  });

  it('REJECTS currency on a formula whose result is not a number', async () => {
    const res = await field(linesDb, {
      display_name: 'Label', type: 'formula', config: { expression: '{Name}', format: 'currency', currency_code: 'USD' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/currency/i);
  });

  it('REJECTS currency without a 3-letter currency_code — a formula must not silently default to USD', async () => {
    const none = await field(linesDb, { display_name: 'NoCode', type: 'formula', config: { expression: '{Qty} * {Price}', format: 'currency' } });
    expect(none.statusCode).toBe(422);
    const bad = await field(linesDb, { display_name: 'BadCode', type: 'formula', config: { expression: '{Qty} * {Price}', format: 'currency', currency_code: 'EURO' } });
    expect(bad.statusCode).toBe(422);
  });

  it('a config-only patch can switch an existing formula to currency, and back to plain', async () => {
    const made = await field(linesDb, { display_name: 'Switch', type: 'formula', config: { expression: '{Qty} * {Price}' } });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id;
    const toMoney = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${id}`, { config: { format: 'currency', currency_code: 'GBP' } });
    expect(toMoney.statusCode, toMoney.body).toBe(200);
    expect(toMoney.json().config).toMatchObject({ format: 'currency', currency_code: 'GBP', expression: '{Qty} * {Price}' });
    const back = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${id}`, { config: { format: 'plain' } });
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().config.format).toBe('plain');
  });

  it('MUST KEEP: percent and plain formulas still save, on create and on patch', async () => {
    const pct = await field(linesDb, { display_name: 'Pct', type: 'formula', config: { expression: '{Qty} / 100', format: 'percent' } });
    expect(pct.statusCode, pct.body).toBe(201);
    expect(pct.json().config.format).toBe('percent');
    const plain = await field(linesDb, { display_name: 'Plain', type: 'formula', config: { expression: '{Qty} + 1' } });
    expect(plain.statusCode, plain.body).toBe(201);
    expect(plain.json().config.format).toBeUndefined();
  });
});

describe('a rollup can aggregate a number formula (ticket #1200)', () => {
  it('sum over the currency formula: a quote totals its lines, and follows edits, unlinks and expression changes', async () => {
    const sum = await field(quotesDb, {
      display_name: 'Quote Total', type: 'rollup',
      config: { relation_field_id: linesField, op: 'sum', target_field_api_name: 'line_total' },
    });
    expect(sum.statusCode, sum.body).toBe(201);
    const sumId = sum.json().id;

    const q = await newQuote('Q-1');
    const a = await addLine(q, 3, 10); // 30
    await addLine(q, 2, 25); // 50
    expect((await quoteRow(q)).values.quote_total).toBe(80);
    expect(await storedEventually(q, sumId, 80)).toBe(80); // the materialized (sortable/filterable) copy agrees

    // Editing an INPUT of the formula (qty) changes the line's total; the quote's rollup must follow. The rollup's own
    // target is `line_total`, which is not in the PATCH's changed fields — this is the invalidation that has to widen.
    const patched = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/records/${a}`, { values: { qty: 4 } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await quoteRow(q)).values.quote_total).toBe(90);
    expect(await storedEventually(q, sumId, 90)).toBe(90);

    // Unlinking a line removes its total.
    const unlink = await inject('PUT', `/workspaces/${ws}/databases/${linesDb}/records/${a}/links/${quoteField}`, { record_ids: [] });
    expect(unlink.statusCode, unlink.body).toBeLessThan(300);
    expect((await quoteRow(q)).values.quote_total).toBe(50);
    expect(await storedEventually(q, sumId, 50)).toBe(50);

    // Re-saving the formula with a different expression re-materializes every line AND the rollup that reads it.
    const edit = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${totalFieldId}`, {
      config: { expression: '{Qty} * {Price} * 2' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await storedEventually(q, sumId, 100)).toBe(100);
    expect((await quoteRow(q)).values.quote_total).toBe(100);
    await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${totalFieldId}`, { config: { expression: '{Qty} * {Price}' } });
  });

  it('a quote with no lines is null (not 0), like a sum over a number field', async () => {
    const q = await newQuote('Q-empty');
    expect((await quoteRow(q)).values.quote_total).toBeNull();
  });

  it('avg / min / max over the formula use the formula values', async () => {
    const mk = async (op: string) => {
      const r = await field(quotesDb, { display_name: `Line ${op}`, type: 'rollup', config: { relation_field_id: linesField, op, target_field_api_name: 'line_total' } });
      expect(r.statusCode, r.body).toBe(201);
      return r.json().id as string;
    };
    const [avgId, minId, maxId] = [await mk('avg'), await mk('min'), await mk('max')];
    const q = await newQuote('Q-stats');
    await addLine(q, 1, 10); // 10
    await addLine(q, 1, 30); // 30
    const row = await quoteRow(q);
    expect(row.values.line_avg).toBe(20);
    expect(row.values.line_min).toBe(10);
    expect(row.values.line_max).toBe(30);
    expect(await storedEventually(q, avgId, 20)).toBe(20);
    expect(await storedEventually(q, minId, 10)).toBe(10);
    expect(await storedEventually(q, maxId, 30)).toBe(30);
  });

  it('a FILTERED sum over the formula keeps only the lines the filter passes', async () => {
    const r = await field(quotesDb, {
      display_name: 'Big Lines', type: 'rollup',
      config: {
        relation_field_id: linesField, op: 'sum', target_field_api_name: 'line_total',
        filter: { and: [{ field: 'qty', op: 'gte', value: 5 }] },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    const q = await newQuote('Q-filtered');
    await addLine(q, 5, 10); // 50 — kept
    await addLine(q, 1, 1000); // 1000 — filtered out
    expect((await quoteRow(q)).values.big_lines).toBe(50);
  });

  it('REJECTS a rollup over a formula that returns text', async () => {
    await field(linesDb, { display_name: 'Caption', type: 'formula', config: { expression: 'concat({Name}, "!")' } });
    const res = await field(quotesDb, { display_name: 'Bad Sum', type: 'rollup', config: { relation_field_id: linesField, op: 'sum', target_field_api_name: 'caption' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/number/i);
  });

  it('REJECTS a rollup over a formula that reads a lookup — its value is never materialized, so the sum would silently skip it', async () => {
    const lk = await field(linesDb, { display_name: 'Quote Discount', type: 'lookup', config: { relation_field_id: quoteField, target_field_api_name: 'discount' } });
    expect(lk.statusCode, lk.body).toBe(201);
    const f = await field(linesDb, { display_name: 'Discounted', type: 'formula', config: { expression: '{Qty} * to_number({Quote Discount})' } });
    expect(f.statusCode, f.body).toBe(201);
    const res = await field(quotesDb, { display_name: 'Lookup Sum', type: 'rollup', config: { relation_field_id: linesField, op: 'sum', target_field_api_name: 'discounted' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/lookup/i);
  });

  it('REJECTS editing a formula so a rollup that sums it would silently stop working', async () => {
    // line_total is summed by "Quote Total". Turning it into a text formula, or one that reads a lookup, would leave
    // that rollup computing nothing, with a 200 — refuse the edit and name the rollup.
    const toText = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${totalFieldId}`, { config: { expression: 'concat({Name}, "!")', format: 'plain' } });
    expect(toText.statusCode).toBe(422);
    expect(toText.json().error.message).toMatch(/Quote Total/);
    const toLookup = await inject('PATCH', `/workspaces/${ws}/databases/${linesDb}/fields/${totalFieldId}`, { config: { expression: '{Qty} * to_number({Quote Discount})' } });
    expect(toLookup.statusCode).toBe(422);
    expect(toLookup.json().error.message).toMatch(/Quote Total/);
  });

  it('MUST KEEP: a rollup over a plain number field, and a sum over text, behave exactly as before', async () => {
    const ok = await field(quotesDb, { display_name: 'Qty Sum', type: 'rollup', config: { relation_field_id: linesField, op: 'sum', target_field_api_name: 'qty' } });
    expect(ok.statusCode, ok.body).toBe(201);
    const q = await newQuote('Q-plain');
    await addLine(q, 2, 5);
    await addLine(q, 7, 5);
    expect((await quoteRow(q)).values.qty_sum).toBe(9);
    const text = await field(quotesDb, { display_name: 'Name Sum', type: 'rollup', config: { relation_field_id: linesField, op: 'sum', target_field_api_name: 'name' } });
    expect(text.statusCode).toBe(422);
  });
});
