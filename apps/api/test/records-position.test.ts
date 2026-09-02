import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import { records } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { RecordsService } from '../src/records/records.service';

/**
 * #480/#487 — records.position is a fractional-indexing key (ADR-0005),
 * generated assuming plain byte-order comparison. Left at the database's
 * default collation, ORDER BY disagreed with that order (#480: rows read back
 * interleaved) and `lastPosition()` anchored new keys off the wrong "maximum"
 * (#487: a multi-chunk bulk create wrote outright duplicate keys). Migration
 * 0082 collates the column "C" (byte order) to fix both at the source; this
 * file reproduces both bugs against the real API first, then proves the fix
 * and the repair for data already written before the fix existed.
 */
let app: NestFastifyApplication;
let db: Db;
let recordsService: RecordsService;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function newDatabase(name: string): Promise<string> {
  return (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name })).json().id;
}

async function batchCreate(dbId: string, titles: string[]) {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
    records: titles.map((name) => ({ values: { name } })),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data as Array<{ id: string; title: string }>;
}

/** Pages through the whole database (the list endpoint caps `limit` at 200). */
async function readOrder(dbId: string): Promise<string[]> {
  const titles: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = `/workspaces/${wsId}/databases/${dbId}/records?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await inject('GET', url);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { data: Array<{ title: string }>; next_cursor: string | null; has_more: boolean };
    titles.push(...body.data.map((r) => r.title));
    if (!body.has_more || !body.next_cursor) break;
    cursor = body.next_cursor;
  }
  return titles;
}

async function positionsOf(dbId: string): Promise<Array<{ id: string; position: string }>> {
  return db.query.records.findMany({ where: eq(records.databaseId, dbId), columns: { id: true, position: true } });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  recordsService = app.get(RecordsService);
  admin = await signUpUser(app, 'PositionTester');
  wsId = (await inject('POST', '/workspaces', { name: 'Position WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
});

afterAll(async () => {
  await app.close();
});

describe('#480/#487 records.position collation', () => {
  it('a large single batch reads back in exactly the order the keys were generated', async () => {
    const dbId = await newDatabase('Order 40');
    const titles = Array.from({ length: 40 }, (_, i) => `row-${String(i).padStart(3, '0')}`);
    await batchCreate(dbId, titles);
    expect(await readOrder(dbId)).toEqual(titles);
  });

  it('a multi-chunk bulk create (100 + 100 + 1) produces no duplicate positions across the chunk boundary', async () => {
    const dbId = await newDatabase('No Duplicates 201');
    const titles = Array.from({ length: 201 }, (_, i) => `Row ${String(i).padStart(3, '0')}`);
    await batchCreate(dbId, titles.slice(0, 100));
    await batchCreate(dbId, titles.slice(100, 200));
    await batchCreate(dbId, titles.slice(200, 201));

    const rows = await positionsOf(dbId);
    const distinct = new Set(rows.map((r) => r.position));
    expect(rows.length).toBe(201);
    expect(distinct.size, 'every position must be distinct — Vera measured 199/201 before the fix').toBe(201);

    // And the read-back order matches creation order end to end, across both
    // chunk boundaries — the #480 symptom, on exactly the #487 reproduction.
    expect(await readOrder(dbId)).toEqual(titles);
  });

  it('single-record creation still places a new record last (same lastPosition anchor, not covered by a batch test)', async () => {
    const dbId = await newDatabase('Single Create Last');
    await batchCreate(dbId, ['A', 'B', 'C']);
    const created = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'D' } });
    expect(created.statusCode, created.body).toBe(201);
    expect(await readOrder(dbId)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('MUST KEEP WORKING: drag-to-reorder places a row between two others and it survives a reload', async () => {
    const dbId = await newDatabase('Drag Reorder');
    const rows = await batchCreate(dbId, ['A', 'B', 'C']);
    const moved = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${rows[2]!.id}/move`, {
      after_record_id: rows[0]!.id,
    });
    expect(moved.statusCode, moved.body).toBeLessThan(300);
    expect(await readOrder(dbId)).toEqual(['A', 'C', 'B']);
  });

  describe('repairDuplicatePositions (#487 — data already written before the fix)', () => {
    it('re-keys every row past the first in a tied group, keeping the earliest-created row\'s key', async () => {
      const dbId = await newDatabase('Repair Ties');
      // A clean run first, then artificially collapse three DISTINCT rows onto
      // one shared position — exactly the historical shape this repairs:
      // stored keys that are not wrong in themselves, only duplicated.
      const rows = await batchCreate(dbId, ['First', 'Second', 'Third', 'Fourth']);
      const [first, second, third] = rows;
      const sharedPosition = (await positionsOf(dbId)).find((r) => r.id === first!.id)!.position;
      await db.update(records).set({ position: sharedPosition }).where(eq(records.id, second!.id));
      await db.update(records).set({ position: sharedPosition }).where(eq(records.id, third!.id));

      const beforeRepair = await positionsOf(dbId);
      expect(new Set(beforeRepair.map((r) => r.position)).size, 'three rows now share one position').toBe(2);

      const repaired = await recordsService.repairDuplicatePositions(dbId);
      expect(repaired).toBe(2); // second and third re-keyed; first (earliest) untouched

      const afterRepair = await positionsOf(dbId);
      expect(new Set(afterRepair.map((r) => r.position)).size, 'every position distinct after repair').toBe(4);
      const firstAfter = afterRepair.find((r) => r.id === first!.id)!;
      expect(firstAfter.position, 'the lowest-numbered row of the tie keeps its original key').toBe(sharedPosition);

      // The repair preserves reading order for the group: First, then Second,
      // then Third (number order — the only honest proxy a tie ever had,
      // since every row in one batch shares the same createdAt), then Fourth,
      // exactly as before the collision was introduced.
      expect(await readOrder(dbId)).toEqual(['First', 'Second', 'Third', 'Fourth']);
    });

    it('is idempotent — a second run on already-distinct positions repairs nothing', async () => {
      const dbId = await newDatabase('Repair Idempotent');
      await batchCreate(dbId, ['A', 'B', 'C']);
      expect(await recordsService.repairDuplicatePositions(dbId)).toBe(0);
    });

    it('MUST KEEP WORKING: drag-to-reorder onto repaired data still finds a gap to generate into', async () => {
      const dbId = await newDatabase('Repair Then Drag');
      const rows = await batchCreate(dbId, ['One', 'Two', 'Three']);
      const shared = (await positionsOf(dbId)).find((r) => r.id === rows[0]!.id)!.position;
      await db.update(records).set({ position: shared }).where(eq(records.id, rows[1]!.id));
      await recordsService.repairDuplicatePositions(dbId);

      const moved = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${rows[2]!.id}/move`, {
        after_record_id: rows[0]!.id,
      });
      expect(moved.statusCode, moved.body).toBeLessThan(300);
      expect(await readOrder(dbId)).toEqual(['One', 'Three', 'Two']);
    });
  });
});
