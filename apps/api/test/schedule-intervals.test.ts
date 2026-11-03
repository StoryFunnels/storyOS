import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  isInScheduleWindow,
  latestScheduleSlot,
  nextScheduleSlot,
  scheduleProblems,
  scheduleRunsPerDay,
  type ScheduleTrigger,
} from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { automations } from '../src/db/schema';

/**
 * #1194 — schedule cadences: every N minutes (floor 10), hourly, weekdays, an active window, a per-rule time zone, and offline misses
 * coalesced into ONE wake. A controlled clock throughout: `nextScheduleSlot(trigger, from)` and `tick(now)` take the time as an
 * argument, so nothing here depends on when the suite runs or on the machine's zone.
 */
const T = (over: Partial<ScheduleTrigger>): ScheduleTrigger => ({ type: 'schedule', every: 'minutes', minutes: 15, timezone: 'UTC', ...over });
const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const next = (t: ScheduleTrigger, from: string) => iso(nextScheduleSlot(t, at(from)));

describe('#1194 the floor: one shared validation', () => {
  it('9 minutes is refused with a reason that names the floor; 10 is accepted', () => {
    expect(scheduleProblems(T({ minutes: 9 })).join(' ')).toMatch(/at most every 10 minutes.*got 9/);
    expect(scheduleProblems(T({ minutes: 10 }))).toEqual([]);
    expect(scheduleProblems(T({ minutes: 1 })).length).toBe(1);
    expect(scheduleProblems(T({ minutes: undefined })).join(' ')).toMatch(/needs "minutes"/);
  });
  it('refuses a window on a daily rule, weekdays on a weekly one, an empty window and a bad zone', () => {
    expect(scheduleProblems({ every: 'day', between: { from: '09:00', to: '18:00' } }).join(' ')).toMatch(/only applies/);
    expect(scheduleProblems({ every: 'week', weekdays: [1] }).join(' ')).toMatch(/weekday/);
    expect(scheduleProblems(T({ between: { from: '09:00', to: '09:00' } })).length).toBe(1);
    expect(scheduleProblems(T({ timezone: 'Mars/Olympus' })).join(' ')).toMatch(/IANA/);
  });
});

describe('#1194 next-due, controlled clock', () => {
  it('every 15 minutes: 15-minute slots', () => {
    expect(next(T({}), '2026-11-04T10:07:00Z')).toBe('2026-11-04T10:15:00.000Z');
    expect(next(T({}), '2026-11-04T10:15:00Z')).toBe('2026-11-04T10:30:00.000Z');
  });
  it('hourly: on the hour', () => {
    expect(next(T({ every: 'hour', minutes: undefined }), '2026-11-04T10:07:00Z')).toBe('2026-11-04T11:00:00.000Z');
  });
  it('weekdays skip Saturday and Sunday (Friday 17:30 -> Monday 09:00)', () => {
    const t = T({ every: 'day', minutes: undefined, at: '09:00', weekdays: [1, 2, 3, 4, 5] });
    expect(next(t, '2026-11-06T17:30:00Z')).toBe('2026-11-09T09:00:00.000Z');
    expect(next(t, '2026-11-09T08:00:00Z')).toBe('2026-11-09T09:00:00.000Z');
    expect(next(T({ every: 'hour', minutes: undefined, weekdays: [1, 2, 3, 4, 5] }), '2026-11-06T23:30:00Z')).toBe('2026-11-09T00:00:00.000Z');
  });
  it('the window: from inclusive, to exclusive, nothing outside, 54 runs a day at 10 minutes 9-18', () => {
    const t = T({ minutes: 10, between: { from: '09:00', to: '18:00' } });
    expect(next(t, '2026-11-04T08:55:00Z')).toBe('2026-11-04T09:00:00.000Z');
    expect(next(t, '2026-11-04T17:49:00Z')).toBe('2026-11-04T17:50:00.000Z');
    expect(next(t, '2026-11-04T17:50:00Z')).toBe('2026-11-05T09:00:00.000Z'); // 18:00 itself is not a slot
    expect(scheduleRunsPerDay(t)).toBe(54);
    expect(isInScheduleWindow(t, at('2026-11-04T09:00:00Z'))).toBe(true);
    expect(isInScheduleWindow(t, at('2026-11-04T18:00:00Z'))).toBe(false);
    expect(isInScheduleWindow(t, at('2026-11-04T08:59:00Z'))).toBe(false);
  });
  it('a window that spans midnight belongs to the day it STARTS (Fri 22:00 - Sat 06:00 with Mon-Fri)', () => {
    const t = T({ every: 'hour', minutes: undefined, weekdays: [1, 2, 3, 4, 5], between: { from: '22:00', to: '06:00' } });
    expect(next(t, '2026-11-06T21:00:00Z')).toBe('2026-11-06T22:00:00.000Z');
    expect(next(t, '2026-11-06T23:00:00Z')).toBe('2026-11-07T00:00:00.000Z'); // Saturday 00:00, owned by Friday
    expect(next(t, '2026-11-07T04:00:00Z')).toBe('2026-11-07T05:00:00.000Z');
    expect(next(t, '2026-11-07T05:00:00Z')).toBe('2026-11-09T22:00:00.000Z'); // 06:00 excluded; Sat 22:00 and Sun are not Mon-Fri; Mon 22:00 is
    expect(isInScheduleWindow(t, at('2026-11-07T03:00:00Z'))).toBe(true);
    expect(isInScheduleWindow(t, at('2026-11-08T03:00:00Z'))).toBe(false); // Sunday small hours belong to Saturday
  });
  it('time zone: 09:00 Europe/Madrid is 08:00 UTC in winter and 07:00 UTC in summer', () => {
    const t = T({ every: 'day', minutes: undefined, at: '09:00', timezone: 'Europe/Madrid' });
    expect(next(t, '2026-01-14T00:00:00Z')).toBe('2026-01-14T08:00:00.000Z');
    expect(next(t, '2026-07-14T00:00:00Z')).toBe('2026-07-14T07:00:00.000Z');
  });
  it('DST: a 15-minute rule has 92 slots on the 23-hour day and 100 on the 25-hour day, none doubled', () => {
    const t = T({ timezone: 'Europe/Madrid' });
    const count = (startIso: string, endIso: string) => {
      let n = 0;
      let cur = nextScheduleSlot(t, new Date(at(startIso).getTime() - 1));
      const seen = new Set<number>();
      while (cur < at(endIso)) { seen.add(cur.getTime()); n++; cur = nextScheduleSlot(t, cur); }
      expect(seen.size).toBe(n);
      return n;
    };
    expect(count('2027-03-27T23:00:00Z', '2027-03-28T22:00:00Z')).toBe(92);
    expect(count('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z')).toBe(100);
    // a daily 02:30 that does not exist on the spring-forward day fires once, just after the gap (03:30 local = 01:30 UTC)
    expect(next(T({ every: 'day', minutes: undefined, at: '02:30', timezone: 'Europe/Madrid' }), '2027-03-28T00:00:00Z')).toBe('2027-03-28T01:30:00.000Z');
  });
  it('legacy hour/day/week configs (no new keys) keep the original server-local arithmetic exactly', () => {
    const ref = (every: string, atStr: string | undefined, weekday: number | undefined, from: Date) => {
      const due = new Date(from);
      if (every === 'hour') { due.setMinutes(0, 0, 0); due.setHours(due.getHours() + 1); return due; }
      const [h, m] = (atStr ?? '09:00').split(':').map(Number);
      due.setHours(h!, m!, 0, 0);
      if (every === 'day') { if (due <= from) due.setDate(due.getDate() + 1); return due; }
      const target = weekday ?? 1;
      while (due.getDay() !== target || due <= from) due.setDate(due.getDate() + 1);
      return due;
    };
    const stored = [
      { every: 'hour' }, { every: 'day', at: '03:00' }, { every: 'day' }, { every: 'week', weekday: 1, at: '09:00' }, { every: 'week', weekday: 0 }, { every: 'week', at: '23:59', weekday: 6 },
    ] as const;
    for (const s of stored) {
      for (const from of ['2026-03-28T22:10:00Z', '2026-10-25T00:30:00Z', '2026-11-04T10:07:00Z', '2027-01-01T00:00:00Z']) {
        const trig = { type: 'schedule', ...s } as ScheduleTrigger;
        expect(iso(nextScheduleSlot(trig, at(from)))).toBe(iso(ref(s.every, 'at' in s ? s.at : undefined, 'weekday' in s ? s.weekday : undefined, at(from))));
      }
    }
  });
  it('latestScheduleSlot is the newest slot at or before a moment', () => {
    expect(iso(latestScheduleSlot(T({}), at('2026-11-04T12:07:00Z'))!)).toBe('2026-11-04T12:00:00.000Z');
  });
});

const { db: rawDb, pool } = connectTestDb();
let app: NestFastifyApplication;
let admin: { token: string };
let ws: string, contentDb: string, agentsDb: string;
let aiModeIds: Record<string, string> = {};
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const svc = () => app.get(AutomationsService);
const jobs = () => app.get(JobRunnerService);
async function mkAgent(name: string, aiMode: string | null, enabled = true): Promise<string> {
  const res = await as('POST', `/workspaces/${ws}/databases/${agentsDb}/records`, { values: { name, enabled, ...(aiMode ? { ai_mode: aiModeIds[aiMode] } : {}) } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const post = (trigger: unknown, agent?: string) =>
  as('POST', `/workspaces/${ws}/databases/${contentDb}/automations`, {
    name: `Rule ${Math.random().toString(36).slice(2, 8)}`,
    trigger,
    actions: [agent ? { type: 'run_agent', agent, target: 'trigger_record' } : { type: 'add_comment', body_template: 'hi' }],
  });
async function mkRule(agent: string, trigger: unknown, nextDueAt: Date, enabled = true) {
  const res = await post(trigger, agent);
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  await rawDb.update(automations).set({ nextDueAt, enabled }).where(eq(automations.id, id));
  return id;
}
const wakeRows = async (agent: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agent])).rows;
const dueOf = async (id: string) => (await rawDb.query.automations.findFirst({ where: eq(automations.id, id) }))!.nextDueAt!;
async function drain() { for (let i = 0; i < 6; i++) await jobs().tick(); }

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Schedule Intervals');
  ws = (await as('POST', '/workspaces', { name: 'Schedule Intervals WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDb = ensured.agentsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDb]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  contentDb = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tickets' })).json().id;
  for (let i = 0; i < 3; i++) await as('POST', `/workspaces/${ws}/databases/${contentDb}/records`, { values: { name: `Ticket ${i}` } });
}, 240_000);
afterAll(async () => { await app.close(); await pool.end(); });

describe('#1194 over REST and through the service (the path packs install through)', () => {
  it('9 minutes is a 422 with the reason, on create, on update and straight through the service; 10 is saved', async () => {
    const bad = await post({ type: 'schedule', every: 'minutes', minutes: 9 });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.body).toMatch(/at most every 10 minutes/);
    const ok = await post({ type: 'schedule', every: 'minutes', minutes: 10, timezone: 'UTC' });
    expect(ok.statusCode, ok.body).toBe(201);
    const upd = await as('PATCH', `/workspaces/${ws}/databases/${contentDb}/automations/${ok.json().id}`, { trigger: { type: 'schedule', every: 'minutes', minutes: 5 } });
    expect(upd.statusCode, upd.body).toBe(422);
    // the pack installer calls the service, not the controller: it must refuse too
    await expect(
      svc().create(ws, contentDb, { name: 'Pack rule', trigger: { type: 'schedule', every: 'minutes', minutes: 9 } as never, actions: [{ type: 'add_comment', body_template: 'x' }] as never }, 'u'),
    ).rejects.toThrow(/at most every 10 minutes/);
  });
  it('"Every weekday at 9:00" round-trips, and the response says which zone and how many runs a day', async () => {
    const trigger = { type: 'schedule', every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Madrid' };
    const res = await post(trigger);
    expect(res.statusCode, res.body).toBe(201);
    const list = async () => (await as('GET', `/workspaces/${ws}/databases/${contentDb}/automations`)).json().data as Array<{ id: string; trigger: unknown; schedule: Record<string, unknown> }>;
    const got = (await list()).find((r) => r.id === res.json().id)!;
    expect(got.trigger).toEqual(trigger);
    expect(got.schedule).toMatchObject({ timezone: 'Europe/Madrid', timezone_source: 'rule', runs_per_day: 1 });
    const legacy = await post({ type: 'schedule', every: 'day', at: '03:00' });
    const g2 = (await list()).find((r) => r.id === legacy.json().id)!;
    expect(g2.trigger).toEqual({ type: 'schedule', every: 'day', at: '03:00' });
    expect(g2.schedule.timezone_source).toBe('server_default');
    const win = await post({ type: 'schedule', every: 'minutes', minutes: 10, between: { from: '09:00', to: '18:00' }, timezone: 'UTC' });
    const g3 = (await list()).find((r) => r.id === win.json().id)!;
    expect(g3.schedule.runs_per_day).toBe(54);
  });
});

describe('#1194 one firing = one wake; offline misses coalesce into ONE', () => {
  const rule15 = { type: 'schedule', every: 'minutes', minutes: 15, timezone: 'UTC' };
  it('3 hours offline with a 15-minute rule is ONE wake, keyed to the latest missed slot; a second tick adds nothing', async () => {
    const agent = await mkAgent('Offline owl', 'Your own AI');
    const rule = await mkRule(agent, rule15, at('2026-11-04T09:00:00Z'));
    const now = at('2026-11-04T12:07:00Z');
    await svc().tick(now);
    await drain();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].source_key).toBe(`schedule:${rule}:0:2026-11-04T12:00:00.000Z`);
    expect(iso(await dueOf(rule))).toBe('2026-11-04T12:15:00.000Z');
    await svc().tick(now);
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
  });
  it('a wake still queued absorbs the next slot (one open wake), and replaying a slot adds nothing', async () => {
    const agent = await mkAgent('Queued owl', 'Your own AI');
    const rule = await mkRule(agent, rule15, at('2026-11-04T10:00:00Z'));
    await svc().tick(at('2026-11-04T10:01:00Z'));
    await drain();
    await svc().tick(at('2026-11-04T10:16:00Z'));
    await drain();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].coalesced_count).toBeGreaterThan(0);
    await rawDb.update(automations).set({ nextDueAt: at('2026-11-04T10:15:00Z') }).where(eq(automations.id, rule));
    await svc().tick(at('2026-11-04T10:16:00Z')); // the 10:15 slot offered again after a crash
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
  });
  it('two ticks at once fire the slot once', async () => {
    const agent = await mkAgent('Parallel interval owl', 'Your own AI');
    await mkRule(agent, rule15, at('2026-11-04T10:00:00Z'));
    const now = at('2026-11-04T10:01:00Z');
    await Promise.all([svc().tick(now), svc().tick(now)]);
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
  });
  it('a window rule that comes back OUTSIDE its window fires nothing and lands on the next in-window slot', async () => {
    const agent = await mkAgent('Window owl', 'Your own AI');
    const rule = await mkRule(agent, { ...rule15, between: { from: '09:00', to: '18:00' } }, at('2026-11-03T17:00:00Z'));
    await svc().tick(at('2026-11-04T07:30:00Z'));
    await drain();
    expect(await wakeRows(agent)).toHaveLength(0);
    expect(iso(await dueOf(rule))).toBe('2026-11-04T09:00:00.000Z');
    await svc().tick(at('2026-11-04T09:00:30Z')); // inside the window: fires
    await drain();
    expect(await wakeRows(agent)).toHaveLength(1);
  });
  it('a disabled rule and a disabled agent never fire', async () => {
    const a1 = await mkAgent('Off-rule owl', 'Your own AI');
    await mkRule(a1, rule15, at('2026-11-04T10:00:00Z'), false);
    const a2 = await mkAgent('Off-agent owl', 'Your own AI', false);
    await mkRule(a2, rule15, at('2026-11-04T10:00:00Z'));
    await svc().tick(at('2026-11-04T10:01:00Z'));
    await drain();
    expect(await wakeRows(a1)).toHaveLength(0);
    expect(await wakeRows(a2)).toHaveLength(0);
  });
});
