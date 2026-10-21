import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_ENTITY_COLORS, defaultEntityColor, hashId } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { databases } from '../src/db/schema';
import { resolveDatabaseColor } from '../src/common/database-color';

/**
 * ticket #1016 — a database that nobody coloured draws a stable colour from its id, the SAME in an API response and in the app, and a
 * database is never defaulted to grey. Stored 'gray' (a random pick, or a caller's) is backfilled once to that colour; grey stays an
 * ordinary choice a person can make afterwards.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string;
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const migration = readFileSync(join(__dirname, '../drizzle/0116_database_default_colors.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Color Owner');
  ws = (await as('POST', '/workspaces', { name: 'Color WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

const mk = async (name: string, color?: string) => (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name, ...(color ? { color } : {}) })).json() as { id: string; color: string };
const stored = async (id: string) => (await raw.select({ color: databases.color }).from(databases).where(eq(databases.id, id)))[0]!.color;

describe('#1016 the shared default colour', () => {
  it('pins the order and the algorithm: the web lane\'s known ids (a change here recolours every workspace)', () => {
    expect([...DEFAULT_ENTITY_COLORS]).toEqual(['gold', 'blue', 'green', 'red', 'purple', 'teal', 'orange', 'brown']);
    expect(hashId('')).toBe(0x811c9dc5);
    expect(defaultEntityColor('80b45166-9b95-41f1-b237-97a6e9ef5ffd')).toBe('teal'); // index 5
    expect(defaultEntityColor('549b4ab9-17ce-46de-bdf7-56eab5c105b5')).toBe('blue'); // index 1
    expect(defaultEntityColor('1392ae95-d35d-40a2-87aa-14005700d7d4')).toBe('gold'); // index 0
  });

  it('the API and the app share ONE function: a NULL colour resolves to defaultEntityColor(id), never grey', () => {
    for (let i = 0; i < 300; i++) {
      const id = randomUUID();
      expect(resolveDatabaseColor(id, null)).toBe(defaultEntityColor(id));
      expect(DEFAULT_ENTITY_COLORS).toContain(resolveDatabaseColor(id, null));
    }
    expect(resolveDatabaseColor(randomUUID(), 'gray'), 'a stored colour always wins, grey included').toBe('gray');
  });

  it('a new database is stored with its id-derived colour (stable, not random, never grey), and an explicit colour still wins', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const d = await mk(`Default ${i}`);
      expect(d.color).toBe(defaultEntityColor(d.id));
      expect(await stored(d.id)).toBe(defaultEntityColor(d.id));
      expect(d.color).not.toBe('gray');
      seen.add(d.color);
    }
    expect(seen.size, 'the colours vary across databases').toBeGreaterThan(2);
    expect((await mk('Chosen red', 'red')).color).toBe('red');
  });

  it('picking grey afterwards stores grey and the API reports grey', async () => {
    const d = await mk('Will be grey');
    expect((await as('PATCH', `/workspaces/${ws}/databases/${d.id}`, { color: 'gray' })).statusCode).toBe(200);
    expect(await stored(d.id)).toBe('gray');
    const detail = (await as('GET', `/workspaces/${ws}/databases/${d.id}`)).json();
    expect(detail.color).toBe('gray');
    expect((await as('GET', `/workspaces/${ws}/databases`)).json().find((x: { id: string }) => x.id === d.id).color).toBe('gray');
  });
});

describe('#1016 the backfill', () => {
  it('SQL = JavaScript: the migration gives every gray database exactly defaultEntityColor(id), counts before/after, and leaves everything else alone', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) {
      const d = await mk(`Gray ${i}`, 'red');
      ids.push(d.id);
    }
    const grays = ids.slice(0, 30);
    const others = ids.slice(30);
    await raw.update(databases).set({ color: 'gray' }).where(inArray(databases.id, grays));
    await raw.update(databases).set({ color: 'teal' }).where(inArray(databases.id, others.slice(0, 5)));
    await raw.update(databases).set({ color: null }).where(inArray(databases.id, others.slice(5)));
    const countGray = async () => Number(((await raw.execute(sql`SELECT count(*)::int AS n FROM databases WHERE color = 'gray'`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
    const before = await countGray();
    expect(before).toBeGreaterThanOrEqual(30);

    await raw.execute(sql.raw(migration));

    const after = await countGray();
    expect(after, `gray databases: ${before} -> ${after}`).toBe(0);
    for (const id of grays) expect(await stored(id), id).toBe(defaultEntityColor(id));
    for (const id of others.slice(0, 5)) expect(await stored(id), 'a chosen colour is untouched').toBe('teal');
    for (const id of others.slice(5)) expect(await stored(id), 'NULL stays NULL (it already resolves to the same colour)').toBeNull();
    // the statement ran in SQL over the ids' characters: a second look at a spread of fresh ids pins the equivalence beyond this batch
    const fresh = Array.from({ length: 200 }, () => randomUUID());
    const rows = (await raw.execute(sql`WITH RECURSIVE walk(id, s, i, h) AS (
        SELECT x, x, 1, 2166136261::bigint FROM unnest(${sql.raw(`ARRAY[${fresh.map((f) => `'${f}'`).join(',')}]::text[]`)}) AS x
        UNION ALL SELECT id, s, i + 1, ((h # ascii(substr(s, i, 1))::bigint) * 16777619) & 4294967295 FROM walk WHERE i <= length(s))
      SELECT id, (ARRAY['gold','blue','green','red','purple','teal','orange','brown'])[(h % 8)::int + 1] AS c FROM walk WHERE i = length(s) + 1`)) as unknown as { rows: Array<{ id: string; c: string }> };
    expect(rows.rows).toHaveLength(200);
    for (const r of rows.rows) expect(r.c, r.id).toBe(defaultEntityColor(r.id));
  });
});
