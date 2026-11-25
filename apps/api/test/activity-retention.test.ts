import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { activityEvents } from '../src/db/schema';
import {
  ActivityRetentionService,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  parseRetentionDays,
} from '../src/activity/activity-retention.service';

/**
 * Ticket #1024 — `activity_events` retention. What is under test is not "old rows disappear" but the three things a purge can get wrong:
 * it deletes something a reader still needs (the audit trail, My Work's "assigned by", an agent's monthly budget), it does so in a way
 * that hurts the running system (one giant DELETE, two nodes colliding), or it silently disagrees with the setting.
 *
 * Every assertion about a purged row is paired with an assertion that the row existed first, and every "kept" class is exercised with an
 * OLD row: a kept class tested with a young row proves nothing, the young row is kept by the retention itself.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let service: ActivityRetentionService;
let owner: { token: string; id: string };
let bea: { token: string; id: string };
let me: { token: string; id: string };
let ws: string;
let tasks: string;
let ownerField: string;
let ownerFieldId: string;
let titleFieldId: string;

const DAY = 24 * 60 * 60 * 1000;
/** The injected clock: fixed for the whole file, taken at start so rows the app writes during the run are never "old" to it. */
const NOW = new Date();
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const mk = async (name: string, values: Record<string, unknown> = {}) =>
  (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name, ...values } })).json().id as string;

async function seed(recordId: string | null, type: string, createdAt: Date, payload: Record<string, unknown> = {}) {
  const [row] = await raw.insert(activityEvents).values({ workspaceId: ws, recordId, actorId: owner.id, type, payload, createdAt }).returning({ id: activityEvents.id });
  return row!.id;
}
const present = async (ids: string[]) => new Set((await raw.select({ id: activityEvents.id }).from(activityEvents).where(inArray(activityEvents.id, ids))).map((r) => r.id));
const run = (opts: Parameters<ActivityRetentionService['purge']>[0] = {}) => service.purge({ now: NOW, pauseMs: 0, ...opts });

beforeAll(async () => {
  app = await createTestApp();
  service = app.get(ActivityRetentionService);
  const o = await signUpUser(app, 'Ret Owner');
  owner = { token: o.token, id: (await as(o.token, 'GET', '/me')).json().id };
  ws = (await as(owner.token, 'POST', '/workspaces', { name: 'Retention WS' })).json().id;
  const space = (await as(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await as(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  const f = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Owner', type: 'user' })).json();
  ownerField = f.apiName;
  ownerFieldId = f.id;
  const dbDesc = (await as(owner.token, 'GET', `/workspaces/${ws}/databases/${tasks}`)).json();
  titleFieldId = dbDesc.fields.find((x: { type: string }) => x.type === 'title').id;
  bea = await joinAs(app, owner.token, ws, 'Ret Bea', 'member');
  me = await joinAs(app, owner.token, ws, 'Ret Me', 'member');
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('the setting', () => {
  it('defaults to 90 days, understands never / 0, and raises anything under the floor to it', () => {
    expect(parseRetentionDays(undefined)).toEqual({ days: DEFAULT_RETENTION_DAYS, clamped: false });
    expect(parseRetentionDays('')).toEqual({ days: DEFAULT_RETENTION_DAYS, clamped: false });
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
    expect(parseRetentionDays('never')).toEqual({ days: null, clamped: false });
    expect(parseRetentionDays(' NEVER ')).toEqual({ days: null, clamped: false });
    expect(parseRetentionDays('0')).toEqual({ days: null, clamped: false });
    expect(parseRetentionDays('365')).toEqual({ days: 365, clamped: false });
    expect(parseRetentionDays('35')).toEqual({ days: 35, clamped: false });
    expect(parseRetentionDays('7')).toEqual({ days: MIN_RETENTION_DAYS, clamped: true });
    expect(() => parseRetentionDays('soon')).toThrow(/whole number/);
    expect(() => parseRetentionDays('-5')).toThrow(/whole number/);
    expect(() => parseRetentionDays('1.5')).toThrow(/whole number/);
  });
});

describe('what expires and what survives', () => {
  it('deletes every record-level class and the outward log; keeps structural events, person-field changes and anything young', async () => {
    const rec = await mk('retention classes');
    const old = ago(100);
    const expiring = {
      updated: await seed(rec, 'record.updated', old, { diff: { [titleFieldId]: { from: 'a', to: 'b' } } }),
      updatedNoDiff: await seed(rec, 'record.updated', old, {}),
      updatedBadDiff: await seed(rec, 'record.updated', old, { diff: 'not an object' }),
      created: await seed(rec, 'record.created', old),
      deleted: await seed(rec, 'record.deleted', old),
      linked: await seed(rec, 'relation.linked', old),
      reference: await seed(rec, 'reference.created', old),
      comment: await seed(rec, 'comment.created', old),
      doc: await seed(rec, 'document.edited', old),
      attachment: await seed(rec, 'attachment.added', old),
      button: await seed(rec, 'button.pressed', old),
      outward: await seed(null, 'outward.ai_field', old, { summary: 'x' }),
      outwardMail: await seed(null, 'outward.mention_email', old),
    };
    const kept = {
      structural: await seed(null, 'database.deleted', old, { object: { kind: 'database', id: rec, name: 'x' } }),
      view: await seed(null, 'view.restricted', old),
      portal: await seed(null, 'portal_recipient.rotated', old),
      runner: await seed(null, 'runner.revoked', old),
      futureAuditType: await seed(null, 'some_future_audit.thing', old),
      personField: await seed(rec, 'record.updated', old, { diff: { [ownerFieldId]: { from: null, to: me.id } } }),
      personFieldAmongOthers: await seed(rec, 'record.updated', old, { diff: { [titleFieldId]: { from: 'a', to: 'b' }, [ownerFieldId]: { from: me.id, to: null } } }),
      young: await seed(rec, 'record.updated', ago(10), { diff: { [titleFieldId]: { from: 'a', to: 'b' } } }),
      youngOutward: await seed(null, 'outward.ai_field', ago(10)),
    };
    const allIds = [...Object.values(expiring), ...Object.values(kept)];
    expect((await present(allIds)).size, 'premise: every seeded row exists before the purge').toBe(allIds.length);

    const result = await run();
    expect(result.deleted).toBeGreaterThanOrEqual(Object.keys(expiring).length);

    const left = await present(allIds);
    for (const [label, id] of Object.entries(expiring)) expect(left.has(id), `${label} expires`).toBe(false);
    for (const [label, id] of Object.entries(kept)) expect(left.has(id), `${label} is KEPT`).toBe(true);
  });

  it('is idempotent: a second run over the same data deletes nothing', async () => {
    const again = await run();
    expect(again).toMatchObject({ deleted: 0, batches: 0, capped: false, disabled: false });
  });
});

describe('the cutoff', () => {
  it('is exact: strictly older than now - retention goes, an event AT the cutoff and one a millisecond younger stay', async () => {
    const rec = await mk('boundary');
    const older = await seed(rec, 'comment.created', ago(90, 1));
    const exactly = await seed(rec, 'comment.created', ago(90));
    const younger = await seed(rec, 'comment.created', ago(90, -1));
    await run({ retentionDays: 90 });
    const left = await present([older, exactly, younger]);
    expect(left.has(older), 'one millisecond past the cutoff: gone').toBe(false);
    expect(left.has(exactly), 'exactly at the cutoff: kept').toBe(true);
    expect(left.has(younger), 'one millisecond inside: kept').toBe(true);
  });

  it('follows the injected clock, not the wall clock', async () => {
    const rec = await mk('clock');
    const e = await seed(rec, 'comment.created', ago(60));
    await run({ retentionDays: 90 });
    expect((await present([e])).size, '60 days old at the real now: kept').toBe(1);
    await run({ retentionDays: 90, now: new Date(NOW.getTime() + 40 * DAY) });
    expect((await present([e])).size, 'the same row 100 days old at a later clock: gone').toBe(0);
  });

  it('never goes below the floor, whatever is asked: 1 day behaves as 35 (a month of agent budget reads these rows)', async () => {
    const rec = await mk('floor');
    const budgetRow = await seed(null, 'outward.ai_field', ago(20), { usage: { tokens_in: 1, tokens_out: 1 } });
    const justInside = await seed(rec, 'comment.created', ago(MIN_RETENTION_DAYS - 1));
    const justOutside = await seed(rec, 'comment.created', ago(MIN_RETENTION_DAYS, 1));
    await run({ retentionDays: 1 });
    const left = await present([budgetRow, justInside, justOutside]);
    expect(left.has(budgetRow), 'this month\'s budget evidence survives').toBe(true);
    expect(left.has(justInside)).toBe(true);
    expect(left.has(justOutside), 'past the floor it does go').toBe(false);
  });

  it('"keep forever" deletes nothing, however old', async () => {
    const rec = await mk('forever');
    const e = await seed(rec, 'comment.created', ago(900));
    const out = await run({ retentionDays: null });
    expect(out).toEqual({ deleted: 0, batches: 0, capped: false, disabled: true });
    expect((await present([e])).size).toBe(1);
    await run({ retentionDays: 90 });
    expect((await present([e])).size, 'and is purged the moment a retention is set').toBe(0);
  });
});

describe('batching and concurrency', () => {
  const bulk = async (n: number, type = 'comment.created') => {
    const rec = await mk(`bulk ${type} ${n}`);
    const rows = Array.from({ length: n }, (_, i) => ({ workspaceId: ws, recordId: rec, actorId: owner.id, type, payload: {}, createdAt: ago(100 + (i % 7), i) }));
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += 500) ids.push(...(await raw.insert(activityEvents).values(rows.slice(i, i + 500)).returning({ id: activityEvents.id })).map((r) => r.id));
    return ids;
  };

  it('walks in several bounded batches and counts them: 23 rows at batch size 5 is 5 batches', async () => {
    const ids = await bulk(23);
    const out = await run({ batchSize: 5 });
    expect(out.deleted).toBe(23);
    expect(out.batches).toBe(5);
    expect(out.capped).toBe(false);
    expect((await present(ids)).size).toBe(0);
  });

  it('stops at the per-run cap and the next run finishes the job', async () => {
    const ids = await bulk(12);
    const first = await run({ batchSize: 5, maxBatches: 1 });
    expect(first).toMatchObject({ deleted: 5, batches: 1, capped: true });
    expect((await present(ids)).size, 'the rest is still there').toBe(7);
    const second = await run({ batchSize: 5 });
    expect(second).toMatchObject({ deleted: 7, capped: false });
    expect((await present(ids)).size).toBe(0);
  });

  it('skips over kept rows without re-reading them and without stalling: kept rows between expiring ones do not end the walk', async () => {
    const rec = await mk('interleaved');
    const keep: string[] = [];
    const drop: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      keep.push(await seed(null, 'database.deleted', ago(120, i * 1000)));
      drop.push(await seed(rec, 'comment.created', ago(120, i * 1000 + 500)));
    }
    const out = await run({ batchSize: 4 });
    expect(out.deleted).toBe(12);
    expect((await present(drop)).size).toBe(0);
    expect((await present(keep)).size, 'every kept row survived the walk').toBe(12);
  });

  it('two runs at once take disjoint rows: every row is deleted exactly once, no error, no deadlock', async () => {
    const ids = await bulk(300);
    const [a, b] = await Promise.all([run({ batchSize: 7 }), run({ batchSize: 7 })]);
    expect(a.deleted + b.deleted, 'together they deleted each row once, never twice').toBe(300);
    expect(a.deleted, 'both made progress, so the test really ran them side by side').toBeGreaterThan(0);
    expect(b.deleted).toBeGreaterThan(0);
    expect((await present(ids)).size).toBe(0);
  });
});

describe('readers tolerate a purged event', () => {
  it('the audit log lists without it and still lists the structural events that survive', async () => {
    const rec = await mk('audit reader');
    const doomed = await seed(rec, 'comment.created', ago(100));
    const survivor = await seed(null, 'database.deleted', ago(100), { object: { kind: 'database', id: rec, name: 'Old DB' } });
    const list = async () => {
      const res = await as(owner.token, 'GET', `/workspaces/${ws}/audit-log?limit=100&from=${encodeURIComponent(ago(400).toISOString())}`);
      expect(res.statusCode, res.body).toBe(200);
      return ((res.json().data ?? res.json().events) as Array<{ id?: string }>).map((r) => r.id);
    };
    const before = await list();
    expect(before, 'premise: the audit log shows both before the purge').toEqual(expect.arrayContaining([doomed, survivor]));
    await run();
    const after = await list();
    expect(after).not.toContain(doomed);
    expect(after).toContain(survivor);
  });

  it('a record feed cursor that points at a purged event still pages (a cursor is a tuple, not a row lookup)', async () => {
    const rec = await mk('cursor');
    const doomed = await seed(rec, 'comment.created', ago(100));
    const url = `/workspaces/${ws}/databases/${tasks}/records/${rec}/activity`;
    type Page = { data: Array<{ id: string }>; next_cursor: string | null };
    const get = async (qs: string) => {
      const res = await as(owner.token, 'GET', `${url}?${qs}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Page;
    };
    const all = await get('limit=100');
    expect(all.data.at(-1)!.id, 'premise: the old event is the oldest row of the feed').toBe(doomed);
    const cursorBeforeIt = (await get(`limit=${all.data.length - 1}`)).next_cursor;
    expect(cursorBeforeIt).not.toBeNull();
    expect((await get(`limit=100&cursor=${encodeURIComponent(cursorBeforeIt!)}`)).data.map((e) => e.id), 'premise: that cursor leads to it').toEqual([doomed]);
    await run();
    expect((await get(`limit=100&cursor=${encodeURIComponent(cursorBeforeIt!)}`)).data, 'the same cursor now reaches an empty end, not an error').toEqual([]);
    expect((await get('limit=100')).data.map((e) => e.id)).not.toContain(doomed);
  });

  it('asking for one purged event by id is a clear 404, not a 500', async () => {
    const rec = await mk('event by id');
    const id = await seed(rec, 'comment.created', ago(100));
    expect((await as(owner.token, 'GET', `/workspaces/${ws}/activity-events/${id}`)).statusCode, 'premise: it is readable before the purge').toBe(200);
    await run();
    const res = await as(owner.token, 'GET', `/workspaces/${ws}/activity-events/${id}`);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.message).toMatch(/event not found/);
  });

  it('My Work still says who assigned an old record: the person-field event that says so is not purged', async () => {
    const rec = await mk('assigned long ago');
    expect((await as(bea.token, 'PATCH', `/workspaces/${ws}/databases/${tasks}/records/${rec}`, { values: { [ownerField]: me.id } })).statusCode).toBe(200);
    // Everything about this record is now more than the retention old, as it would be for a task assigned months ago and still open.
    await raw.update(activityEvents).set({ createdAt: ago(200) }).where(and(eq(activityEvents.workspaceId, ws), eq(activityEvents.recordId, rec)));
    const assignedBy = async () => {
      const res = await as(me.token, 'GET', `/workspaces/${ws}/my-work?tab=assigned`);
      expect(res.statusCode, res.body).toBe(200);
      const rows = (res.json().groups as Array<{ database: { id: string }; records: Array<{ title: string; assigned_by: { id: string } | null }> }>).find((g) => g.database.id === tasks)?.records ?? [];
      return rows.find((r) => r.title === 'assigned long ago')?.assigned_by ?? null;
    };
    expect(await assignedBy(), 'premise: it reads Bea before the purge').toMatchObject({ id: bea.id });
    const out = await run();
    expect(out.deleted, 'the purge ran over this record (its record.created event went)').toBeGreaterThan(0);
    expect(await assignedBy(), 'and still reads Bea after').toMatchObject({ id: bea.id });
  });
});
