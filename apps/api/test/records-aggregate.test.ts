import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #404 — counting must not be done by fetching.
 *
 * On production, "how many contacts do we have?" failed with
 * `136922 tokens (130334 in the messages)` against a 128,000-token window,
 * because answering it dragged a whole database through the model.
 *
 * The subtler half is what happens when the fetch DOES fit: `query_records` is
 * paginated at 200, so a model counting its results reports the size of one PAGE
 * as the total. That is a confidently wrong number — #401's failure arriving by
 * a different route — and it is the reason this file builds a database LARGER
 * than a page.
 *
 * The founder's Companies-v1 is 148 x 22. This fixture is 210 rows so it exceeds
 * the 200 page cap; the shape of the bug does not depend on the exact figure,
 * but the page boundary does.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

const ROWS = 210;
const OPEN_ROWS = 37;

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

const agg = async (body: unknown) => {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/aggregate`, body);
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Aggregate Admin');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Big Co' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Status', type: 'text' });
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Deal Size', type: 'number' });

  // Batched in chunks of 100 — the create cap.
  for (let start = 0; start < ROWS; start += 100) {
    const records = [];
    for (let i = start; i < Math.min(start + 100, ROWS); i++) {
      records.push({
        values: { name: `Company ${i}`, status: i < OPEN_ROWS ? 'open' : 'closed', deal_size: String(i + 1) },
      });
    }
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, { records });
    expect(res.statusCode, res.body).toBeLessThan(300);
  }
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#404 server-side aggregate', () => {
  it('returns the TRUE total, not a page-one count', async () => {
    const page = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { limit: 200 });
    const pageSize = page.json().data.length;
    // The premise: one page genuinely cannot see the whole set.
    expect(pageSize).toBeLessThan(ROWS);

    const { status, body } = await agg({ op: 'count' });
    expect(status).toBe(200);
    expect(body.value).toBe(ROWS);
    // The number a model would have reported by counting rows it fetched.
    expect(body.value).not.toBe(pageSize);
  });

  it('counts through a filter, meaning the same thing a filtered query means', async () => {
    const filter = { field: 'status', op: 'eq', value: 'open' };
    const { body } = await agg({ op: 'count', filter });
    expect(body.value).toBe(OPEN_ROWS);
    expect(body.filtered).toBe(true);

    // Same predicate through the query path — if these ever disagree, the count
    // becomes another number nobody can trust.
    const q = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/query`, { filter, limit: 200 });
    expect(q.json().data.length).toBe(OPEN_ROWS);
  });

  it('sums and averages a numeric field in SQL', async () => {
    const sum = await agg({ op: 'sum', field: 'deal_size' });
    expect(sum.body.value).toBe((ROWS * (ROWS + 1)) / 2);
    const avg = await agg({ op: 'avg', field: 'deal_size' });
    expect(avg.body.value).toBeCloseTo((ROWS + 1) / 2, 5);
    const min = await agg({ op: 'min', field: 'deal_size' });
    const max = await agg({ op: 'max', field: 'deal_size' });
    expect([min.body.value, max.body.value]).toEqual([1, ROWS]);
  });

  it('reports unfiltered as unfiltered', async () => {
    // A filtered count and a total are different claims, and the caller has to
    // be able to tell which one it got.
    expect((await agg({ op: 'count' })).body.filtered).toBe(false);
  });

  it('refuses an aggregate with no field rather than inventing one', async () => {
    const { status, body } = await agg({ op: 'sum' });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('needs a field');
  });

  it('refuses an unknown field', async () => {
    const { status, body } = await agg({ op: 'sum', field: 'not_a_field' });
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('unknown field');
  });

  it('skips non-numeric values instead of counting them as zero', async () => {
    // A zero would drag the average down and report a total that is quietly
    // wrong — the exact class of defect this ticket is about.
    const avg = await agg({ op: 'avg', field: 'status' });
    expect(avg.status).toBe(200);
    expect(avg.body.value).toBeNull();
  });

  it('an empty result is 0 for count and null for the rest', async () => {
    const filter = { field: 'status', op: 'eq', value: 'nothing-matches-this' };
    expect((await agg({ op: 'count', filter })).body.value).toBe(0);
    // null, not 0: "no rows" and "they add up to nothing" are different answers.
    expect((await agg({ op: 'sum', field: 'deal_size', filter })).body.value).toBeNull();
  });
});
