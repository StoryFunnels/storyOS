import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// Before ANY import: a Stripe key is what makes this deployment "hosted" (plans exist). The real detection decides, nothing is mocked.
vi.hoisted(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_version_window_detection';
});

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import { billingSubscriptions, documentVersions, recordFieldChanges, recordVersions, records } from '../src/db/schema';
import { PURGE_NOT_BEFORE } from '../src/activity/activity-retention.service';
import { windowClock } from '../src/activity/history-window';

/**
 * Ticket #1386 — the plan window on the READ side. The window (plans.ts `historyRetentionDays`: Free 14, Pro 270, Business 730,
 * Enterprise 1825) used to gate CAPTURE only, so a customer could list and restore history older than their plan allows. A version
 * older than the window is now not listed and not restorable, from the not-before date (2026-12-27 UTC) on: before it, nothing
 * changes for anyone. Both sides of that date are tested through the clock seam, set around the request and nothing else.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
const DAY = 24 * 60 * 60 * 1000;
const BEFORE = new Date(PURGE_NOT_BEFORE.getTime() - 12 * 60 * 60 * 1000); // 2026-12-26 12:00 UTC
const AFTER = new Date(PURGE_NOT_BEFORE.getTime() + 12 * 60 * 60 * 1000); // 2026-12-27 12:00 UTC
/** Row ages are counted back from AFTER, so they are the same age at AFTER and 1 day younger at BEFORE: a 40-day row is past Free's 14 at both. */
const ago = (days: number) => new Date(AFTER.getTime() - days * DAY);

/** The read-side clock is a seam (`windowClock`), not a faked Date: a session token issued today is not valid a month from now. */
async function atClock<T>(clock: Date, fn: () => Promise<T>): Promise<T> {
  const prev = windowClock.now;
  windowClock.now = () => clock;
  try {
    return await fn();
  } finally {
    windowClock.now = prev;
  }
}

type Plan = 'free' | 'pro' | 'business' | 'enterprise';
interface Fixture {
  ws: string;
  db: string;
  rec: string;
  space: string;
  owner: { token: string; email: string };
  base: string;
  as: (method: string, url: string, payload?: unknown) => ReturnType<typeof call>;
}

/** Hosted Free caps the workspaces one person can create, so every workspace gets its own owner. The plan is set before anything reads it. */
async function newWs(plan: Plan): Promise<Fixture> {
  const owner = await signUpUser(app, `Window Owner ${Math.random().toString(36).slice(2, 8)}`);
  const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
  const ws = (await as('POST', '/workspaces', { name: `Window ${plan}` })).json().id as string;
  if (plan !== 'free') await raw.insert(billingSubscriptions).values({ workspaceId: ws, plan });
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Things' })).json().id as string;
  const rec = (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'current' } })).json().id as string;
  return { ws, db, rec, space, owner, as, base: `/workspaces/${ws}/databases/${db}/records` };
}

async function addRecord(f: Fixture, name: string): Promise<string> {
  return (await f.as('POST', f.base, { values: { name } })).json().id as string;
}
const seedVersion = async (f: Fixture, rec: string, days: number) =>
  (await raw.insert(recordVersions).values({ workspaceId: f.ws, recordId: rec, title: 'older title', values: {}, createdAt: ago(days) }).returning({ id: recordVersions.id }))[0]!.id;
const seedChange = async (f: Fixture, rec: string, days: number) =>
  (await raw.insert(recordFieldChanges).values({ workspaceId: f.ws, databaseId: f.db, recordId: rec, fieldId: null, oldValue: 'a', newValue: 'b', createdAt: ago(days) }).returning({ id: recordFieldChanges.id }))[0]!.id;
const DOC = (text: string) => [{ type: 'paragraph', content: [{ type: 'text', text, styles: {} }] }];
async function writeDoc(f: Fixture, rec: string) {
  await f.as('PUT', `${f.base}/${rec}/document`, { content: DOC('first'), expected_version: 0 });
  await f.as('PUT', `${f.base}/${rec}/document`, { content: DOC('second'), expected_version: 1 });
}
const seedDocVersion = async (f: Fixture, rec: string, days: number) =>
  (await raw.insert(documentVersions).values({ workspaceId: f.ws, recordId: rec, content: DOC('ancient'), version: 1, createdAt: ago(days) }).returning({ id: documentVersions.id }))[0]!.id;

const ids = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((v) => v.id);
/** A 404's body minus the per-request id: what must be IDENTICAL for a version outside the window and one that never existed. */
const shape = (res: { statusCode: number; json: () => Record<string, unknown> }) => {
  const body = res.json() as { error?: Record<string, unknown> } & Record<string, unknown>;
  const { request_id: _a, requestId: _b, ...rest } = (body.error ?? body) as Record<string, unknown>;
  return { status: res.statusCode, rest };
};
const NOWHERE = '00000000-0000-4000-8000-000000000000';

beforeAll(async () => {
  app = await createTestApp();
}, 240_000);
afterAll(async () => {
  await app.close();
});

describe('premise', () => {
  it('this deployment is hosted and the not-before date is the activity purge\'s own constant', async () => {
    const f = await newWs('free');
    expect(PURGE_NOT_BEFORE.toISOString()).toBe('2026-12-27T00:00:00.000Z');
    expect((await raw.select().from(records).where(eq(records.id, f.rec))).length).toBe(1);
  });
});

describe('record version list and restore, per plan window (from 2026-12-27)', () => {
  const plans: Array<[Plan, number]> = [['free', 14], ['pro', 270], ['business', 730], ['enterprise', 1825]];

  for (const [plan, days] of plans) {
    it(`${plan}: a version ${days + 1} days old is not listed, one ${days - 1} days old is`, async () => {
      const f = await newWs(plan);
      const old = await seedVersion(f, f.rec, days + 1);
      const young = await seedVersion(f, f.rec, days - 1);
      const res = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/versions`));
      expect(res.statusCode, res.body).toBe(200);
      expect(ids(res), `${plan} window ${days}`).toEqual([young]);
      expect(ids(res)).not.toContain(old);
    });
  }

  it('before 2026-12-27 NOTHING is hidden: the same Free workspace lists the 40-day-old version (the filter has the purge\'s not-before date)', async () => {
    const f = await newWs('free');
    const old = await seedVersion(f, f.rec, 40);
    const young = await seedVersion(f, f.rec, 3);
    const res = await atClock(BEFORE, () => f.as('GET', `${f.base}/${f.rec}/versions`));
    expect(ids(res).sort()).toEqual([old, young].sort());
    const preview = await atClock(BEFORE, () => f.as('GET', `${f.base}/${f.rec}/versions/${old}`));
    expect(preview.statusCode, preview.body).toBe(200);
    const restore = await atClock(BEFORE, () => f.as('POST', `${f.base}/${f.rec}/versions/${old}/restore`));
    expect(restore.statusCode, restore.body).toBe(201);
  });

  it('the boundary is the instant, not the day: one second inside is listed, one second outside is not', async () => {
    const f = await newWs('free');
    const inside = (await raw.insert(recordVersions).values({ workspaceId: f.ws, recordId: f.rec, title: 't', values: {}, createdAt: new Date(AFTER.getTime() - 14 * DAY + 1000) }).returning({ id: recordVersions.id }))[0]!.id;
    const outside = (await raw.insert(recordVersions).values({ workspaceId: f.ws, recordId: f.rec, title: 't', values: {}, createdAt: new Date(AFTER.getTime() - 14 * DAY - 1000) }).returning({ id: recordVersions.id }))[0]!.id;
    const res = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/versions`));
    expect(ids(res)).toEqual([inside]);
    expect(ids(res)).not.toContain(outside);
  });

  it('restoring a version outside the window is a 404 with the SAME body as a version that never existed, and the record is untouched', async () => {
    const f = await newWs('free');
    const old = await seedVersion(f, f.rec, 40);
    const outside = await atClock(AFTER, () => f.as('POST', `${f.base}/${f.rec}/versions/${old}/restore`));
    const never = await atClock(AFTER, () => f.as('POST', `${f.base}/${f.rec}/versions/${NOWHERE}/restore`));
    expect(outside.statusCode, outside.body).toBe(404);
    expect(shape(outside)).toEqual(shape(never));
    const row = (await raw.select().from(records).where(eq(records.id, f.rec)))[0]!;
    expect(row.title, 'the refused restore wrote nothing').toBe('current');
    expect((await raw.select().from(recordVersions).where(eq(recordVersions.recordId, f.rec))).length, 'and captured no snapshot').toBe(1);
  });

  it('the diff preview of a version outside the window is the same 404 too (it would otherwise reveal what the record said)', async () => {
    const f = await newWs('free');
    const old = await seedVersion(f, f.rec, 40);
    const outside = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/versions/${old}`));
    const never = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/versions/${NOWHERE}`));
    expect(outside.statusCode, outside.body).toBe(404);
    expect(shape(outside)).toEqual(shape(never));
  });

  it('a version inside the window still restores (the filter keeps what it must)', async () => {
    const f = await newWs('free');
    const young = await seedVersion(f, f.rec, 3);
    const res = await atClock(AFTER, () => f.as('POST', `${f.base}/${f.rec}/versions/${young}/restore`));
    expect(res.statusCode, res.body).toBe(201);
    expect((await raw.select().from(records).where(eq(records.id, f.rec)))[0]!.title).toBe('older title');
  });

  it('a version of ANOTHER record is not reachable through this one, window or not', async () => {
    const f = await newWs('pro');
    const other = await addRecord(f, 'other');
    const v = await seedVersion(f, other, 3);
    const res = await atClock(AFTER, () => f.as('POST', `${f.base}/${f.rec}/versions/${v}/restore`));
    expect(res.statusCode).toBe(404);
  });

  it('the per-field change timeline (the History dialog\'s other list) obeys the same window', async () => {
    const f = await newWs('free');
    const old = await seedChange(f, f.rec, 40);
    const young = await seedChange(f, f.rec, 3);
    const after = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/versions/changes`));
    expect(after.statusCode, after.body).toBe(200);
    expect(ids(after)).toEqual([young]);
    const before = await atClock(BEFORE, () => f.as('GET', `${f.base}/${f.rec}/versions/changes`));
    expect(ids(before).sort()).toEqual([old, young].sort());
  });
});

describe('document version list and restore, per plan window (from 2026-12-27)', () => {
  it('Free: a document version 40 days old is not listed, one 3 days old is; before the date both are', async () => {
    const f = await newWs('free');
    await writeDoc(f, f.rec);
    const old = await seedDocVersion(f, f.rec, 40);
    const young = await seedDocVersion(f, f.rec, 3);
    const live = (await raw.select().from(documentVersions).where(eq(documentVersions.recordId, f.rec))).map((r) => r.id);
    const after = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/document/versions`));
    expect(after.statusCode, after.body).toBe(200);
    expect(ids(after)).toContain(young);
    expect(ids(after)).not.toContain(old);
    const before = await atClock(BEFORE, () => f.as('GET', `${f.base}/${f.rec}/document/versions`));
    expect(ids(before)).toEqual(expect.arrayContaining([old, young]));
    expect(live.length, 'premise: the real edit captured its own snapshot').toBeGreaterThanOrEqual(3);
  });

  it('Enterprise: 1,800 days is listed, 1,900 is not', async () => {
    const f = await newWs('enterprise');
    await writeDoc(f, f.rec);
    const old = await seedDocVersion(f, f.rec, 1900);
    const young = await seedDocVersion(f, f.rec, 1800);
    const res = await atClock(AFTER, () => f.as('GET', `${f.base}/${f.rec}/document/versions`));
    expect(ids(res)).toContain(young);
    expect(ids(res)).not.toContain(old);
  });

  it('restore and preview of a document version outside the window are the same 404 as one that never existed', async () => {
    const f = await newWs('free');
    await writeDoc(f, f.rec);
    const old = await seedDocVersion(f, f.rec, 40);
    const url = `${f.base}/${f.rec}/document/versions`;
    for (const [method, suffix] of [['POST', '/restore'], ['GET', '']] as const) {
      const outside = await atClock(AFTER, () => f.as(method, `${url}/${old}${suffix}`));
      const never = await atClock(AFTER, () => f.as(method, `${url}/${NOWHERE}${suffix}`));
      expect(outside.statusCode, `${method}: ${outside.body}`).toBe(404);
      expect(shape(outside), method).toEqual(shape(never));
    }
    const doc = await f.as('GET', `${f.base}/${f.rec}/document`);
    expect(JSON.stringify(doc.json().content), 'the document was not rewritten').toContain('second');
  });

  it('a document version inside the window restores', async () => {
    const f = await newWs('free');
    await writeDoc(f, f.rec);
    const young = await seedDocVersion(f, f.rec, 3);
    const res = await atClock(AFTER, () => f.as('POST', `${f.base}/${f.rec}/document/versions/${young}/restore`));
    expect(res.statusCode, res.body).toBeLessThan(300);
  });
});

describe('access: the window never widens what someone may already see (a GUEST and a member without a grant)', () => {
  it('a record-scoped GUEST sees only in-window versions of the granted record, restores only in-window, and gets 404 for the denied sibling', async () => {
    const f = await newWs('pro');
    const denied = await addRecord(f, 'denied');
    const guestUser = await signUpUser(app, 'Window Guest');
    const invite = await f.as('POST', `/workspaces/${f.ws}/invites`, { email: guestUser.email, role: 'guest', grants: [{ record_id: f.rec, role: 'editor' }] });
    expect(invite.statusCode, invite.body).toBe(201);
    await call(app, guestUser.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
    const asGuest = (method: string, url: string) => call(app, guestUser.token, method, url);

    const old = await seedVersion(f, f.rec, 300); // past Pro's 270
    const young = await seedVersion(f, f.rec, 100);
    const deniedYoung = await seedVersion(f, denied, 100);

    const list = await atClock(AFTER, () => asGuest('GET', `${f.base}/${f.rec}/versions`));
    expect(list.statusCode, list.body).toBe(200);
    expect(ids(list)).toEqual([young]);
    const oldRestore = await atClock(AFTER, () => asGuest('POST', `${f.base}/${f.rec}/versions/${old}/restore`));
    expect(oldRestore.statusCode, 'the guest cannot restore past the window').toBe(404);
    const deniedList = await atClock(AFTER, () => asGuest('GET', `${f.base}/${denied}/versions`));
    expect(deniedList.statusCode, 'the denied sibling stays a 404, in or out of the window').toBe(404);
    const deniedRestore = await atClock(AFTER, () => asGuest('POST', `${f.base}/${denied}/versions/${deniedYoung}/restore`));
    expect(deniedRestore.statusCode).toBe(404);
    const okRestore = await atClock(AFTER, () => asGuest('POST', `${f.base}/${f.rec}/versions/${young}/restore`));
    expect(okRestore.statusCode, okRestore.body).toBe(201);
  });

  it('a MEMBER with no grant on a restricted database gets 404 on list, preview, restore and the document versions, in and out of the window', async () => {
    const f = await newWs('pro');
    await setRestricted(app, f.owner.token, f.ws, 'database', f.db);
    const member = await joinAs(app, f.owner.token, f.ws, 'Window Member', 'member');
    const asMember = (method: string, url: string) => call(app, member.token, method, url);
    await writeDoc(f, f.rec);
    const young = await seedVersion(f, f.rec, 100);
    const old = await seedVersion(f, f.rec, 300);
    const docYoung = await seedDocVersion(f, f.rec, 100);
    for (const clock of [BEFORE, AFTER]) {
      for (const v of [young, old]) {
        expect((await atClock(clock, () => asMember('GET', `${f.base}/${f.rec}/versions`))).statusCode).toBe(404);
        expect((await atClock(clock, () => asMember('GET', `${f.base}/${f.rec}/versions/${v}`))).statusCode).toBe(404);
        expect((await atClock(clock, () => asMember('POST', `${f.base}/${f.rec}/versions/${v}/restore`))).statusCode).toBe(404);
      }
      expect((await atClock(clock, () => asMember('GET', `${f.base}/${f.rec}/document/versions`))).statusCode).toBe(404);
      expect((await atClock(clock, () => asMember('POST', `${f.base}/${f.rec}/document/versions/${docYoung}/restore`))).statusCode).toBe(404);
    }
    expect((await raw.select().from(records).where(eq(records.id, f.rec)))[0]!.title, 'nothing was restored').toBe('current');
  });

  it('a member who CAN read gets the same filtered list as the owner (the window is per workspace plan, not per person)', async () => {
    const f = await newWs('free');
    const member = await joinAs(app, f.owner.token, f.ws, 'Window Reader', 'member');
    const old = await seedVersion(f, f.rec, 40);
    const young = await seedVersion(f, f.rec, 3);
    const res = await atClock(AFTER, () => call(app, member.token, 'GET', `${f.base}/${f.rec}/versions`));
    expect(res.statusCode, res.body).toBe(200);
    expect(ids(res)).toEqual([young]);
    expect(ids(res)).not.toContain(old);
  });
});
