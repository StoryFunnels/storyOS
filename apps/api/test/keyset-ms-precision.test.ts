import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';

/**
 * #852 — runs and backlinks page on a CORRECT `(created_at, id)` tuple, unlike the five reads of
 * #851. The open question was whether they still lose rows to a different mechanism: their cursor
 * is built from `row.createdAt.toISOString()`, a MILLISECOND string, against a MICROSECOND column.
 * Resuming strictly after a floored timestamp excludes rows that sit between the floor and the
 * boundary row's true time, i.e. rows that belong on the next page.
 *
 * Reproduced per endpoint, against the real route, with two controls: TIES (which the tuple
 * handles, so these must pass either way) and SUB-MILLISECOND (the hypothesis). Every walk asserts
 * both directions: nothing skipped and nothing repeated.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let db: Db;
let automationId: string;
let targetId: string;

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const BASE = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000).toISOString();
type Mech = 'ties' | 'sub-millisecond';
const at = (mech: Mech, i: number) => sql`${BASE}::timestamptz + ${mech === 'ties' ? 0 : i * 137} * interval '1 microsecond'`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'MsPrecision');
  wsId = (await as('POST', '/workspaces', { name: '852 WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  db = app.get<Db>(DB);
  const a = await db.execute(sql`INSERT INTO automations (database_id, name, trigger, actions)
    VALUES (${dbId}, 'rule', '{"type":"record_created"}'::jsonb, '[]'::jsonb) RETURNING id`);
  automationId = (a.rows[0] as { id: string }).id;
  targetId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Target' } })).json().id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

type Row = { id: string };
async function walk(urlFor: (qs: string) => string, rowsOf: (b: any) => Row[], cursorOf: (b: any) => string | null) {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i += 1) {
    const res = await as('GET', urlFor(`limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
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
  expect(mine.length, `${label}: ${seeded.length - mine.length} of ${seeded.length} never returned`).toBe(seeded.length);
}

describe('#852 — runs (GET /runs)', () => {
  for (const mech of ['ties', 'sub-millisecond'] as Mech[]) {
    it(`${mech}: 7 runs paged at limit 3`, async () => {
      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const r = await db.execute(sql`INSERT INTO automation_runs (workspace_id, automation_id, status, created_at)
          VALUES (${wsId}, ${automationId}, 'ok', ${at(mech, i)}) RETURNING id`);
        ids.push((r.rows[0] as { id: string }).id);
      }
      const seen = await walk((qs) => `/workspaces/${wsId}/runs?${qs}`, (b) => b.data, (b) => b.next_cursor);
      expectComplete(seen, ids, `runs / ${mech}`);
    });
  }
});

describe('#852 — backlinks (GET .../backlinks)', () => {
  for (const mech of ['ties', 'sub-millisecond'] as Mech[]) {
    it(`${mech}: 7 mentions paged at limit 3`, async () => {
      const mentionIds: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const src = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: `src ${mech} ${i}` } })).json().id as string;
        await db.execute(sql`INSERT INTO record_mentions (workspace_id, source_record_id, target_record_id, created_at)
          VALUES (${wsId}, ${src}, ${targetId}, ${at(mech, i)})`);
        mentionIds.push(src); // the endpoint reports the SOURCE record, one row per mention
      }
      const seen = await walk(
        (qs) => `/workspaces/${wsId}/databases/${dbId}/records/${targetId}/backlinks?${qs}`,
        (b) => b.data.map((d: any) => ({ id: d.id })),
        (b) => b.next_cursor,
      );
      expectComplete(seen, mentionIds, `backlinks / ${mech}`);
    });
  }
});

describe('#852 — cursors minted before this change still resume', () => {
  it('runs: the old { createdAt, id } millisecond cursor is accepted, and an unparseable one is ignored as before', async () => {
    const first = (await as('GET', `/workspaces/${wsId}/runs?limit=2`)).json();
    const last = first.data[first.data.length - 1];
    const legacy = Buffer.from(JSON.stringify({ createdAt: new Date(last.started_at).toISOString(), id: last.id })).toString('base64url');
    const res = await as('GET', `/workspaces/${wsId}/runs?limit=50&cursor=${legacy}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((await as('GET', `/workspaces/${wsId}/runs?limit=2&cursor=%25%25`)).statusCode).toBe(200);
  });

  it('backlinks: the old cursor is accepted, and an unparseable one is still a 422 (this endpoint never ignored it)', async () => {
    const url = `/workspaces/${wsId}/databases/${dbId}/records/${targetId}/backlinks`;
    const page = (await as('GET', `${url}?limit=2`)).json();
    expect(page.next_cursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString()) as { t: string; id: string };
    const legacy = Buffer.from(JSON.stringify({ createdAt: new Date(decoded.t).toISOString(), id: decoded.id })).toString('base64url');
    expect((await as('GET', `${url}?limit=50&cursor=${legacy}`)).statusCode).toBe(200);
    expect((await as('GET', `${url}?limit=2&cursor=%25%25`)).statusCode).toBe(422);
  });
});
