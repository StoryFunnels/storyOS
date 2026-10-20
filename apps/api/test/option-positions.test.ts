import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { selectOptions } from '../src/db/schema';

/**
 * #961 follow-up — ONE position per option: the sort order, the board's "Field order" columns and every option list read it, so it
 * must be unique and dense (0..n-1). The migration backfills fields that already share positions; every write path keeps it so.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let token: string;
let ws: string, space: string;
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Option Positions')).token;
  ws = (await as('POST', '/workspaces', { name: 'Option Positions WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

async function selectField(labels: string[], type = 'select') {
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: `Opts ${Math.random().toString(36).slice(2)}` })).json().id as string;
  const f = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Prio', type, options: labels.map((label) => ({ label, color: 'gray' })) })).json();
  const ids = Object.fromEntries((f.options as Array<{ id: string; label: string }>).map((o) => [o.label, o.id])) as Record<string, string>;
  return { db, field: f.id as string, ids };
}
const stored = async (field: string) =>
  (await raw.select().from(selectOptions).where(eq(selectOptions.fieldId, field))).map((o) => ({ label: o.label, position: o.position })).sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
const served = async (db: string, field: string) =>
  ((await as('GET', `/workspaces/${ws}/databases/${db}`)).json().fields.find((f: { id: string }) => f.id === field).options as Array<{ label: string }>).map((o) => o.label);
const dense = (rows: Array<{ position: number }>) => rows.map((r) => r.position);

describe('#961 the dense-positions migration', () => {
  const migration = readFileSync(join(__dirname, '../drizzle/0113_dense_option_positions.sql'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('renumbers tied and gapped positions to 0..n-1 in the order a person was seeing, and a second run writes nothing', async () => {
    const a = await selectField(['A1', 'A2', 'A3']);
    const b = await selectField(['B1', 'B2', 'B3', 'B4']);
    const c = await selectField(['C1', 'C2']); // already dense: must be left alone
    // Options of a field made over time have distinct creation times; set them so the order a person saw (creation order) is defined.
    await raw.execute(sql`UPDATE select_options o SET created_at = now() - (interval '1 hour') * (10 - x.n) FROM (SELECT id, row_number() OVER (PARTITION BY field_id ORDER BY label) AS n FROM select_options) x WHERE o.id = x.id`);
    // production-shaped mess: everything at the default 0 (pre-position fields), a gap and a tie
    await raw.update(selectOptions).set({ position: 0 }).where(eq(selectOptions.fieldId, a.field));
    await raw.execute(sql`UPDATE select_options SET position = 7 WHERE id = ${b.ids.B1}`);
    await raw.execute(sql`UPDATE select_options SET position = 7 WHERE id = ${b.ids.B2}`);
    await raw.execute(sql`UPDATE select_options SET position = 3 WHERE id = ${b.ids.B3}`);
    await raw.execute(sql`UPDATE select_options SET position = 12 WHERE id = ${b.ids.B4}`);
    const before = { a: dense(await stored(a.field)), b: dense(await stored(b.field)), c: dense(await stored(c.field)) };
    expect(before).toEqual({ a: [0, 0, 0], b: [3, 7, 7, 12], c: [0, 1] });

    const first = await raw.execute(sql.raw(migration));
    // The statement is global (every choice field in the database), so other tests' rows may be in the count: at LEAST A's 2 (0,0,0 -> 0,1,2: the first
    // keeps its 0) and B's 4 (3,7,7,12 -> 0,1,2,3) changed, and C's already-dense two did not (asserted below).
    expect(first.rowCount ?? 0).toBeGreaterThanOrEqual(6);
    expect(await stored(a.field)).toEqual([{ label: 'A1', position: 0 }, { label: 'A2', position: 1 }, { label: 'A3', position: 2 }]);
    // B was seen as B3 (pos 3) then the tied B1, B2 (pos 7, in creation order) then B4 (12)
    expect(await stored(b.field)).toEqual([{ label: 'B3', position: 0 }, { label: 'B1', position: 1 }, { label: 'B2', position: 2 }, { label: 'B4', position: 3 }]);
    expect(dense(await stored(c.field)), 'an already-dense field is untouched').toEqual([0, 1]);

    const second = await raw.execute(sql.raw(migration));
    expect(second.rowCount, 'idempotent').toBe(0);
  });
});

describe('#961 every write path keeps positions dense', () => {
  it('a new field gets 0..n-1; addOption appends; removeOption leaves no gap', async () => {
    const { db, field, ids } = await selectField(['One', 'Two', 'Three']);
    expect(dense(await stored(field))).toEqual([0, 1, 2]);
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${field}/options`, { label: 'Four', color: 'red' })).statusCode).toBe(201);
    expect(dense(await stored(field))).toEqual([0, 1, 2, 3]);
    const del = await as('DELETE', `/workspaces/${ws}/databases/${db}/fields/${field}/options/${ids.Two}`, { confirm: true });
    expect(del.statusCode, del.body).toBe(200);
    expect(await stored(field)).toEqual([{ label: 'One', position: 0 }, { label: 'Three', position: 1 }, { label: 'Four', position: 2 }]);
  });

  it('PATCH position moves the option to that INDEX (0 = first), the others shift, positions stay dense', async () => {
    const { db, field, ids } = await selectField(['A', 'B', 'C', 'D']);
    const patch = (opt: string, position: number) => as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${field}/options/${opt}`, { position });
    expect((await patch(ids.D, 1)).statusCode).toBe(200); // to index 1
    expect(await served(db, field)).toEqual(['A', 'D', 'B', 'C']);
    expect(dense(await stored(field))).toEqual([0, 1, 2, 3]);
    expect((await patch(ids.A, 99)).statusCode).toBe(200); // far past the end: last, still dense
    expect(await served(db, field)).toEqual(['D', 'B', 'C', 'A']);
    expect(dense(await stored(field))).toEqual([0, 1, 2, 3]);
  });

  it('setting a whole order one option at a time, index 0..n-1 in order (the web editor and the Linear importer do this), lands on that order', async () => {
    const { db, field, ids } = await selectField(['A', 'B', 'C', 'D']);
    const want = ['C', 'A', 'D', 'B'];
    for (const [i, label] of want.entries()) {
      expect((await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${field}/options/${ids[label]}`, { position: i })).statusCode).toBe(200);
    }
    expect(await served(db, field)).toEqual(want);
    expect(dense(await stored(field))).toEqual([0, 1, 2, 3]);
  });
});

describe('#961 POST .../options/reorder', () => {
  it('writes the given order as dense 0..n-1, and the SORT and the board\'s option order both follow it', async () => {
    const { db, field, ids } = await selectField(['Low', 'Medium', 'High', 'Urgent']);
    for (const [name, label] of [['t-high', 'High'], ['t-low', 'Low'], ['t-urgent', 'Urgent']] as const) {
      await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name, prio: ids[label] } });
    }
    const order = [ids.Urgent, ids.High, ids.Medium, ids.Low];
    const res = await as('POST', `/workspaces/${ws}/databases/${db}/fields/${field}/options/reorder`, { order });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().map((o: { label: string }) => o.label)).toEqual(['Urgent', 'High', 'Medium', 'Low']);
    expect(await stored(field)).toEqual([{ label: 'Urgent', position: 0 }, { label: 'High', position: 1 }, { label: 'Medium', position: 2 }, { label: 'Low', position: 3 }]);
    // what the board reads (the options as the API serves them) ...
    expect(await served(db, field)).toEqual(['Urgent', 'High', 'Medium', 'Low']);
    // ... and what a sort by the field returns
    const sorted = await as('POST', `/workspaces/${ws}/databases/${db}/records/query`, { sorts: [{ field: 'prio', direction: 'asc' }], limit: 10 });
    expect(sorted.json().data.map((r: { title: string }) => r.title)).toEqual(['t-urgent', 't-high', 't-low']);
  });

  it('refuses a partial list, a duplicate, and an id that is not on the field, and changes nothing', async () => {
    const { db, field, ids } = await selectField(['A', 'B', 'C']);
    const other = await selectField(['X']);
    const url = `/workspaces/${ws}/databases/${db}/fields/${field}/options/reorder`;
    const partial = await as('POST', url, { order: [ids.B, ids.A] });
    expect(partial.statusCode).toBe(422);
    expect(partial.json().error.message).toContain('"C"');
    expect((await as('POST', url, { order: [ids.A, ids.A, ids.B, ids.C] })).statusCode).toBe(422);
    expect((await as('POST', url, { order: [ids.A, ids.B, other.ids.X] })).statusCode).toBe(422);
    expect(await served(db, field), 'nothing was written').toEqual(['A', 'B', 'C']);
  });

  it('is admin-level schema work: a viewer-only guest is refused and nothing moves', async () => {
    const { db, field, ids } = await selectField(['A', 'B']);
    const guest = await joinAs(app, token, ws, 'Opt Viewer', 'guest', [{ database_id: db, role: 'viewer' }]);
    const res = await call(app, guest.token, 'POST', `/workspaces/${ws}/databases/${db}/fields/${field}/options/reorder`, { order: [ids.B, ids.A] });
    expect(res.statusCode, res.body).toBe(403);
    expect(await served(db, field)).toEqual(['A', 'B']);
  });

  it('works for workflow and multi_select fields too', async () => {
    const w = await selectField(['Todo', 'Doing', 'Done'], 'workflow');
    const r = await as('POST', `/workspaces/${ws}/databases/${w.db}/fields/${w.field}/options/reorder`, { order: [w.ids.Done, w.ids.Doing, w.ids.Todo] });
    expect(r.statusCode, r.body).toBe(201);
    expect(await served(w.db, w.field)).toEqual(['Done', 'Doing', 'Todo']);
  });
});

describe('#961 / #957 a text → choice conversion writes dense positions in FIRST-SEEN order', () => {
  it('options are 0..n-1 in the order the values first appear in the table (not by count, not alphabetical)', async () => {
    const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Conv ' + Math.random().toString(36).slice(2) })).json().id as string;
    const f = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Status', type: 'text' })).json();
    // first-seen order: zebra, apple, mango; apple is the most used and alphabetically first
    for (const v of ['zebra', 'apple', 'apple', 'mango', 'apple', 'zebra']) {
      await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: `r-${v}`, status: v } });
    }
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${f.id}/change-type`, { type: 'select', dry_run: true })).json().options.map((o: { label: string }) => o.label)).toEqual(['zebra', 'apple', 'mango']);
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${f.id}/change-type`, { type: 'select' })).statusCode).toBe(201);
    expect(await stored(f.id)).toEqual([{ label: 'zebra', position: 0 }, { label: 'apple', position: 1 }, { label: 'mango', position: 2 }]);
  });
});
