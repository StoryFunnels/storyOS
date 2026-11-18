import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import { fields, records } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { RecordsService } from '../src/records/records.service';

/**
 * Ticket #1319 (follow-up to ticket #1314) — the WRITE side of derived fields.
 *
 * A record write fires a cascade that re-materializes the rollups (and the formulas over them) of every record linked to it. #1314
 * made the READ side survive a field that cannot be computed. These tests pin the same promise for writes:
 *
 *  - the record write itself succeeds and is committed,
 *  - the failing derived cell is stored as null (cleared, never left holding a stale number),
 *  - the other derived cells on the same records, and on every other parent of the fan-out, are still computed,
 *  - the failure is logged once per field, with no row data.
 *
 * Synthetic data only: a child database (Tasks) linked many-to-many to three parent databases (Orders, Projects, Teams), three
 * parent records each. The relations are created Projects, Teams, Orders so that the two BROKEN parent databases come first in the
 * order the cascade walks them.
 */

let app: NestFastifyApplication;
let db: Db;
let records_: RecordsService;
let admin: { token: string };
let wsId: string;
let tasksDb: string;
const parentDb: Record<string, string> = {};
const parentIds: Record<string, string[]> = {};
const taskFieldOnParent: Record<string, string> = {}; // parent db's relation field -> Tasks
const parentFieldOnTask: Record<string, string> = {}; // Tasks' relation field -> that parent db
const rollupId: Record<string, { hours: string; count: string; formula: string; hoursApi: string }> = {};
let taskId: string;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function makeDb(spaceId: string, name: string) {
  return (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id as string;
}

async function fieldIdOf(dbId: string, apiName: string) {
  const list = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().fields as Array<{ apiName: string; id: string }>;
  return list.find((f) => f.apiName === apiName)!.id;
}

async function computed(recordId: string): Promise<Record<string, unknown>> {
  const [row] = await db.select().from(records).where(eq(records.id, recordId));
  return (row!.computedValues ?? {}) as Record<string, unknown>;
}

/** The cascade is fire-and-forget after commit, so wait for a condition on stored state (never a fixed sleep). */
async function until(check: () => Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return check();
}

const HEALTHY = ['orders'] as const;
const BROKEN_SQL = 'projects'; // the database rejects the rollup's query while it runs: Postgres aborts a plain transaction
const BROKEN_JS = 'teams'; // a stored filter naming a field that no longer exists: throws before any SQL runs
const logs = () => vi.spyOn((records_ as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => undefined);

type ChunkFn = (def: { id: string }, defs: unknown, ids: string[], reader: Db) => Promise<unknown>;
let sqlFailure: { mockRestore: () => void } | undefined;

async function breakRollup(parent: string) {
  const id = rollupId[parent]!.hours;
  if (parent === BROKEN_SQL) {
    // A real database error raised on the connection the cascade is using, for this one rollup only; every other rollup runs as written.
    const svc = records_ as unknown as { computeRollupValuesForChunk: ChunkFn };
    const original = svc.computeRollupValuesForChunk.bind(svc);
    sqlFailure = vi.spyOn(svc, 'computeRollupValuesForChunk').mockImplementation(async (def, defs, ids, reader) => {
      if (def.id === id) await reader.execute(sql`select 1 / 0`);
      return original(def, defs, ids, reader);
    });
    return;
  }
  const [row] = await db.select().from(fields).where(eq(fields.id, id));
  await db.update(fields).set({ config: { ...(row!.config as object), filter: { field: 'gone_field', op: 'eq', value: 'x' } } }).where(eq(fields.id, id));
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  records_ = app.get(RecordsService);
  admin = await signUpUser(app, 'Guard Owner');
  wsId = (await inject('POST', '/workspaces', { name: 'Write Guard WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = await makeDb(spaceId, 'Tasks');
  await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Hours', type: 'number' });
  for (const name of ['projects', 'teams', 'orders']) {
    parentDb[name] = await makeDb(spaceId, name[0]!.toUpperCase() + name.slice(1));
    const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: tasksDb,
      database_b_id: parentDb[name],
      cardinality: 'many_to_many',
      field_a_name: name,
      field_b_name: 'Tasks',
    });
    expect(rel.statusCode, rel.body).toBe(201);
    taskFieldOnParent[name] = await fieldIdOf(parentDb[name]!, 'tasks');
    parentFieldOnTask[name] = await fieldIdOf(tasksDb, name);
    parentIds[name] = [];
    for (let i = 0; i < 3; i++) {
      parentIds[name]!.push(
        (await inject('POST', `/workspaces/${wsId}/databases/${parentDb[name]}/records`, { values: { name: `${name} ${i}` } })).json().id,
      );
    }
    // Broken-to-be rollup FIRST, so a healthy sibling is computed after it in the same transaction.
    const hours = await inject('POST', `/workspaces/${wsId}/databases/${parentDb[name]}/fields`, {
      display_name: 'Hours',
      type: 'rollup',
      config: { relation_field_id: taskFieldOnParent[name], op: 'sum', target_field_api_name: 'hours' },
    });
    expect(hours.statusCode, hours.body).toBe(201);
    const count = await inject('POST', `/workspaces/${wsId}/databases/${parentDb[name]}/fields`, {
      display_name: 'Task Count',
      type: 'rollup',
      config: { relation_field_id: taskFieldOnParent[name], op: 'count' },
    });
    expect(count.statusCode, count.body).toBe(201);
    const formula = await inject('POST', `/workspaces/${wsId}/databases/${parentDb[name]}/fields`, {
      display_name: 'Double Count',
      type: 'formula',
      config: { expression: '{Task Count} * 2' },
    });
    expect(formula.statusCode, formula.body).toBe(201);
    rollupId[name] = { hours: hours.json().id, count: count.json().id, formula: formula.json().id, hoursApi: hours.json().apiName };
  }
  const task = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Task A', hours: 5 } });
  expect(task.statusCode, task.body).toBe(201);
  taskId = task.json().id;
  for (const name of Object.keys(parentDb)) {
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}/links/${parentFieldOnTask[name]}`, {
      record_ids: parentIds[name],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);
  }
  // Everything healthy so far: wait for the materialized state to settle before anything is broken.
  for (const name of Object.keys(parentDb)) {
    for (const pid of parentIds[name]!) {
      expect(await until(async () => (await computed(pid))[rollupId[name]!.hours] === 5 && (await computed(pid))[rollupId[name]!.count] === 1), `${name} settles`).toBe(true);
    }
  }
}, 120_000);

afterAll(async () => {
  sqlFailure?.mockRestore();
  await app.close();
});

describe('ticket #1319: a record write whose related rollups cannot compute', () => {
  it('commits, clears the broken cells, and still computes every healthy cell on every parent of the fan-out', async () => {
    await breakRollup(BROKEN_SQL);
    await breakRollup(BROKEN_JS);
    const warn = logs();

    // Two writes in a row: the broken fields are logged once, not once per write.
    const first = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`, { values: { hours: 6 } });
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(await until(async () => (await computed(parentIds['orders']![0]!))[rollupId['orders']!.hours] === 6), 'first write cascades').toBe(true);
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`, { values: { hours: 7 } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    // The write is committed: a fresh read sees the new value.
    const read = await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`);
    expect(read.json().values.hours).toBe(7);

    // Orders is walked AFTER both broken parent databases: its three parents must still be recomputed.
    for (const pid of parentIds['orders']!) {
      expect(await until(async () => (await computed(pid))[rollupId['orders']!.hours] === 7), 'orders rollup recomputed').toBe(true);
      const c = await computed(pid);
      expect(c[rollupId['orders']!.count]).toBe(1);
      expect(c[rollupId['orders']!.formula]).toBe(2);
    }
    // The broken cells are CLEARED (null), not left holding the 5 they had before the field broke.
    for (const name of [BROKEN_SQL, BROKEN_JS]) {
      for (const pid of parentIds[name]!) {
        expect(await until(async () => (await computed(pid))[rollupId[name]!.hours] === null), `${name} broken cell cleared`).toBe(true);
        // ...while the SAME record's other derived cells are computed, even though the broken rollup is computed first.
        const c = await computed(pid);
        expect(c[rollupId[name]!.count], `${name} healthy sibling rollup`).toBe(1);
        expect(c[rollupId[name]!.formula], `${name} formula over the healthy sibling`).toBe(2);
      }
    }
    // One line per failing field however many parents and records were involved; field id + driver text only, no row data.
    const lines = warn.mock.calls.map((c) => String(c[0]));
    for (const name of [BROKEN_SQL, BROKEN_JS]) {
      expect(lines.filter((l) => l.includes(rollupId[name]!.hours)), `${name} logged once`).toHaveLength(1);
    }
    expect(lines.filter((l) => l.includes(rollupId['orders']!.hours))).toHaveLength(0);
    for (const l of lines) expect(l).not.toMatch(/Task A|projects \d|teams \d|orders \d|not-a-number/);
    warn.mockRestore();
  });

  it('create (inline link), link, unlink and batch update all succeed and keep healthy rollups right', async () => {
    const warn = logs();
    const ordersToday = async (pid: string) => (await computed(pid))[rollupId['orders']!.count];
    const o0 = parentIds['orders']![0]!;

    const created = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Task B', hours: 2, orders: [o0], projects: [parentIds['projects']![0]!], teams: [parentIds['teams']![0]!] },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(await until(async () => (await ordersToday(o0)) === 2), 'create recomputes').toBe(true);
    expect((await computed(o0))[rollupId['orders']!.hours]).toBe(9);

    const batch = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/batch`, {
      records: [{ values: { name: 'Task C', hours: 1, orders: [o0], projects: [parentIds['projects']![1]!] } }],
    });
    expect(batch.statusCode, batch.body).toBeLessThan(300);
    expect(await until(async () => (await ordersToday(o0)) === 3), 'batch create recomputes').toBe(true);

    const upd = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/batch`, {
      record_ids: [created.json().id],
      values: { hours: 10 },
    });
    expect(upd.statusCode, upd.body).toBeLessThan(300);
    expect(await until(async () => (await computed(o0))[rollupId['orders']!.hours] === 18), 'batch update recomputes').toBe(true); // 7 + 10 + 1

    const unlink = await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${created.json().id}/links/${parentFieldOnTask['orders']}`, {
      record_ids: [],
    });
    expect(unlink.statusCode, unlink.body).toBeLessThan(300);
    expect(await until(async () => (await ordersToday(o0)) === 2), 'unlink recomputes').toBe(true);
    expect((await computed(o0))[rollupId['orders']!.hours]).toBe(8);

    const relink = await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${created.json().id}/links/${parentFieldOnTask['orders']}`, {
      record_ids: [o0],
    });
    expect(relink.statusCode, relink.body).toBeLessThan(300);
    expect(await until(async () => (await ordersToday(o0)) === 3), 'relink recomputes').toBe(true);
    warn.mockRestore();
  });

  it('a failing rollup inside the chunk transaction cannot poison it (healthy sibling is written, broken cell cleared, nothing thrown)', async () => {
    const p = parentIds[BROKEN_SQL]![2]!;
    await expect(records_.recomputeRollupsForRelationField(parentDb[BROKEN_SQL]!, taskFieldOnParent[BROKEN_SQL]!, [p])).resolves.toBeUndefined();
    const c = await computed(p);
    expect(c[rollupId[BROKEN_SQL]!.hours]).toBeNull();
    expect(typeof c[rollupId[BROKEN_SQL]!.count]).toBe('number');
  });

  it('a cascade step that fails outside any one field (the whole Projects recompute throws) does not stop the other parents', async () => {
    const warn = logs();
    const svc = records_ as unknown as { recomputeRollupsForRelationField: (d: string, f: string, ids: string[]) => Promise<void> };
    const original = svc.recomputeRollupsForRelationField.bind(svc);
    const spy = vi.spyOn(svc, 'recomputeRollupsForRelationField').mockImplementation(async (d, f, ids) => {
      if (d === parentDb['projects']) throw new Error('connection reset (synthetic)');
      return original(d, f, ids);
    });
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`, { values: { hours: 11 } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    // Task A is the only task linked to Orders 1 and 2, so their sum is its hours; Order 0 also carries Task B (10) and Task C (1).
    for (const [pid, hours] of [[parentIds['orders']![0]!, 22], [parentIds['orders']![1]!, 11], [parentIds['orders']![2]!, 11]] as const) {
      expect(await until(async () => (await computed(pid))[rollupId['orders']!.hours] === hours), 'orders recomputed after the failed step').toBe(true);
    }
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(parentDb['projects']!) || l.includes('cascade'))).toHaveLength(1);
    spy.mockRestore();
    warn.mockRestore();
  });

  it('a formula whose inputs cannot be loaded on a write is stored as null (not left stale), and the healthy rollups are still written', async () => {
    const orders = parentDb['orders']!;
    const f = await inject('POST', `/workspaces/${wsId}/databases/${orders}/fields`, {
      display_name: 'Linked Tasks',
      type: 'formula',
      config: { expression: 'count({Tasks})' },
    });
    expect(f.statusCode, f.body).toBe(201);
    const o1 = parentIds['orders']![1]!;
    expect(await until(async () => typeof (await computed(o1))[f.json().id] === 'number'), 'formula materialized while healthy').toBe(true);
    const warn = logs();
    const svc = records_ as unknown as { loadRelatedBags: () => Promise<unknown> };
    const spy = vi.spyOn(svc, 'loadRelatedBags').mockRejectedValue(new Error('inputs unavailable (synthetic)'));
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`, { values: { hours: 13 } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(await until(async () => (await computed(o1))[f.json().id] === null), 'formula cleared').toBe(true);
    expect(await until(async () => (await computed(o1))[rollupId['orders']!.hours] === 13), 'healthy rollup still written').toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(f.json().id))).toHaveLength(1);
    spy.mockRestore();
    warn.mockRestore();
  });

  it('a record write needs no more access than before: a viewer still cannot write, and cannot read the parent databases', async () => {
    const viewer = await signUpUser(app, 'Guard Viewer');
    const denied = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`, { values: { hours: 99 } }, viewer.token);
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    const read = await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${taskId}`);
    expect(read.json().values.hours).not.toBe(99);
  });
});
