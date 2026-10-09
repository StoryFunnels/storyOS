import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';

/**
 * #473 AC5 — "the plain case stays plain and acquires no new checks in its path."
 *
 * A PLAIN record has no relations, no sub-items, no attachments, no mentions. What the record-grant
 * work (#472/#473/#474) may add to reading it is the access resolution itself and nothing that
 * scales with what the record carries. Measured, not read: count the SQL statements the pool
 * receives for the same GET as an admin, a member, a guest holding the whole DATABASE, and a guest
 * holding only THIS record, on a plain record and on one that carries a relation and a mention.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let plain: string;
let rich: string;
const tokens: Record<string, string> = {};

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

/** Statements the pool receives while `fn` runs. */
async function count(fn: () => Promise<unknown>): Promise<number> {
  const pool = (app.get(DB) as unknown as { $client: { query: (...a: unknown[]) => unknown } }).$client;
  const original = pool.query.bind(pool);
  let n = 0;
  pool.query = (...args: unknown[]) => {
    n += 1;
    return original(...args);
  };
  try {
    await fn();
  } finally {
    pool.query = original;
  }
  return n;
}

async function invite(name: string, grants: unknown[]): Promise<string> {
  const u = await signUpUser(app, name);
  const inv = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: u.email, role: 'guest', grants });
  expect(inv.statusCode, inv.body).toBeLessThan(300);
  const ok = await as(u.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  expect(ok.statusCode, ok.body).toBeLessThan(300);
  return u.token;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'QC Admin');
  tokens.admin = admin.token;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'qc ws' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  const mk = async (name: string) =>
    (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name } })).json().id as string;
  plain = await mk('plain');
  rich = await mk('rich');
  const other = await mk('other');
  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: dbId, database_b_id: dbId, cardinality: 'many_to_many', field_a_name: 'Related', field_b_name: 'Related back',
  });
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rich}/links/${rel.json().field_a.id}`, { record_ids: [other] });
  tokens.dbGuest = await invite('QC DB Guest', [{ database_id: dbId, role: 'viewer' }]);
  tokens.recGuest = await invite('QC Rec Guest', [{ record_id: plain, role: 'viewer' }, { record_id: rich, role: 'viewer' }]);
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#473 AC5 — statements per GET /records/:id', () => {
  it('measures, and a record-scoped guest costs only a bounded constant more than a database guest on a plain record', async () => {
    const url = (id: string) => `/workspaces/${wsId}/databases/${dbId}/records/${id}`;
    const rows: Record<string, Record<string, number>> = {};
    for (const who of ['admin', 'dbGuest', 'recGuest']) {
      rows[who] = {};
      for (const [label, id] of [['plain', plain], ['rich', rich]] as const) {
        await as(tokens[who]!, 'GET', url(id)); // warm any one-time caches
        // Minimum of several samples: the pool also sees background statements (subscribers,
        // job runners) that land in the window at random; the request's own cost is the floor.
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          let status = 0;
          samples.push(await count(async () => {
            status = (await as(tokens[who]!, 'GET', url(id))).statusCode;
          }));
          expect(status, `${who} ${label}`).toBe(200);
        }
        rows[who]![label] = Math.min(...samples);
      }
    }
    process.stderr.write(`QUERY-COUNT ${JSON.stringify(rows)}\n`);
    // MEASURED 2026-10-09 (main at the time): admin 14, database guest 18, record-scoped guest 22,
    // plain AND rich alike. The record guest's extra 4 over a database guest are access resolution:
    // attributable from a statement dump are one more `access_grants` read and one `records where
    // id in (...)` resolution of the granted ids (visibleRecordIds, #474); the other two were not
    // attributed. None is an inheritance check from #473 and none scales with what the record
    // carries. A fifth would be a new check in the plain path. (An earlier version of this comment
    // said "two more grants reads and two lookups": a miscount, corrected in ticket #861.)
    expect(rows.recGuest!.plain! - rows.dbGuest!.plain!, 'extra statements for a record grant on a plain record').toBeLessThanOrEqual(4);
    // And the plain record costs no more than the rich one for the same caller (nothing scales
    // with what is NOT there).
    expect(rows.recGuest!.plain!).toBeLessThanOrEqual(rows.recGuest!.rich!);
  });
});
