/**
 * #488 — relative date filters, counted at both edges.
 *
 * Two stacked defects on one path, and fixing either alone leaves the window
 * a day too wide:
 *
 *  1. The range constants were off by one — next_7_days was dayRange(0, 8),
 *     next_30_days dayRange(0, 31), last_7_days dayRange(-7, 1).
 *  2. For a date-only field the bounds are compared LEXICOGRAPHICALLY, and
 *     only `from` was sliced to 'YYYY-MM-DD'. `to` kept its full timestamp, and
 *     '2026-09-07' < '2026-09-07T00:00:00.000Z' is TRUE — so the bound that was
 *     meant to be exclusive included its own boundary day.
 *
 * A date filter is trusted absolutely: nobody counts the days a "next 7 days"
 * view returns, which is the whole reason for using it. So these assert the
 * boundary days BY DATE rather than by row count — a count can be right for
 * the wrong reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { records as recordsTable } from '../src/db/schema';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;
let db: Db;

/** The same UTC midnight the compiler's dayRange() uses. */
const midnightUtc = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};
/** 'YYYY-MM-DD', `offset` days from today, in UTC. */
const day = (offset: number) => new Date(midnightUtc() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Every offset we seed. Densely around every boundary, because a range only
 * looks correct when nothing is sitting on the day it leaks onto — which is
 * exactly why the backward window's bug survived Nadia's report. The first
 * version of this file omitted +2 and -2, and `tomorrow` and `this_month`
 * "passed" against the unfixed code for that reason alone.
 */
const OFFSETS = [-32, -31, -30, -8, -7, -6, -2, -1, 0, 1, 2, 6, 7, 8, 29, 30, 31];

/** The 1st of next month and the last day of this one, whatever today is. */
function monthEdges(): { firstOfNext: string; lastOfThis: string } {
  const now = new Date();
  const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const lastOfThis = new Date(firstOfNext.getTime() - 86_400_000);
  return {
    firstOfNext: firstOfNext.toISOString().slice(0, 10),
    lastOfThis: lastOfThis.toISOString().slice(0, 10),
  };
}

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

/**
 * The seeded dates that fall in [day(lo), day(hi)] inclusive.
 *
 * Derived from the fixture rather than hand-listed: the first version of this
 * file listed expected dates by hand, and densifying the fixture silently
 * broke three of them. An expectation that has to be maintained alongside the
 * fixture is an expectation that will drift.
 */
function seededBetween(lo: number, hi: number): string[] {
  const from = day(lo);
  const to = day(hi);
  const { firstOfNext, lastOfThis } = monthEdges();
  return [...new Set([...OFFSETS.map(day), firstOfNext, lastOfThis])]
    .filter((d) => d >= from && d <= to)
    .sort();
}

/** The `due` dates a relative range matches, sorted — the actual claim under test. */
async function matchedDates(range: string): Promise<string[]> {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
    filter: { field: 'due', op: 'within', value: range },
    limit: 100,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title).sort();
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get<Db>(DB);
  admin = await signUpUser(app, 'Dater488');
  wsId = (await inject('POST', '/workspaces', { name: 'Dates488' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Deadlines' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Due',
    type: 'date',
    config: {},
  });
  // Title IS the date, so a failure message names the leaking day directly.
  const { firstOfNext, lastOfThis } = monthEdges();
  const dates = [...new Set([...OFFSETS.map(day), firstOfNext, lastOfThis])];
  for (const date of dates) {
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: date, due: date },
    });
  }
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#488 — relative date ranges span exactly what they say', () => {
  it('next_7_days is seven days, exclusive of today (#523): today+1 through today+7', async () => {
    const matched = await matchedDates('next_7_days');
    expect(matched, 'today itself belongs to "today", not "next 7 days"').not.toContain(day(0));
    expect(matched, 'today+8 is the eighth day and must be excluded').not.toContain(day(8));
    expect(matched).toEqual(seededBetween(1, 7));
  });

  it('last_7_days is seven days, and it does NOT reach into tomorrow', async () => {
    // The half nobody could observe: Nadia had no record on tomorrow, so the
    // backward window's upper bound leaking a day was invisible in her data.
    // #523 — last_N_days stays INCLUSIVE of today; only next_N_days moved.
    const matched = await matchedDates('last_7_days');
    expect(matched, 'tomorrow must not appear in "last 7 days"').not.toContain(day(1));
    expect(matched, 'today-7 is the eighth day back and must be excluded').not.toContain(day(-7));
    expect(matched).toEqual(seededBetween(-6, 0));
  });

  it('next_30_days is thirty days, exclusive of today (#523): today+1 through today+30', async () => {
    const matched = await matchedDates('next_30_days');
    expect(matched, 'today itself belongs to "today", not "next 30 days"').not.toContain(day(0));
    expect(matched).toContain(day(30));
    expect(matched, 'today+31 is the 31st day and must be excluded').not.toContain(day(31));
    expect(matched).toEqual(seededBetween(1, 30));
  });

  it('today matches today ONLY — not today and tomorrow', async () => {
    // Shares the unsliced upper bound, so it was a two-day window as well.
    expect(await matchedDates('today')).toEqual([day(0)]);
  });

  it('yesterday matches yesterday only, and does not reach into today', async () => {
    expect(await matchedDates('yesterday')).toEqual([day(-1)]);
  });

  it('tomorrow matches tomorrow only — there IS a record on today+2 to prove it', async () => {
    const matched = await matchedDates('tomorrow');
    expect(matched, 'today+2 is seeded, so this cannot pass for want of a record').not.toContain(day(2));
    expect(matched).toEqual([day(1)]);
  });

  it('this_month stops at the last day of the month, not the 1st of the next', async () => {
    const now = new Date();
    const firstOfNext = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      .toISOString()
      .slice(0, 10);
    const matched = await matchedDates('this_month');
    // The 1st of next month is seeded explicitly, so this assertion has teeth.
    expect(matched, 'the 1st of next month belongs to next month').not.toContain(firstOfNext);
    // Everything it does match is inside this calendar month.
    const thisMonth = new Date().toISOString().slice(0, 7);
    expect(matched.every((d) => d.startsWith(thisMonth))).toBe(true);
  });

  /*
   * AC 5 — created_at/updated_at are real timestamp columns and take the
   * isTimestampCol branch, which passes Dates and never sliced, so they were
   * immune to the prefix bug. They still inherited the wrong CONSTANTS, and
   * "should be immune" is not a measurement — so this measures it.
   *
   * created_at is set by the server at insert, so the rows are backdated
   * directly afterwards. That is the only way to put a creation date in the
   * past, and it is confined to this test.
   */
  it('timestamp fields (created_at) span exactly seven days too', async () => {
    const rows = await db.query.records.findMany({
      where: eq(recordsTable.databaseId, dbId),
      columns: { id: true, title: true },
    });
    // Stamp each record's created_at onto the day its title names, at midday so
    // the assertion is about the DAY and not about a midnight boundary.
    for (const row of rows) {
      await db
        .update(recordsTable)
        .set({ createdAt: new Date(`${row.title}T12:00:00.000Z`) })
        .where(inArray(recordsTable.id, [row.id]));
    }

    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, {
      filter: { field: 'created_at', op: 'within', value: 'last_7_days' },
      limit: 100,
    });
    expect(res.statusCode, res.body).toBe(201);
    const matched = res.json().data.map((r: { title: string }) => r.title).sort();
    expect(matched, 'a timestamp window must not reach into tomorrow either').not.toContain(day(1));
    expect(matched).toEqual(seededBetween(-6, 0));
  });
});

describe('#523 — the relative-date family partitions cleanly around today', () => {
  it("today's record appears in last_7_days but NOT in next_7_days — the exact reported overlap", async () => {
    const last = await matchedDates('last_7_days');
    const next = await matchedDates('next_7_days');
    expect(last, 'last_7_days stays inclusive of today').toContain(day(0));
    expect(next, 'next_7_days is now exclusive of today — this is the fix').not.toContain(day(0));
    // No day is claimed by both windows.
    expect(last.filter((d) => next.includes(d))).toEqual([]);
  });

  it("today's record appears in last_7_days but NOT in next_30_days either", async () => {
    const last = await matchedDates('last_7_days');
    const next30 = await matchedDates('next_30_days');
    expect(last).toContain(day(0));
    expect(next30).not.toContain(day(0));
  });

  it('this_month is unaffected by the next-N-days exclusivity change (a different boundary concept)', async () => {
    // #523 AC 6 — this_month was never measured against the overlap question;
    // it isn't a "next N days" window at all (it's calendar-month, inclusive
    // of today by construction), so confirm today still falls inside it.
    const matched = await matchedDates('this_month');
    expect(matched).toContain(day(0));
  });
});
