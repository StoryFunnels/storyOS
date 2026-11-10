import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { fields } from '../src/db/schema';

/**
 * ticket #1256 — a sum/avg/min/max rollup shows the number format of the field it aggregates.
 *
 * Deal Desk's Quote Total sums a currency formula and rendered as a bare 5740. The scenario is built the way the pack
 * builds it (Quotes <- Quote Lines, the line total a currency formula), not from Deal Desk itself, which lives in an
 * unmerged PR. There is no server-rendered "formatted value" anywhere in this codebase: the format travels in the
 * field's config and each client formats the number, so "reads as currency" here means the returned rollup config
 * carries currency + code + precision.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ws: string;
let spaceName: string;
let quotesDb: string;
let linesDb: string;
let linesField: string; // relation field on Quotes -> Lines
let totalFieldId: string; // the currency formula on Lines
let discountFieldId: string; // a percent number field on Lines

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const field = (db: string, body: unknown) => inject('POST', `/workspaces/${ws}/databases/${db}/fields`, body);
const patch = (db: string, id: string, config: unknown) =>
  inject('PATCH', `/workspaces/${ws}/databases/${db}/fields/${id}`, { config });
/** The field as a client reads it (introspection payload), which is where the inherited format is resolved. */
async function read(db: string, id: string) {
  const fs = (await inject('GET', `/workspaces/${ws}/databases/${db}`)).json().fields as { id: string; config: Record<string, unknown> }[];
  return fs.find((f) => f.id === id)!;
}
/** The field as it is STORED — an inherited format must never appear here. */
async function stored(id: string) {
  return (await rawDb.query.fields.findFirst({ where: eq(fields.id, id) }))!.config as Record<string, unknown>;
}
const rollup = (name: string, op: string, target: string | null, extra: Record<string, unknown> = {}) =>
  field(quotesDb, {
    display_name: name, type: 'rollup',
    config: { relation_field_id: linesField, op, ...(target ? { target_field_api_name: target } : {}), ...extra },
  });

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Quoter');
  ws = (await inject('POST', '/workspaces', { name: 'Format WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0];
  spaceName = space.name;
  quotesDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space.id, name: 'Quotes' })).json().id;
  linesDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space.id, name: 'Quote Lines' })).json().id;
  await field(linesDb, { display_name: 'Qty', type: 'number' });
  await field(linesDb, { display_name: 'Price', type: 'number' });
  discountFieldId = (await field(linesDb, { display_name: 'Discount', type: 'number', config: { format: 'percent', precision: 1 } })).json().id;
  totalFieldId = (
    await field(linesDb, {
      display_name: 'Line Total', type: 'formula',
      config: { expression: '{Qty} * {Price}', format: 'currency', currency_code: 'EUR', precision: 2 },
    })
  ).json().id;
  await inject('POST', `/workspaces/${ws}/relations`, {
    database_a_id: linesDb, database_b_id: quotesDb, cardinality: 'one_to_many', field_a_name: 'Quote', field_b_name: 'Lines',
  });
  const qf = (await inject('GET', `/workspaces/${ws}/databases/${quotesDb}`)).json().fields;
  linesField = qf.find((f: { apiName: string }) => f.apiName === 'lines').id;
});

afterAll(async () => {
  await app.close();
});

describe('a sum/avg/min/max rollup inherits the target field format (ticket #1256)', () => {
  let totalId: string;

  it('AC1: a sum over a currency formula reads as currency + code + precision, and is flagged as inherited', async () => {
    const res = await rollup('Quote Total', 'sum', 'line_total');
    expect(res.statusCode, res.body).toBe(201);
    totalId = res.json().id;
    const read1 = await read(quotesDb, totalId);
    expect(read1.config).toMatchObject({ op: 'sum', format: 'currency', currency_code: 'EUR', precision: 2, format_inherited: true });
  });

  it('is resolved at READ time and never stored, so it follows the target when the target changes', async () => {
    expect(await stored(totalId)).not.toHaveProperty('format');
    expect(await stored(totalId)).not.toHaveProperty('currency_code');
    const change = await patch(linesDb, totalFieldId, { format: 'currency', currency_code: 'GBP', precision: 0 });
    expect(change.statusCode, change.body).toBe(200);
    expect((await read(quotesDb, totalId)).config).toMatchObject({ format: 'currency', currency_code: 'GBP', precision: 0 });
    await patch(linesDb, totalFieldId, { format: 'currency', currency_code: 'EUR', precision: 2 });
  });

  it('avg / min / max inherit too, and a plain number field passes on its percent format and precision', async () => {
    for (const op of ['avg', 'min', 'max']) {
      const made = await rollup(`Line ${op}`, op, 'line_total');
      expect(made.statusCode, made.body).toBe(201);
      expect((await read(quotesDb, made.json().id)).config).toMatchObject({ format: 'currency', currency_code: 'EUR' });
    }
    const pct = await rollup('Avg Discount', 'avg', 'discount');
    expect(pct.statusCode, pct.body).toBe(201);
    expect((await read(quotesDb, pct.json().id)).config).toMatchObject({ format: 'percent', precision: 1, format_inherited: true });
  });

  it('AC2: a count rollup is unchanged — a plain integer, nothing inherited', async () => {
    const made = await rollup('Line Count', 'count', null);
    expect(made.statusCode, made.body).toBe(201);
    const cfg = (await read(quotesDb, made.json().id)).config;
    expect(cfg).toEqual(made.json().config);
    expect(cfg).not.toHaveProperty('format');
    expect(cfg).not.toHaveProperty('format_inherited');
    // even a count that names a target (accepted today) stays a plain integer
    const counted = await rollup('Line Count 2', 'count', 'line_total');
    expect(counted.statusCode, counted.body).toBe(201);
    expect((await read(quotesDb, counted.json().id)).config).not.toHaveProperty('format');
  });

  it('AC3: an explicit format on the rollup wins over the inherited one, and is stored as chosen', async () => {
    const made = await rollup('Quote Total USD', 'sum', 'line_total', { format: 'currency', currency_code: 'usd', precision: 0 });
    expect(made.statusCode, made.body).toBe(201);
    const cfg = (await read(quotesDb, made.json().id)).config;
    expect(cfg).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 0 });
    expect(cfg).not.toHaveProperty('format_inherited');
    // an explicit plain beats an inherited currency too
    const plain = await rollup('Quote Total Plain', 'sum', 'line_total', { format: 'plain' });
    expect(plain.statusCode, plain.body).toBe(201);
    expect((await read(quotesDb, plain.json().id)).config).toMatchObject({ format: 'plain' });
    expect((await read(quotesDb, plain.json().id)).config.currency_code).toBeUndefined();
  });

  it('REJECTS a format on a count, first, last or collect rollup — refused, not silently ignored', async () => {
    const count = await rollup('Bad Count', 'count', null, { format: 'currency', currency_code: 'EUR' });
    expect(count.statusCode).toBe(422);
    expect(count.json().error.message).toMatch(/plain integer/i);
    const first = await rollup('Bad First', 'first', 'line_total', { order_by_field_api_name: 'qty', precision: 2 });
    expect(first.statusCode).toBe(422);
    // and the same on UPDATE of an existing count
    const countId = (await rollup('Count For Patch', 'count', null)).json().id;
    const upd = await patch(quotesDb, countId, { format: 'percent' });
    expect(upd.statusCode).toBe(422);
  });

  it('REJECTS currency without a 3-letter code, an unknown format, and a bad precision', async () => {
    expect((await rollup('No Code', 'sum', 'line_total', { format: 'currency' })).statusCode).toBe(422);
    expect((await rollup('Long Code', 'sum', 'line_total', { format: 'currency', currency_code: 'EURO' })).statusCode).toBe(422);
    expect((await rollup('Bad Fmt', 'sum', 'line_total', { format: 'scientific' })).statusCode).toBe(422);
    expect((await rollup('Bad Prec', 'sum', 'line_total', { format: 'plain', precision: 11 })).statusCode).toBe(422);
  });

  it('MUST KEEP: a client that sends the read config back does not turn the inheritance into a stored copy', async () => {
    const made = await rollup('Round Trip', 'sum', 'line_total');
    const id = made.json().id;
    const roundTripped = (await read(quotesDb, id)).config;
    expect(roundTripped.format_inherited).toBe(true);
    const upd = await patch(quotesDb, id, roundTripped);
    expect(upd.statusCode, upd.body).toBe(200);
    expect(await stored(id)).not.toHaveProperty('format');
    expect(await stored(id)).not.toHaveProperty('format_inherited');
    expect((await read(quotesDb, id)).config).toMatchObject({ format: 'currency', format_inherited: true });
  });

  it('null clears an explicit format so the rollup goes back to inheriting', async () => {
    const made = await rollup('Clearable', 'sum', 'line_total', { format: 'percent' });
    const id = made.json().id;
    const cleared = await patch(quotesDb, id, { format: null, currency_code: null, precision: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await read(quotesDb, id)).config).toMatchObject({ format: 'currency', currency_code: 'EUR', format_inherited: true });
  });

  it('MUST KEEP: a pack export does not bake an inherited format into the manifest, but keeps an explicit one', async () => {
    const res = await inject('POST', `/workspaces/${ws}/packs/export`, {
      slug: 'format-pack', name: 'Format Pack', version: '1.0.0', summary: 'rollup formats', space: spaceName,
    });
    expect(res.statusCode, res.body).toBe(201);
    const derived = res.json().derived_fields as { database: string; name: string; type: string; config: Record<string, unknown> }[];
    const inherited = derived.find((f) => f.database === 'Quotes' && f.name === 'Quote Total')!;
    expect(inherited.type).toBe('rollup');
    expect(inherited.config).not.toHaveProperty('format');
    expect(inherited.config).not.toHaveProperty('currency_code');
    expect(inherited.config).not.toHaveProperty('format_inherited');
    const explicit = derived.find((f) => f.database === 'Quotes' && f.name === 'Quote Total USD')!;
    expect(explicit.config).toMatchObject({ format: 'currency', currency_code: 'USD' });
  }, 60_000);
});
