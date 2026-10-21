import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { authed, signUpUser } from './helpers/users';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';
import { RecordsService } from '../src/records/records.service';
import { records } from '../src/db/schema';
import { inArray } from 'drizzle-orm';

/**
 * #897 — two rollup recomputes for ONE record could persist out of order: each read the aggregate, then wrote it in a later
 * transaction with nothing ordering the two, so a recompute that had read an OLDER state could write LAST and leave a stale
 * materialized value (the one users sort by). Intermittent in CI (records-query-rollup-sort.test.ts), real in production.
 *
 * THIS TEST DOES NOT RACE: it forces the bad interleaving. Recompute A is held after it has READ the aggregate; the linked
 * record then changes and recompute B runs; A is released. Before the fix A writes its stale value last. After it, A holds a
 * per-record lock across its read AND its write, so B reads only after A has written, and the newest aggregate wins.
 */
const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, membersDb: string, timeoffDb: string;
let memberId: string, timeoffA: string, timeoffB: string;
let timeoffRelationFieldId: string;
let rollupFieldId: string;
let recordsService: RecordsService;

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(owner.token), payload: payload as never });
const stored = async () => {
  const row = await rawDb.query.records.findFirst({ where: eq(records.id, memberId), columns: { computedValues: true } });
  return (row!.computedValues as Record<string, unknown>)[rollupFieldId];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = await createTestApp();
  recordsService = app.get(RecordsService);
  owner = await signUpUser(app, 'RR Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Rollup Order WS' })).json().id;
  await app.get(MembersProjectionSubscriber).settle(ws);
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  membersDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Staff' })).json().id;
  timeoffDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Time Off' })).json().id;
  await inject('POST', `/workspaces/${ws}/databases/${timeoffDb}/fields`, { display_name: 'Days', type: 'number' });
  await inject('POST', `/workspaces/${ws}/relations`, { database_a_id: timeoffDb, database_b_id: membersDb, cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off' });
  const tf = (await inject('GET', `/workspaces/${ws}/databases/${timeoffDb}`)).json().fields;
  const memberFieldId = tf.find((f: { apiName: string }) => f.apiName === 'member').id;
  const mf = (await inject('GET', `/workspaces/${ws}/databases/${membersDb}`)).json().fields;
  timeoffRelationFieldId = mf.find((f: { apiName: string }) => f.apiName === 'time_off').id;
  const rollup = await inject('POST', `/workspaces/${ws}/databases/${membersDb}/fields`, { display_name: 'Days Used', type: 'rollup', config: { relation_field_id: timeoffRelationFieldId, op: 'sum', target_field_api_name: 'days' } });
  expect(rollup.statusCode, rollup.body).toBe(201);
  rollupFieldId = rollup.json().id;
  memberId = (await inject('POST', `/workspaces/${ws}/databases/${membersDb}/records`, { values: { name: 'Alpha' } })).json().id;
  const mk = async (days: number) => {
    const id = (await inject('POST', `/workspaces/${ws}/databases/${timeoffDb}/records`, { values: { name: `PTO ${days}`, days } })).json().id as string;
    expect((await inject('PUT', `/workspaces/${ws}/databases/${timeoffDb}/records/${id}/links/${memberFieldId}`, { record_ids: [memberId] })).statusCode).toBeLessThan(300);
    return id;
  };
  timeoffA = await mk(2);
  timeoffB = await mk(4);
  // settle the fire-and-forget cascades the setup itself triggered, so the test starts from a known stored value
  for (let i = 0; i < 100 && (await stored()) !== 6; i++) await sleep(50);
  await recordsService.recomputeRollupsForRelationField(membersDb, timeoffRelationFieldId, [memberId]);
  expect(await stored()).toBe(6);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#897 concurrent recomputes cannot persist out of order', () => {
  it('a recompute that read an OLDER aggregate does not overwrite a newer one: the newest aggregate always wins', async () => {
    const real = (RecordsService.prototype as unknown as { computeRollupValuesForChunk: (...a: unknown[]) => Promise<unknown> }).computeRollupValuesForChunk;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const spy = vi.spyOn(RecordsService.prototype as never, 'computeRollupValuesForChunk' as never).mockImplementation((async function (this: unknown, ...args: unknown[]) {
      const first = ++calls === 1;
      const value = await real.apply(this, args); // the aggregate this call READ
      if (first) await gate; // ...then held, as a slow recompute would be, before it persists
      return value;
    }) as never);
    try {
      const a = recordsService.recomputeRollupsForRelationField(membersDb, timeoffRelationFieldId, [memberId]); // reads 6, held
      await sleep(150);
      // the linked record changes: 4 -> 10, so the true aggregate is now 12
      expect((await inject('PATCH', `/workspaces/${ws}/databases/${timeoffDb}/records/${timeoffB}`, { values: { days: 10 } })).statusCode).toBe(200);
      const b = recordsService.recomputeRollupsForRelationField(membersDb, timeoffRelationFieldId, [memberId]); // the newer recompute
      await sleep(150);
      release(); // A now persists what it read
      await Promise.all([a, b]);
      await sleep(300); // let any cascade the PATCH itself started settle
      expect(await stored(), 'the stale aggregate (6) must not win over the newer one (12)').toBe(12);
    } finally {
      spy.mockRestore();
    }
  });

  it('MUST KEEP WORKING: an ordinary recompute is unchanged, and it does not block the write that triggered it', async () => {
    const started = Date.now();
    const res = await inject('PATCH', `/workspaces/${ws}/databases/${timeoffDb}/records/${timeoffA}`, { values: { days: 3 } });
    expect(res.statusCode).toBe(200);
    expect(Date.now() - started, 'the triggering write returns without waiting for the recompute').toBeLessThan(5_000);
    for (let i = 0; i < 100 && (await stored()) !== 13; i++) await sleep(50);
    expect(await stored()).toBe(13);
  });
});

/**
 * Vera's finding on the first version of this fix: the recompute held a TRANSACTION connection (for the advisory lock) while its
 * compute helpers read through `this.db`, a SECOND pool connection. The pool is the default 10; with more concurrent recomputes than
 * connections, every recompute held one and waited for another, so all of them waited on each other and the API stopped answering
 * (her rig: 40 parallel child PATCHes, ten connections "idle in transaction", GET /me timing out). Every read in a recompute now goes
 * through the connection that holds the lock.
 */
describe('#897 more concurrent recomputes than the pool has connections: the API keeps answering and every total settles', () => {
  it('40 parallel child PATCHes (pool of 10): GET /me answers while they run, and all 40 parents end with the right total', async () => {
    const PARENTS = 40;
    const parents: string[] = [];
    const children: string[] = [];
    const memberFieldId = (await inject('GET', `/workspaces/${ws}/databases/${timeoffDb}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'member').id as string;
    for (let i = 0; i < PARENTS; i++) {
      const parent = (await inject('POST', `/workspaces/${ws}/databases/${membersDb}/records`, { values: { name: `Pool parent ${i}` } })).json().id as string;
      const child = (await inject('POST', `/workspaces/${ws}/databases/${timeoffDb}/records`, { values: { name: `Pool child ${i}`, days: 1 } })).json().id as string;
      expect((await inject('PUT', `/workspaces/${ws}/databases/${timeoffDb}/records/${child}/links/${memberFieldId}`, { record_ids: [parent] })).statusCode).toBeLessThan(300);
      parents.push(parent);
      children.push(child);
    }
    const totals = async () => {
      const rows = await rawDb.query.records.findMany({ where: inArray(records.id, parents), columns: { id: true, computedValues: true } });
      return rows.map((r) => (r.computedValues as Record<string, unknown>)[rollupFieldId]);
    };
    for (let i = 0; i < 200 && !(await totals()).every((v) => v === 1); i++) await sleep(100); // the setup's own cascades

    // 40 recomputes at once, 4x the pool
    const patches = await Promise.all(children.map((id) => inject('PATCH', `/workspaces/${ws}/databases/${timeoffDb}/records/${id}`, { values: { days: 5 } })));
    expect(patches.every((r) => r.statusCode === 200)).toBe(true);

    // The API must stay responsive WHILE they run: a starved pool never answers this at all.
    const alive = await Promise.race([inject('GET', '/me').then((r) => r.statusCode), sleep(8_000).then(() => 'STARVED' as const)]);
    expect(alive, 'the API did not answer while 40 recomputes were running: the pool is starved').toBe(200);

    let settled = false;
    for (let i = 0; i < 300 && !settled; i++) {
      settled = (await totals()).every((v) => v === 5);
      if (!settled) await sleep(100);
    }
    expect(await totals(), 'every parent ends with its true total').toEqual(Array(PARENTS).fill(5));
  }, 120_000);
});
