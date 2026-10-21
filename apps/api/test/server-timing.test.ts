import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { PG_POOL } from '../src/db/db.module';
import { instrumentPool, measureDb, serverTimingHeader } from '../src/common/server-timing';

/**
 * ticket #1010 (under #998) — `Server-Timing` on the database GET and records/query: database time and statement count, timings only.
 * The counter is what makes the number trustworthy, so it is tested directly (a known number of statements, a transaction, two requests
 * at once), and the header is tested to contain nothing but the two metrics.
 */
let app: NestFastifyApplication;
let pool: Pool;
let token: string;
let ws: string, database: string;
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  pool = app.get(PG_POOL);
  token = (await signUpUser(app, 'Timing')).token;
  ws = (await as('POST', '/workspaces', { name: 'Timing WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  database = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

const HEADER = /^db;dur=\d+(\.\d)?;desc="\d+ statements?", total;dur=\d+(\.\d)?$/;

describe('#1010 the statement counter', () => {
  it('counts every statement, including the ones a transaction runs, and times them', async () => {
    const m = await measureDb(async () => {
      await pool.query('SELECT 1');
      await pool.query('SELECT 2');
      await pool.query('SELECT pg_sleep(0.03)');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 3');
        await client.query('SELECT 4');
        await client.query('COMMIT');
      } finally { client.release(); }
      return 'done';
    });
    expect(m.result).toBe('done');
    expect(m.statements, '3 on the pool + BEGIN, 2 selects, COMMIT on a client').toBe(7);
    expect(m.dbMs, 'the 30 ms sleep is in the database time').toBeGreaterThanOrEqual(25);
  });

  it('two concurrent requests never see each other\'s numbers', async () => {
    const run = (n: number, ms: number) => measureDb(async () => { for (let i = 0; i < n; i++) await pool.query('SELECT pg_sleep($1)', [ms / 1000]); });
    const [a, b] = await Promise.all([run(2, 20), run(5, 5)]);
    expect(a.statements).toBe(2);
    expect(b.statements).toBe(5);
    expect(a.dbMs).toBeGreaterThanOrEqual(35);
    expect(b.dbMs).toBeLessThan(a.dbMs + 25);
  });

  it('counts nothing outside a request (no leak into the next one), and instrumenting twice does not double count', async () => {
    await pool.query('SELECT 1');
    expect((await measureDb(async () => 1)).statements).toBe(0);
    instrumentPool(instrumentPool(pool));
    expect((await measureDb(async () => { await pool.query('SELECT 1'); })).statements).toBe(1);
  });

  it('a failing statement is still counted and the error still reaches the caller', async () => {
    let caught: unknown;
    const m = await measureDb(async () => { await pool.query('SELECT * FROM table_that_does_not_exist').catch((e) => { caught = e; }); });
    expect(m.statements).toBe(1);
    expect(caught).toBeInstanceOf(Error);
  });

  it('the header is the two metrics and nothing else', () => {
    expect(serverTimingHeader({ statements: 11, dbMs: 12.34 }, 18.06)).toBe('db;dur=12.3;desc="11 statements", total;dur=18.1');
    expect(serverTimingHeader({ statements: 1, dbMs: 0 }, 0.04)).toBe('db;dur=0.0;desc="1 statement", total;dur=0.0');
  });
});

describe('#1010 the header on the two calls', () => {
  it('GET database and POST records/query carry Server-Timing with a real statement count, and no other route does', async () => {
    await as('POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name: 'one' } });
    const db = await as('GET', `/workspaces/${ws}/databases/${database}`);
    expect(db.statusCode).toBe(200);
    expect(String(db.headers['server-timing'])).toMatch(HEADER);
    const q = await as('POST', `/workspaces/${ws}/databases/${database}/records/query`, { limit: 100 });
    expect(q.statusCode).toBe(201);
    expect(String(q.headers['server-timing'])).toMatch(HEADER);
    const statements = (h: unknown) => Number(/desc="(\d+) statement/.exec(String(h))![1]);
    expect(statements(db.headers['server-timing'])).toBeGreaterThan(1);
    expect(statements(q.headers['server-timing'])).toBeGreaterThan(1);
    expect((await as('GET', `/workspaces/${ws}/databases`)).headers['server-timing'], 'only the two calls carry it').toBeUndefined();
    expect(db.headers['timing-allow-origin'], 'nothing is exposed cross-origin').toBeUndefined();
  });

  it('it changes nothing else: the body is the same, an error response still carries the header, and it never carries ids or SQL', async () => {
    const res = await as('GET', `/workspaces/${ws}/databases/${database}`);
    expect(res.json().id).toBe(database);
    const header = String(res.headers['server-timing']);
    expect(header).not.toContain(database);
    expect(header).not.toMatch(/select|from|insert/i);
    const missing = await as('GET', `/workspaces/${ws}/databases/00000000-0000-4000-8000-000000000000`);
    expect([403, 404]).toContain(missing.statusCode);
    expect(String(missing.headers['server-timing'])).toMatch(HEADER);
    const stranger = await signUpUser(app, 'Timing Stranger');
    const denied = await call(app, stranger.token, 'GET', `/workspaces/${ws}/databases/${database}`);
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    expect(denied.headers['server-timing'], 'refused by the guard before the handler: no numbers').toBeUndefined();
  });

  it('concurrent requests each report their OWN statement count: the same as when each runs alone', async () => {
    const get = () => as('GET', `/workspaces/${ws}/databases/${database}`);
    const query = () => as('POST', `/workspaces/${ws}/databases/${database}/records/query`, { limit: 5 });
    const n = (r: { headers: Record<string, unknown> }) => Number(/desc="(\d+) statement/.exec(String(r.headers['server-timing']))![1]);
    await get(); await query(); // warm anything cached per process
    const aloneGet = n(await get());
    const aloneQuery = n(await query());
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? get() : query())));
    results.forEach((r, i) => expect(n(r), `request ${i}`).toBe(i % 2 === 0 ? aloneGet : aloneQuery));
  });
});
