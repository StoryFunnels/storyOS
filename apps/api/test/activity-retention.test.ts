import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { activityEvents, billingSubscriptions, webhookSubscriptions } from '../src/db/schema';
import { env } from '../src/config/env';
import { EntitlementsService } from '../src/billing/entitlements.service';
import {
  ActivityRetentionService,
  ACTIVITY_RETENTION_DAYS_BY_PLAN,
  PURGE_NOT_BEFORE,
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
const { db: raw, pool } = connectTestDb();
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
/** Existing tests are about WHAT the purge deletes; the not-before gate (PURGE_NOT_BEFORE, ticket #1385) has its own describe below and runs with the real default. */
const OPEN = new Date(0);
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const mk = async (name: string, values: Record<string, unknown> = {}) =>
  (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name, ...values } })).json().id as string;

async function seed(recordId: string | null, type: string, createdAt: Date, payload: Record<string, unknown> = {}, workspaceId: string = ws) {
  const [row] = await raw.insert(activityEvents).values({ workspaceId, recordId, actorId: owner.id, type, payload, createdAt }).returning({ id: activityEvents.id });
  return row!.id;
}
const present = async (ids: string[]) => new Set((await raw.select({ id: activityEvents.id }).from(activityEvents).where(inArray(activityEvents.id, ids))).map((r) => r.id));
/** Most tests pin ONE value for everyone (`retentionDays: 90`) so they test a rule, not a plan; the per-plan tests pass `perPlan: true`. */
const run = (opts: Parameters<ActivityRetentionService['purge']>[0] = {}) => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN, retentionDays: 90, ...opts });
const perPlan = (opts: Parameters<ActivityRetentionService['purge']>[0] = {}) => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN, retentionDays: undefined, perPlan: true, ...opts });
type Plan = keyof typeof ACTIVITY_RETENTION_DAYS_BY_PLAN;
/** A fresh workspace with a record, on `plan` (free = no billing row at all, which is how a Free workspace really looks). */
async function newWs(plan: Plan | null): Promise<{ ws: string; rec: string }> {
  const w = (await as(owner.token, 'POST', '/workspaces', { name: `Ret ${plan ?? 'free'} ${Math.random().toString(36).slice(2, 8)}` })).json().id as string;
  const space = (await as(owner.token, 'GET', `/workspaces/${w}/spaces`)).json()[0].id;
  const db = (await as(owner.token, 'POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Things' })).json().id;
  const rec = (await as(owner.token, 'POST', `/workspaces/${w}/databases/${db}/records`, { values: { name: 'r' } })).json().id as string;
  if (plan) await raw.insert(billingSubscriptions).values({ workspaceId: w, plan });
  return { ws: w, rec };
}
/** Restore an env value after a test that sets it (env() is a cached object). */
async function withEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const e = env() as { ACTIVITY_EVENTS_RETENTION_DAYS?: string };
  const before = e.ACTIVITY_EVENTS_RETENTION_DAYS;
  e.ACTIVITY_EVENTS_RETENTION_DAYS = value;
  try {
    return await fn();
  } finally {
    e.ACTIVITY_EVENTS_RETENTION_DAYS = before;
  }
}

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
  it('the per-plan values are the ruling (ticket #1385): Free 30, Pro 365, Business 1095, Enterprise kept forever (null)', () => {
    expect(ACTIVITY_RETENTION_DAYS_BY_PLAN).toEqual({ free: 30, pro: 365, business: 1095, enterprise: null });
  });

  it('the purge may not start before 2026-12-27 00:00 UTC', () => {
    expect(PURGE_NOT_BEFORE.toISOString()).toBe('2026-12-27T00:00:00.000Z');
  });

  it('the self-hosted variable: unset, empty, never and 0 keep everything; a whole number is days; anything else is refused', () => {
    for (const v of [undefined, '', ' NEVER ', 'never', '0', '00']) expect(parseRetentionDays(v), String(v)).toBeNull();
    expect(parseRetentionDays('365')).toBe(365);
    expect(parseRetentionDays('1')).toBe(1);
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
    expect(again).toMatchObject({ deleted: 0, batches: 0, capped: false, disabled: false, held: false });
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

  it('"keep forever" deletes nothing, however old', async () => {
    const rec = await mk('forever');
    const e = await seed(rec, 'comment.created', ago(900));
    const out = await run({ retentionDays: null });
    expect(out).toEqual({ deleted: 0, batches: 0, capped: false, disabled: true, held: false });
    expect((await present([e])).size).toBe(1);
    await run({ retentionDays: 90 });
    expect((await present([e])).size, 'and is purged the moment a retention is set').toBe(0);
  });
});

describe('per plan (hosted)', () => {
  const plans: Plan[] = ['free', 'pro', 'business', 'enterprise'];

  const finitePlans = plans.filter((p) => ACTIVITY_RETENTION_DAYS_BY_PLAN[p] !== null);

  it('every plan with a window deletes exactly at its own boundary and keeps what is newer, in ONE pass over mixed workspaces', async () => {
    const seeded = new Map<Plan, { ws: string; older: string; exactly: string; younger: string; structural: string }>();
    for (const plan of finitePlans) {
      const { ws: w, rec } = await newWs(plan === 'free' ? null : plan);
      const days = ACTIVITY_RETENTION_DAYS_BY_PLAN[plan]!;
      seeded.set(plan, {
        ws: w,
        older: await seed(rec, 'comment.created', ago(days, 1), {}, w),
        exactly: await seed(rec, 'comment.created', ago(days), {}, w),
        younger: await seed(rec, 'comment.created', ago(days, -1), {}, w),
        structural: await seed(null, 'database.deleted', ago(400), {}, w),
      });
    }
    const all = [...seeded.values()].flatMap((r) => [r.older, r.exactly, r.younger, r.structural]);
    expect((await present(all)).size, 'premise: all seeded').toBe(all.length);
    const out = await perPlan();
    expect(out.deleted).toBeGreaterThanOrEqual(finitePlans.length);
    const left = await present(all);
    for (const plan of finitePlans) {
      const r = seeded.get(plan)!;
      expect(left.has(r.older), `${plan}: a millisecond past ${ACTIVITY_RETENTION_DAYS_BY_PLAN[plan]} days is gone`).toBe(false);
      expect(left.has(r.exactly), `${plan}: exactly at the boundary is kept`).toBe(true);
      expect(left.has(r.younger), `${plan}: a millisecond inside is kept`).toBe(true);
      expect(left.has(r.structural), `${plan}: a structural event is never purged`).toBe(true);
    }
  });

  it('ENTERPRISE (null) is never purged: an event of any age and class survives a pass that deletes a Free workspace\'s in the same run', async () => {
    const ent = await newWs('enterprise');
    const free = await newWs(null);
    const old = ago(5000);
    const kept = {
      comment: await seed(ent.rec, 'comment.created', old, {}, ent.ws),
      updated: await seed(ent.rec, 'record.updated', old, { diff: { [titleFieldId]: { from: 'a', to: 'b' } } }, ent.ws),
      outwardOldMonth: await seed(null, 'outward.ai_field', old, {}, ent.ws),
      created: await seed(ent.rec, 'record.created', old, {}, ent.ws),
    };
    const control = await seed(free.rec, 'comment.created', old, {}, free.ws);
    const all = [...Object.values(kept), control];
    expect((await present(all)).size, 'premise: all seeded').toBe(all.length);
    const out = await perPlan();
    expect(out.deleted, 'the pass really ran and deleted the Free control').toBeGreaterThanOrEqual(1);
    const left = await present(all);
    expect(left.has(control), 'Free: 5000 days is purged').toBe(false);
    for (const [label, id] of Object.entries(kept)) expect(left.has(id), `Enterprise ${label} is kept forever`).toBe(true);
  });

  it('a workspace is judged by ITS plan, not its neighbour\'s: the same 40-day-old row goes on Free and stays on Pro', async () => {
    const free = await newWs(null);
    const pro = await newWs('pro');
    const f = await seed(free.rec, 'comment.created', ago(40), {}, free.ws);
    const p = await seed(pro.rec, 'comment.created', ago(40), {}, pro.ws);
    await perPlan();
    expect((await present([f])).size).toBe(0);
    expect((await present([p])).size).toBe(1);
  });

  it('a plan the map does not know deletes NOTHING for that workspace (no ELSE in the CASE), while the others are still purged', async () => {
    const free = await newWs(null);
    const pro = await newWs('pro');
    const f = await seed(free.rec, 'comment.created', ago(40), {}, free.ws);
    const p = await seed(pro.rec, 'comment.created', ago(500), {}, pro.ws);
    const map = ACTIVITY_RETENTION_DAYS_BY_PLAN as Record<string, number | null>;
    const saved = map.pro!;
    delete map.pro;
    try {
      await perPlan();
    } finally {
      map.pro = saved!;
    }
    expect((await present([f])).size, 'Free is still purged').toBe(0);
    expect((await present([p])).size, 'the workspace on the unknown plan is left alone').toBe(1);
  });

  it('retentionDaysFor reports the same number the purge applies: the plan\'s on hosted, the variable elsewhere', async () => {
    const hosted = vi.spyOn(EntitlementsService.prototype, 'hostedPlans', 'get');
    try {
      hosted.mockReturnValue(true);
      for (const plan of plans) {
        const { ws: w } = await newWs(plan === 'free' ? null : plan);
        expect(await service.retentionDaysFor(w), plan).toBe(ACTIVITY_RETENTION_DAYS_BY_PLAN[plan]);
      }
    } finally {
      hosted.mockRestore();
    }
    expect(await withEnv(undefined, () => service.retentionDaysFor(ws)), 'self-hosted, unset: kept forever').toBeNull();
    expect(await withEnv('45', () => service.retentionDaysFor(ws))).toBe(45);
  });

  it('the audit log says which window applies (retention_days): the plan\'s on hosted, null when kept forever', async () => {
    const auditOf = async (w: string) => {
      const res = await as(owner.token, 'GET', `/workspaces/${w}/audit-log?limit=5`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().retention_days;
    };
    const pro = await newWs('pro');
    expect(await withEnv(undefined, () => auditOf(pro.ws)), 'self-hosted, unset').toBeNull();
    expect(await withEnv('45', () => auditOf(pro.ws))).toBe(45);
    const hosted = vi.spyOn(EntitlementsService.prototype, 'hostedPlans', 'get').mockReturnValue(true);
    try {
      expect(await auditOf(pro.ws)).toBe(365);
      expect(await auditOf((await newWs(null)).ws)).toBe(30);
      expect(await auditOf((await newWs('enterprise')).ws), 'Enterprise: kept forever').toBeNull();
    } finally {
      hosted.mockRestore();
    }
  });
});

describe('the system floor holds below the plan value', () => {
  /**
   * 31 July 12:00 UTC: Free keeps 30 days, so its cutoff is 1 July 12:00, and an event from the first half-day of July is BOTH
   * past the plan window and inside the current month. A mid-month clock could never exercise the month floor against a 30-day window.
   */
  const CLOCK = new Date(Date.UTC(2026, 6, 31, 12));
  const back = (days: number, extraMs = 0) => new Date(CLOCK.getTime() - days * DAY - extraMs);
  const sub = (workspaceId: string, cursorAt: Date, enabled = true) =>
    raw.insert(webhookSubscriptions).values({ workspaceId, url: 'https://example.test/hook', secret: 's', events: ['record.updated'], enabled, cursorAt });
  const onClock = (opts = {}) => perPlan({ now: CLOCK, ...opts });

  it('FLOOR 1: on Free (30 days) an outward.* row from THIS calendar month survives, one from LAST month is purged', async () => {
    const f = await newWs(null);
    const earlyJuly = new Date(Date.UTC(2026, 6, 1, 6)); // 30.25 days before the clock: past the plan window, inside the month
    const thisMonth = await seed(null, 'outward.ai_field', earlyJuly, { usage: { tokens_in: 1, tokens_out: 1 } }, f.ws);
    const lastMonth = await seed(null, 'outward.ai_field', new Date(Date.UTC(2026, 5, 5)), {}, f.ws);
    const monthStart = await seed(null, 'outward.mention_email', new Date(Date.UTC(2026, 6, 1)), {}, f.ws);
    const beforeMonthStart = await seed(null, 'outward.mention_email', new Date(Date.UTC(2026, 5, 30, 23, 59, 59, 999)), {}, f.ws);
    const control = await seed(f.rec, 'comment.created', earlyJuly, {}, f.ws); // the plan value itself still applies to everything else
    await onClock();
    const left = await present([thisMonth, lastMonth, monthStart, beforeMonthStart, control]);
    expect(left.has(thisMonth), 'this month\'s agent-budget evidence survives a 30-day plan').toBe(true);
    expect(left.has(monthStart), 'the first instant of the month is this month').toBe(true);
    expect(left.has(lastMonth), 'last month is purged at the plan value').toBe(false);
    expect(left.has(beforeMonthStart), 'a millisecond before the month began is last month').toBe(false);
    expect(left.has(control), 'the plan value still deletes an ordinary record event').toBe(false);
  });

  it('FLOOR 2: a row the webhook dispatcher has not passed survives on Free; one it has passed is purged; a disabled subscription pins nothing', async () => {
    const lagging = await newWs(null);
    const caught = await newWs(null);
    const off = await newWs(null);
    const none = await newWs(null);
    await sub(lagging.ws, back(35)); // the dispatcher is 35 days behind
    await sub(caught.ws, new Date(CLOCK.getTime() - 3_600_000)); // up to date
    await sub(off.ws, back(35), false); // disabled: the dispatcher skips it
    const unpassed = await seed(lagging.rec, 'record.updated', back(32), {}, lagging.ws); // after its cursor, older than 30 days
    const passed = await seed(lagging.rec, 'record.updated', back(40), {}, lagging.ws); // before its cursor
    const caughtUp = await seed(caught.rec, 'record.updated', back(32), {}, caught.ws);
    const disabled = await seed(off.rec, 'record.updated', back(32), {}, off.ws);
    const noSub = await seed(none.rec, 'record.updated', back(32), {}, none.ws);
    await onClock();
    const left = await present([unpassed, passed, caughtUp, disabled, noSub]);
    expect(left.has(unpassed), 'an undelivered event is never purged').toBe(true);
    expect(left.has(passed), 'a delivered one is purged at the plan value').toBe(false);
    expect(left.has(caughtUp), 'a caught-up dispatcher pins nothing').toBe(false);
    expect(left.has(disabled)).toBe(false);
    expect(left.has(noSub)).toBe(false);
  });

  it('FLOOR 2 follows the dispatcher as it advances: once it passes the row, the next purge deletes it', async () => {
    const w = await newWs(null);
    await sub(w.ws, back(35));
    const e = await seed(w.rec, 'record.updated', back(32), {}, w.ws);
    await onClock();
    expect((await present([e])).size, 'held while undelivered').toBe(1);
    await raw.update(webhookSubscriptions).set({ cursorAt: new Date(CLOCK.getTime() - 1000) }).where(eq(webhookSubscriptions.workspaceId, w.ws));
    await onClock();
    expect((await present([e])).size, 'released once delivered').toBe(0);
  });

  it('the floor applies to a pinned retention too (retentionDays: 1 still keeps this month\'s outward rows and undelivered events)', async () => {
    const w = await newWs(null);
    await sub(w.ws, back(10));
    const outward = await seed(null, 'outward.ai_field', back(15), {}, w.ws);
    const undelivered = await seed(w.rec, 'record.updated', back(8), {}, w.ws);
    await service.purge({ now: CLOCK, pauseMs: 0, notBefore: OPEN, retentionDays: 1 });
    expect((await present([outward, undelivered])).size).toBe(2);
  });
});

describe('self-hosted: no plan, the variable decides', () => {
  const selfHosted = (opts = {}) => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN, retentionDays: undefined, perPlan: false, ...opts });

  it('unset, 0 and never keep everything, however old', async () => {
    const rec = await mk('selfhost keep');
    const e = await seed(rec, 'comment.created', ago(900));
    for (const v of [undefined, '0', 'never']) {
      const out = await withEnv(v, () => selfHosted());
      expect(out, String(v)).toEqual({ deleted: 0, batches: 0, capped: false, disabled: true, held: false });
    }
    expect((await present([e])).size).toBe(1);
    await run();
  });

  it('a number of days applies to every workspace whatever its billing row says', async () => {
    const pro = await newWs('pro');
    const old = await seed(pro.rec, 'comment.created', ago(61), {}, pro.ws);
    const fresh = await seed(pro.rec, 'comment.created', ago(59), {}, pro.ws);
    await withEnv('60', () => selfHosted());
    expect((await present([old])).size, '61 days at 60: gone').toBe(0);
    expect((await present([fresh])).size, '59 days at 60: kept').toBe(1);
  });

  it('a hosted deployment ignores the variable: the plan decides', async () => {
    const free = await newWs(null);
    const e = await seed(free.rec, 'comment.created', ago(40), {}, free.ws);
    await withEnv('1000', () => perPlan());
    expect((await present([e])).size).toBe(0);
  });

  it('with no options at all a self-hosted run reads the variable (unset: nothing is deleted)', async () => {
    const rec = await mk('default path');
    const e = await seed(rec, 'comment.created', ago(900));
    const out = await withEnv(undefined, () => service.purge({ now: NOW, pauseMs: 0, notBefore: OPEN }));
    expect(out.disabled).toBe(true);
    expect((await present([e])).size).toBe(1);
    await run();
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

  it('kept rows between expiring ones do not end the walk or get deleted', async () => {
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

  it('rows another transaction holds locked are skipped, not waited for: the run finishes, and a later run takes them', async () => {
    const ids = await bulk(20);
    const held = ids.slice(0, 5);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM activity_events WHERE id = ANY($1::uuid[]) FOR UPDATE', [held]);
      const out = await Promise.race([run({ batchSize: 4 }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('purge waited on a locked row')), 8_000))]);
      expect(out.deleted, 'everything not locked went').toBe(15);
      expect((await present(ids)).size, 'the five locked rows are still there').toBe(5);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await run()).deleted).toBe(5);
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

describe('the purge may not start before 2026-12-27 (ticket #1385)', () => {
  // These run with the REAL gate (no `notBefore`), and go last: a run dated Dec 27 judges every older row in the shared database.
  const before = new Date(PURGE_NOT_BEFORE.getTime() - 1);
  const on = PURGE_NOT_BEFORE;
  const at = (iso: string) => new Date(iso);

  it('a run dated one millisecond before it deletes nothing and says so; the same data goes on the first instant of the day', async () => {
    const rec = await mk('gate');
    const old = await seed(rec, 'comment.created', at('2026-09-01T00:00:00Z'));
    const heldRun = await service.purge({ now: before, pauseMs: 0, retentionDays: 90 });
    expect(heldRun).toEqual({ deleted: 0, batches: 0, capped: false, disabled: false, held: true });
    expect((await present([old])).size, 'still there: the row is 117 days old at a 90-day window, so only the gate kept it').toBe(1);
    const open = await service.purge({ now: on, pauseMs: 0, retentionDays: 90 });
    expect(open).toMatchObject({ held: false });
    expect(open.deleted).toBeGreaterThanOrEqual(1);
    expect((await present([old])).size, 'deleted on 2026-12-27 00:00:00 UTC').toBe(0);
  });

  it('holds every path: the per-plan run, a pinned retention and the self-hosted variable', async () => {
    const free = await newWs(null);
    const rec = await mk('gate paths');
    const f = await seed(free.rec, 'comment.created', at('2026-09-01T00:00:00Z'), {}, free.ws);
    const p = await seed(rec, 'comment.created', at('2026-09-01T00:00:00Z'));
    const runs = [
      await service.purge({ now: before, pauseMs: 0, retentionDays: undefined, perPlan: true }),
      await service.purge({ now: before, pauseMs: 0, retentionDays: 1 }),
      await withEnv('1', () => service.purge({ now: before, pauseMs: 0, retentionDays: undefined, perPlan: false })),
      await service.purge({ now: new Date(0), pauseMs: 0 }),
    ];
    for (const out of runs) expect(out).toMatchObject({ deleted: 0, held: true });
    expect((await present([f, p])).size).toBe(2);
  });

  it('on and after the date it deletes per plan: Free 30 days goes, Pro 365 and Enterprise stay', async () => {
    const free = await newWs(null);
    const pro = await newWs('pro');
    const ent = await newWs('enterprise');
    const fOld = await seed(free.rec, 'comment.created', at('2026-11-26T23:59:59Z'), {}, free.ws); // 30 days + 1 s at the cutoff of 2026-11-27 00:00
    const fNew = await seed(free.rec, 'comment.created', at('2026-12-10T00:00:00Z'), {}, free.ws);
    const pOld = await seed(pro.rec, 'comment.created', at('2026-09-01T00:00:00Z'), {}, pro.ws);
    const eOld = await seed(ent.rec, 'comment.created', at('2020-01-01T00:00:00Z'), {}, ent.ws);
    const out = await service.purge({ now: at('2026-12-28T12:00:00Z'), pauseMs: 0, retentionDays: undefined, perPlan: true });
    expect(out.held).toBe(false);
    const left = await present([fOld, fNew, pOld, eOld]);
    expect(left.has(fOld), 'Free: past 30 days').toBe(false);
    expect(left.has(fNew), 'Free: inside 30 days').toBe(true);
    expect(left.has(pOld), 'Pro: 118 days is inside 365').toBe(true);
    expect(left.has(eOld), 'Enterprise: never').toBe(true);
  });
});
