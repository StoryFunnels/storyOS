import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';

/**
 * #851 — the five reads that paged on `created_at < cursor` alone: the admin audit log, the
 * notifications list, the portal access log, document version history and record version
 * history. Each is REPRODUCED INDIVIDUALLY here, against the real endpoint, because the same
 * cursor shape was correct elsewhere (the records query endpoint, which tuple-breaks on id) and a
 * code read is not a verdict.
 *
 * Two mechanisms, both seeded straight into the table so the rows are exactly what the endpoint
 * must cope with, whichever write path produced them:
 *   TIES — rows sharing one created_at (everything one transaction writes does). A page boundary
 *          inside the group made the next query skip the rest of it.
 *   SUB-MILLISECOND — rows a few hundred microseconds apart. Postgres stores microseconds, a JS
 *          Date milliseconds, so a cursor built from `toISOString()` sits before rows of the same
 *          millisecond that belong on the next page.
 *
 * Every walk asserts BOTH directions: every seeded row comes back (nothing skipped) and none
 * comes back twice (`<=` would trade omission for duplication), in newest-first order.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let dbId: string;
let recordId: string;
let db: Db;
let recipientId: string;

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const recordUrl = () => `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`;

/** A millisecond-aligned instant an hour ago: inside the audit log's default window, clear of setup noise. */
const BASE = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000).toISOString();
type Mech = 'ties' | 'sub-millisecond';
/** SQL for row i's created_at: identical for ties, 137µs apart otherwise (a prime step, so a page
 *  boundary never happens to land exactly on a millisecond and hide the truncation bug). */
const at = (mech: Mech, i: number, offsetMicros = 0) =>
  sql`${BASE}::timestamptz + ${mech === 'ties' ? 0 : i * 137 + offsetMicros} * interval '1 microsecond'`;

async function seed(rows: Array<{ id?: string }>, insert: (i: number) => ReturnType<typeof sql>): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const res = await db.execute(insert(i));
    ids.push((res.rows[0] as { id: string }).id);
  }
  return ids;
}
const slots = (n: number) => Array.from({ length: n }, () => ({}));

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SiblingsOwner');
  adminId = (await as('GET', '/me')).json().id;
  wsId = (await as('POST', '/workspaces', { name: '851 WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  recordId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'R' } })).json().id;
  db = app.get<Db>(DB);
  const rec = await db.execute(sql`INSERT INTO portal_recipients (workspace_id, label) VALUES (${wsId}, 'Acme') RETURNING id`);
  recipientId = (rec.rows[0] as { id: string }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

type Row = { id: string; created_at: string };

/** Walk an endpoint with `limit` until it says it is done; returns every row seen. */
async function walk(urlFor: (qs: string) => string, limit: number | null, rowsOf: (body: any) => Row[], cursorOf: (body: any) => string | null) {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i += 1) {
    const qs: string = `${limit ? `limit=${limit}&` : ''}${cursor ? `cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await as('GET', urlFor(qs));
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    out.push(...rowsOf(body));
    cursor = cursorOf(body);
    if (!cursor) return out;
  }
  throw new Error('did not terminate');
}

function expectComplete(seen: Row[], seeded: string[], label: string) {
  const mine = seen.filter((r) => seeded.includes(r.id));
  expect(new Set(mine.map((r) => r.id)).size, `${label}: no row twice`).toBe(mine.length);
  expect(mine.length, `${label}: ${seeded.length - mine.length} of ${seeded.length} rows never returned`).toBe(seeded.length);
  const times = mine.map((r) => Date.parse(r.created_at));
  expect(times, `${label}: newest first`).toEqual([...times].sort((a, b) => b - a));
}

const MECHS: Mech[] = ['ties', 'sub-millisecond'];

describe('#851 (1/5) admin audit log — merges activity_events and record_field_changes', () => {
  for (const mech of MECHS) {
    it(`${mech}: 7 events + 7 field changes, paged at limit 3, are all returned once`, async () => {
      const events = await seed(slots(7), (i) => sql`INSERT INTO activity_events (workspace_id, record_id, type, payload, created_at)
        VALUES (${wsId}, ${recordId}, 'audit.probe', '{}'::jsonb, ${at(mech, i)}) RETURNING id`);
      const changes = await seed(slots(7), (i) => sql`INSERT INTO record_field_changes (workspace_id, database_id, record_id, created_at)
        VALUES (${wsId}, ${dbId}, ${recordId}, ${at(mech, i, 50)}) RETURNING id`);
      const seen = await walk((qs) => `/workspaces/${wsId}/audit-log?${qs}`, 3, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, [...events, ...changes], `audit log / ${mech}`);
    });
  }
});

describe('#851 (2/5) portal access log', () => {
  for (const mech of MECHS) {
    it(`${mech}: 7 entries, paged at limit 3, are all returned once`, async () => {
      const ids = await seed(slots(7), (i) => sql`INSERT INTO portal_access_log (workspace_id, recipient_id, view_id, outcome, created_at)
        VALUES (${wsId}, ${recipientId}, gen_random_uuid(), 'served', ${at(mech, i)}) RETURNING id`);
      const seen = await walk((qs) => `/workspaces/${wsId}/portal-activity?${qs}`, 3, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, ids, `portal log / ${mech}`);
    });
  }
});

describe('#851 (3/5) notifications list (fixed page size of 30)', () => {
  for (const mech of MECHS) {
    it(`${mech}: 70 notifications for one user are all returned once`, async () => {
      const ids = await seed(slots(70), (i) => sql`INSERT INTO notifications (user_id, workspace_id, type, created_at)
        VALUES (${adminId}, ${wsId}, 'mention', ${at(mech, i)}) RETURNING id`);
      const seen = await walk((qs) => `/workspaces/${wsId}/notifications?${qs}`, null, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, ids, `notifications / ${mech}`);
    });
  }
});

describe('#851 (4/5) document version history', () => {
  for (const mech of MECHS) {
    it(`${mech}: 7 versions, paged at limit 3, are all returned once`, async () => {
      const ids = await seed(slots(7), (i) => sql`INSERT INTO document_versions (workspace_id, record_id, version, created_at)
        VALUES (${wsId}, ${recordId}, ${i + 1000 + (mech === 'ties' ? 0 : 100)}, ${at(mech, i)}) RETURNING id`);
      const seen = await walk((qs) => `${recordUrl()}/document/versions?${qs}`, 3, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, ids, `document versions / ${mech}`);
    });
  }
});

describe('#851 (5/5) record version history', () => {
  for (const mech of MECHS) {
    it(`${mech}: 7 versions, paged at limit 3, are all returned once`, async () => {
      const ids = await seed(slots(7), (i) => sql`INSERT INTO record_versions (workspace_id, record_id, title, created_at)
        VALUES (${wsId}, ${recordId}, ${'v' + i}, ${at(mech, i)}) RETURNING id`);
      const seen = await walk((qs) => `${recordUrl()}/versions?${qs}`, 3, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, ids, `record versions / ${mech}`);
    });
  }
});

describe('#851 — cursors minted before this change still resume (a client paging across a deploy is not sent back to page one)', () => {
  it('audit log: a bare base64 timestamp is accepted', async () => {
    const first = (await as('GET', `/workspaces/${wsId}/audit-log?limit=2`)).json();
    const legacy = Buffer.from(new Date(first.data[0].created_at).toISOString()).toString('base64url');
    const res = await as('GET', `/workspaces/${wsId}/audit-log?limit=50&cursor=${legacy}`);
    expect(res.statusCode, res.body).toBe(200);
    for (const row of res.json().data) expect(Date.parse(row.created_at)).toBeLessThan(Date.parse(first.data[0].created_at));
  });

  it('notifications: a RAW ISO cursor (what this endpoint used to hand out) is accepted', async () => {
    const page = (await as('GET', `/workspaces/${wsId}/notifications`)).json();
    expect(page.data.length).toBe(30);
    const rawIso = page.data[page.data.length - 1].created_at as string;
    const res = await as('GET', `/workspaces/${wsId}/notifications?cursor=${encodeURIComponent(rawIso)}`);
    expect(res.statusCode, res.body).toBe(200);
    // Resumed OLDER than the legacy cursor, not restarted at page one.
    for (const row of res.json().data) expect(Date.parse(row.created_at)).toBeLessThanOrEqual(Date.parse(rawIso));
  });

  it('an unparseable cursor is ignored on every one of the five, as before (page one, never a 500)', async () => {
    for (const url of [
      `/workspaces/${wsId}/audit-log?limit=2&cursor=%25%25`,
      `/workspaces/${wsId}/portal-activity?limit=2&cursor=%25%25`,
      `/workspaces/${wsId}/notifications?cursor=%25%25`,
      `${recordUrl()}/document/versions?limit=2&cursor=%25%25`,
      `${recordUrl()}/versions?limit=2&cursor=%25%25`,
    ]) {
      const res = await as('GET', url);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
  });
});
