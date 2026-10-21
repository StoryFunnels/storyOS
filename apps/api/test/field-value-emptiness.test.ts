import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { records } from '../src/db/schema';
import { hasFieldValueSql, isEmptyFieldValue } from '../src/fields/field-value-emptiness';

/**
 * ticket #984 (with #983) — "how many records have a value for this field" had two private definitions: delete-field's
 * `records_with_value` counted key PRESENCE (null, "" and whitespace counted as data: over-reports) and the text → choice dry run's
 * `empty_records` counted only some blanks (under-reports). One predicate now, in JS and in SQL, built from the same whitespace pattern.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string;
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Emptiness Owner');
  ws = (await as('POST', '/workspaces', { name: 'Emptiness WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

/** Every shape a stored value can take; `absent` is a record with no key at all. */
const ABSENT = Symbol('absent');
const SAMPLES: Array<[string, unknown, boolean /* empty? */]> = [
  ['absent key', ABSENT, true],
  ['null', null, true],
  ['empty string', '', true],
  ['spaces', '  ', true],
  ['tab + newline', '\t\n', true],
  ['no-break space (JS trim strips it)', ' ', true],
  ['BOM (JS trim strips it)', '﻿', true],
  ['ideographic space', '　', true],
  ['empty list', [], true],
  ['a real value', 'x', false],
  ['a padded real value', '  x ', false],
  ['zero-width space (JS trim keeps it)', '​', false],
  ['number 0 is data', 0, false],
  ['number 42', 42, false],
  ['false is data', false, false],
  ['true', true, false],
  ['non-empty list', ['a'], false],
  ['an object', { a: 1 }, false],
];

async function textDb() {
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: `Emptiness ${Math.random().toString(36).slice(2)}` })).json().id as string;
  const field = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Status', type: 'text' })).json().id as string;
  return { db, field };
}
/** Insert a record, then set `values` to EXACTLY the shape under test (the API would normalise some of them away). */
async function recordWith(db: string, field: string, value: unknown) {
  const id = (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'r' } })).json().id as string;
  const values = value === ABSENT ? { name: 'r' } : { name: 'r', [field]: value };
  await raw.execute(sql`UPDATE records SET values = ${JSON.stringify(values)}::jsonb WHERE id = ${id}`);
  return id;
}

describe('#984 one definition of "has a value", in JS and in SQL', () => {
  it('the JS predicate and the SQL predicate agree on every shape, including the unicode whitespace JS trim strips', async () => {
    const { db, field } = await textDb();
    for (const [label, value, empty] of SAMPLES) {
      const id = await recordWith(db, field, value);
      const v = value === ABSENT ? undefined : value;
      expect(isEmptyFieldValue(v), `JS: ${label}`).toBe(empty);
      const [row] = await raw.select({ has: hasFieldValueSql(records.values, field) }).from(records).where(eq(records.id, id));
      expect(row!.has, `SQL: ${label}`).toBe(!empty);
    }
  });

  it('delete-field usage and the delete response count only NON-empty values (absent / null / "" / whitespace / a real value)', async () => {
    const { db, field } = await textDb();
    for (const v of [ABSENT, null, '', '  ', ' ', 'real']) await recordWith(db, field, v);
    const usage = await as('GET', `/workspaces/${ws}/databases/${db}/fields/${field}/usage`);
    expect(usage.json().records_with_value, 'five of the six hold no value').toBe(1);
    const del = await as('DELETE', `/workspaces/${ws}/databases/${db}/fields/${field}`);
    expect(del.statusCode, del.body).toBe(200);
    expect(del.json().records_with_value).toBe(1);
  });

  it('the two screens agree: the text → choice dry run\'s empty_records + records_with_value = total_records', async () => {
    const { db, field } = await textDb();
    for (const v of [ABSENT, null, '', ' \t ', 'a', 'b', 'a']) await recordWith(db, field, v);
    const usage = (await as('GET', `/workspaces/${ws}/databases/${db}/fields/${field}/usage`)).json().records_with_value as number;
    const dry = await as('POST', `/workspaces/${ws}/databases/${db}/fields/${field}/change-type`, { type: 'select', dry_run: true });
    expect(dry.statusCode, dry.body).toBe(201);
    const counts = dry.json().counts ?? dry.json().plan?.counts ?? dry.json();
    expect(usage).toBe(3);
    expect(counts.empty_records).toBe(4);
    expect(counts.empty_records + usage).toBe(counts.total_records);
  });

  it('only live records count: a trashed record with a value is not data', async () => {
    const { db, field } = await textDb();
    const keep = await recordWith(db, field, 'x');
    const gone = await recordWith(db, field, 'y');
    await as('DELETE', `/workspaces/${ws}/databases/${db}/records/${gone}`);
    expect(keep).toBeTruthy();
    expect((await as('GET', `/workspaces/${ws}/databases/${db}/fields/${field}/usage`)).json().records_with_value).toBe(1);
  });
});
