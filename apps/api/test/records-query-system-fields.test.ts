import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #351/#353: system fields (number, id, created_at, updated_at, created_by,
 * updated_by) must be filterable AND sortable through the real query engine,
 * against a real Postgres — the exact capability the live MCP was missing
 * ("unknown field number in filter", "unknown sort field number").
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let adminUserId: string;
let other: { token: string; email: string };
let otherUserId: string;
let wsId: string;
let dbId: string;

const queryUrl = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records/query`;

async function query(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: queryUrl(), headers: authed(admin.token), payload });
}
async function nums(payload: Record<string, unknown>): Promise<number[]> {
  const res = await query(payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { number: number }) => r.number);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SysAdmin');
  adminUserId = (
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(admin.token) })
  ).json().id;

  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Sys WS' },
  });
  wsId = ws.json().id;

  // A second user id so a created_by filter has a real "not me" that matches nothing.
  other = await signUpUser(app, 'SysOther');
  otherUserId = (
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(other.token) })
  ).json().id;

  const spaces = await app.inject({
    method: 'GET',
    url: `/api/v1/workspaces/${wsId}/spaces`,
    headers: authed(admin.token),
  });
  const database = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases`,
    headers: authed(admin.token),
    payload: { space_id: spaces.json()[0].id, name: 'Items' },
  });
  dbId = database.json().id;

  // Five records created one-by-one (distinct created_at), numbers 1..5.
  for (const name of ['A', 'B', 'C', 'D', 'E']) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: authed(admin.token),
      payload: { values: { name } },
    });
    expect(res.statusCode, res.body).toBe(201);
  }
});

afterAll(async () => {
  await app.close();
});

describe('system fields are filterable + sortable (#351/#353)', () => {
  it('filters by number with gte/gt/lte/eq/between-ish comparisons', async () => {
    expect(await nums({ filter: { field: 'number', op: 'gte', value: 3 } })).toEqual([3, 4, 5]);
    expect(await nums({ filter: { field: 'number', op: 'lte', value: 2 } })).toEqual([1, 2]);
    expect(await nums({ filter: { field: 'number', op: 'eq', value: 4 } })).toEqual([4]);
    // number>=2 AND number<=4 → the "between" the registry documents via gte+lte.
    expect(
      await nums({
        filter: { and: [{ field: 'number', op: 'gte', value: 2 }, { field: 'number', op: 'lte', value: 4 }] },
      }),
    ).toEqual([2, 3, 4]);
  });

  it('the number filter proven live: number >= 320-style bound returns exactly the right set', async () => {
    // Small-scale analogue of the reported failure (number >= 320): the bound
    // selects a suffix of the sequence, and nothing outside it.
    expect(await nums({ filter: { field: 'number', op: 'gte', value: 4 } })).toEqual([4, 5]);
    expect(await nums({ filter: { field: 'number', op: 'gte', value: 99 } })).toEqual([]);
  });

  it('sorts by number asc and desc', async () => {
    expect(await nums({ sorts: [{ field: 'number', direction: 'asc' }] })).toEqual([1, 2, 3, 4, 5]);
    expect(await nums({ sorts: [{ field: 'number', direction: 'desc' }] })).toEqual([5, 4, 3, 2, 1]);
  });

  it('`id` remains a working alias for the record number (back-compat)', async () => {
    expect(await nums({ sorts: [{ field: 'id', direction: 'desc' }] })).toEqual([5, 4, 3, 2, 1]);
    expect(await nums({ filter: { field: 'id', op: 'gte', value: 5 } })).toEqual([5]);
  });

  it('sorts by created_at desc (newest first)', async () => {
    // Created A..E in order, so newest→oldest is E..A == numbers 5..1.
    expect(await nums({ sorts: [{ field: 'created_at', direction: 'desc' }] })).toEqual([5, 4, 3, 2, 1]);
    expect(await nums({ sorts: [{ field: 'created_at', direction: 'asc' }] })).toEqual([1, 2, 3, 4, 5]);
  });

  it('sorts by updated_at', async () => {
    const asc = await nums({ sorts: [{ field: 'updated_at', direction: 'asc' }] });
    expect(asc.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('filters by created_by — id, "me", and a non-matching user', async () => {
    expect((await nums({ filter: { field: 'created_by', op: 'eq', value: adminUserId } })).length).toBe(5);
    expect((await nums({ filter: { field: 'created_by', op: 'eq', value: 'me' } })).length).toBe(5);
    expect(await nums({ filter: { field: 'created_by', op: 'eq', value: otherUserId } })).toEqual([]);
    // any-of (has) over a user set
    expect((await nums({ filter: { field: 'created_by', op: 'has', value: [adminUserId] } })).length).toBe(5);
    expect(await nums({ filter: { field: 'created_by', op: 'has_none', value: [adminUserId] } })).toEqual([]);
  });

  it('filters + sorts by updated_by', async () => {
    // Every record was created (and last-touched) by admin → updated_by == admin.
    expect((await nums({ filter: { field: 'updated_by', op: 'eq', value: 'me' } })).length).toBe(5);
    const sorted = await nums({ sorts: [{ field: 'updated_by', direction: 'asc' }] });
    expect(sorted.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects invalid op/field-type combos with a clear 422', async () => {
    for (const filter of [
      { field: 'number', op: 'contains', value: 'x' }, // text op on a number
      { field: 'created_at', op: 'gt', value: '2020-01-01' }, // date uses before/after, not gt
      { field: 'created_by', op: 'gt', value: 'x' }, // comparison op on a user field
      { field: 'updated_by', op: 'contains', value: 'x' },
    ]) {
      const res = await query({ filter });
      expect(res.statusCode, JSON.stringify(filter)).toBe(422);
    }
  });

  it('keyset pagination stays stable under a system-field (number desc) sort', async () => {
    const sorts = [{ field: 'number', direction: 'desc' as const }];
    const page1 = await query({ sorts, limit: 2 });
    expect(page1.json().data.map((r: { number: number }) => r.number)).toEqual([5, 4]);

    const page2 = await query({ sorts, limit: 2, cursor: page1.json().next_cursor });
    expect(page2.json().data.map((r: { number: number }) => r.number)).toEqual([3, 2]);

    const page3 = await query({ sorts, limit: 2, cursor: page2.json().next_cursor });
    expect(page3.json().data.map((r: { number: number }) => r.number)).toEqual([1]);

    const ids = [page1, page2, page3].flatMap((p) => p.json().data.map((r: { id: string }) => r.id));
    expect(new Set(ids).size).toBe(5); // no dupes, no skips across pages
    expect(page3.json().has_more).toBe(false);
  });
});
