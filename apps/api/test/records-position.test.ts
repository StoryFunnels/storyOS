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
async function readOrder(dbId: string, limit = 200): Promise<string[]> {
  const titles: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const url = `/workspaces/${wsId}/databases/${dbId}/records?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
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

  /**
   * #518 — Vera reproduced infinite-scroll rows rendering in two cleanly-
   * interleaved runs on a 201-record table (e.g. a jumbled 37-46 zipped with a
   * clean ascending 15-35), and #480/#487's own migration comment names the
   * EXACT stress case for a collation regression: mixed-case position keys
   * ("a8 a9 aa aA ab aB ac aC" under the wrong collation vs "a8 a9 aA aB aC aa
   * ab ac" under "C"). The existing tests above only exercise POSITIONS
   * fractional-indexing itself generates (which happen to sort consistently
   * either way in these small examples) — this one forces genuinely
   * case-mixed keys directly and pages through with limit=50 (the API's
   * default and a closer match to a real infinite-scroll page than the
   * limit=200 helper default), across 5 page boundaries for 201 rows.
   *
   * Passing this does not prove #518 is fixed — it proves the SERVER'S
   * cursor pagination is airtight for this exact stress case on current
   * main (which already includes #480/#487's collation fix, confirmed via
   * migration 0082 and this file's own describe title). If it passes and
   * Vera's interleaving still reproduces live, AC #3's own decision rule
   * points the remaining investigation at the CLIENT'S infinite-scroll
   * fetch/merge logic under fast scroll — apps/web, outside this session.
   */
  it('#518 stress case: 201 records with deliberately mixed-case position keys page through with zero duplicates, zero gaps, correct order', async () => {
    const dbId = await newDatabase('Mixed Case Positions 201');
    const titles = Array.from({ length: 201 }, (_, i) => `Row ${String(i).padStart(3, '0')}`);
    // The batch endpoint caps at 100 items per request (same chunking as the
    // "no duplicate positions" test above).
    const rows = [
      ...(await batchCreate(dbId, titles.slice(0, 100))),
      ...(await batchCreate(dbId, titles.slice(100, 200))),
      ...(await batchCreate(dbId, titles.slice(200, 201))),
    ];

    // Overwrite every position with a "C"-collation-ordered but case-mixed
    // key sequence — a0, a1, ..., a9, aA, aB, ..., aZ, aa, ab, ..., az, b0, ...
    // (byte order: digits < uppercase < lowercase in ASCII/"C") so the CORRECT
    // order is still exactly creation order, but a collation bug would
    // scramble it exactly the way the migration comment describes.
    // Most-significant part FIRST (the block counter), fastest-changing part
    // LAST (the alphabet cycle) — ordinary place-value convention, so the
    // string sort order matches creation order i under byte ("C") collation:
    // "a000".."a009" (digits), "a00A".."a00Z" (upper), "a00a".."a00z" (lower),
    // then "a010", etc. A locale-aware collation treats case as a SECONDARY
    // key (near-equal primary weight for 'A'/'a'), which would interleave
    // these blocks — exactly the stress case this test targets.
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    for (const [i, row] of rows.entries()) {
      const key = `a${String(Math.floor(i / alphabet.length)).padStart(2, '0')}${alphabet[i % alphabet.length]}`;
      await db.update(records).set({ position: key }).where(eq(records.id, row.id));
    }

    const paged = await readOrder(dbId, 50);
    expect(paged).toEqual(titles); // exact order, across 5 page boundaries (⌈201/50⌉)
    expect(new Set(paged).size).toBe(201); // no duplicates smuggled across a boundary
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
