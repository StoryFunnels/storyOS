import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * MN-012 performance bar: query p50 < 100ms on a 50k-record database.
 * Heavy — runs only with RUN_PERF=1 (locally or in a nightly job).
 */
const enabled = process.env.RUN_PERF === '1';

describe.skipIf(!enabled)('query engine performance (MN-012)', () => {
  let app: NestFastifyApplication;
  let admin: { token: string };
  let wsId: string;
  let dbId: string;
  let fieldId: string;
  const { db, pool } = connectTestDb();

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signUpUser(app, 'Perf');
    const ws = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      headers: authed(admin.token),
      payload: { name: 'Perf WS' },
    });
    wsId = ws.json().id;
    const spaces = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/spaces`,
      headers: authed(admin.token),
    });
    const database = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases`,
      headers: authed(admin.token),
      payload: { space_id: spaces.json()[0].id, name: 'Perf' },
    });
    dbId = database.json().id;
    const field = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`,
      headers: authed(admin.token),
      payload: { display_name: 'Estimate', type: 'number' },
    });
    fieldId = field.json().id;

    await db.execute(sql`
      INSERT INTO records (database_id, title, values, position)
      SELECT ${dbId}::uuid,
             'perf task ' || i,
             jsonb_build_object(${fieldId}::text, (random() * 1000)::int),
             'a' || lpad(i::text, 10, '0')
      FROM generate_series(1, 50000) AS i
    `);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  it('filter + sort query p50 < 100ms over 50k records', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/query`,
        headers: authed(admin.token),
        payload: {
          filter: { field: 'estimate', op: 'gt', value: 500 },
          sorts: [{ field: 'estimate', direction: 'desc' }],
          limit: 50,
        },
      });
      durations.push(performance.now() - start);
      expect(res.statusCode).toBe(201);
      expect(res.json().data.length).toBeGreaterThan(0);
    }
    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length / 2)]!;
    // eslint-disable-next-line no-console
    console.log(`perf: p50=${p50.toFixed(1)}ms p95=${durations[18]!.toFixed(1)}ms`);
    expect(p50).toBeLessThan(100);
  });
});
