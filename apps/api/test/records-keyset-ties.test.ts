import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #849 AC4 — the audit question: do the records endpoints skip records the way the activity
 * cursor skipped events? Their cursor is a TUPLE of every sort key plus the record id
 * (`cursorCondition`), so a page boundary inside a run of equal sort values resumes at the right
 * row. This file is the measurement behind that claim, not a restatement of it: 60 records are
 * created in one batch (so created_at / updated_at / every default tie), sorted on columns that
 * are DELIBERATELY almost all equal or null, and paged at awkward sizes. The invariant is the
 * same in every case: every record exactly once, same order as one big page.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let wsId: string;
let dbId: string;
let selectApi: string;
let numberApi: string;
const TOTAL = 60;

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(owner.token), payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'KeysetTies');
  wsId = (await inject('POST', '/workspaces', { name: 'keyset ties' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Ties' })).json().id;
  const sel = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Stage', type: 'select', options: [{ label: 'A' }, { label: 'B' }],
  });
  selectApi = sel.json().apiName;
  const optA = sel.json().options.find((o: { label: string }) => o.label === 'A').id;
  const optB = sel.json().options.find((o: { label: string }) => o.label === 'B').id;
  numberApi = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Score', type: 'number' })).json().apiName;

  const records = Array.from({ length: TOTAL }, (_, i) => ({
    values: {
      name: i % 2 === 0 ? 'Same title' : 'Same title', // every title identical
      // 3 buckets: A, B and NULL (unset), with ~20 records each: huge runs of ties.
      ...(i % 3 === 0 ? { [selectApi]: optA } : i % 3 === 1 ? { [selectApi]: optB } : {}),
      // only TWO distinct numbers, plus null for every 5th.
      ...(i % 5 === 0 ? {} : { [numberApi]: i % 2 }),
    },
  }));
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, { records });
  expect(res.statusCode, res.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await app.close();
});

type Page = { data: Array<{ id: string }>; next_cursor: string | null; has_more: boolean };

async function walkQuery(body: Record<string, unknown>, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i += 1) {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { ...body, limit, ...(cursor ? { cursor } : {}) });
    expect(res.statusCode, res.body).toBeLessThan(300); // POST /query answers 201
    const page = res.json() as Page;
    out.push(...page.data.map((r) => r.id));
    if (!page.has_more) return out;
    expect(page.next_cursor).not.toBeNull();
    cursor = page.next_cursor!;
  }
  throw new Error('did not terminate');
}

async function walkList(limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i += 1) {
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as Page;
    out.push(...page.data.map((r) => r.id));
    if (!page.has_more) return out;
    cursor = page.next_cursor!;
  }
  throw new Error('did not terminate');
}

function expectComplete(paged: string[], whole: string[], label: string) {
  expect(new Set(paged).size, `${label}: no record twice`).toBe(paged.length);
  expect(paged.length, `${label}: no record skipped`).toBe(TOTAL);
  expect(paged, `${label}: same order as one big page`).toEqual(whole);
}

describe('#849 AC4 — records pagination over tie-heavy sorts skips nothing and repeats nothing', () => {
  const cases: Array<[string, () => Record<string, unknown>]> = [
    ['single select, asc (nulls last)', () => ({ sorts: [{ field: selectApi, direction: 'asc' }] })],
    ['single select, desc', () => ({ sorts: [{ field: selectApi, direction: 'desc' }] })],
    ['single select, asc, nulls FIRST', () => ({ sorts: [{ field: selectApi, direction: 'asc' }], nulls: 'first' })],
    ['two-valued number, desc', () => ({ sorts: [{ field: numberApi, direction: 'desc' }] })],
    ['multi-key: select desc, number asc', () => ({ sorts: [{ field: selectApi, direction: 'desc' }, { field: numberApi, direction: 'asc' }] })],
    ['title (every title identical)', () => ({ sorts: [{ field: 'name', direction: 'asc' }] })],
    ['no explicit sort', () => ({})],
  ];
  for (const [label, body] of cases) {
    it(`query: ${label}`, async () => {
      const whole = await walkQuery(body(), 200);
      expect(whole).toHaveLength(TOTAL);
      for (const limit of [1, 7, 13, 59]) expectComplete(await walkQuery(body(), limit), whole, `${label} @ ${limit}`);
    });
  }

  it('the plain GET list endpoint (default order) likewise', async () => {
    const whole = await walkList(200);
    expect(whole).toHaveLength(TOTAL);
    for (const limit of [1, 7, 13, 59]) expectComplete(await walkList(limit), whole, `list @ ${limit}`);
  });
});
