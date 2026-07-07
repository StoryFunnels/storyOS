import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let adminUserId: string;
let wsId: string;
let dbId: string;
let opts: Record<string, string>; // option label -> id

const queryUrl = () => `/api/v1/workspaces/${wsId}/databases/${dbId}/records/query`;

async function query(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: queryUrl(),
    headers: authed(admin.token),
    payload,
  });
  return res;
}

async function titles(payload: Record<string, unknown>): Promise<string[]> {
  const res = await query(payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Querier');
  adminUserId = (
    await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(admin.token) })
  ).json().id;

  const ws = await app.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    headers: authed(admin.token),
    payload: { name: 'Query WS' },
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
    payload: { space_id: spaces.json()[0].id, name: 'Tasks' },
  });
  dbId = database.json().id;

  const fieldsUrl = `/api/v1/workspaces/${wsId}/databases/${dbId}/fields`;
  const mk = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: fieldsUrl, headers: authed(admin.token), payload });

  const state = (
    await mk({
      display_name: 'State',
      type: 'select',
      options: [{ label: 'Backlog' }, { label: 'Doing' }, { label: 'Done' }],
    })
  ).json();
  const tags = (
    await mk({ display_name: 'Tags', type: 'multi_select', options: [{ label: 'urgent' }, { label: 'client' }] })
  ).json();
  opts = Object.fromEntries(
    [...state.options, ...tags.options].map((o: { label: string; id: string }) => [o.label, o.id]),
  );
  await mk({ display_name: 'Estimate', type: 'number' });
  await mk({ display_name: 'Due', type: 'date' });
  await mk({ display_name: 'Urgent flag', type: 'checkbox' });
  await mk({ display_name: 'Assignee', type: 'user' });
  await mk({ display_name: 'Brief', type: 'text' });

  const today = new Date().toISOString().slice(0, 10);
  const inFiveDays = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10);

  const recordsPayload = [
    { name: 'Alpha', state: opts['Backlog'], estimate: 1, brief: 'write the spec', urgent_flag: false },
    { name: 'Beta', state: opts['Doing'], estimate: 5, due: today, tags: [opts['urgent']], assignee: 'me-placeholder' },
    { name: 'Gamma', state: opts['Doing'], estimate: 8, due: inFiveDays, tags: [opts['urgent'], opts['client']] },
    { name: 'Delta', state: opts['Done'], estimate: 13, due: lastMonth, urgent_flag: true },
    { name: 'Epsilon' },
  ].map((values) => ({
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, v === 'me-placeholder' ? adminUserId : v]),
    ),
  }));

  const batch = await app.inject({
    method: 'POST',
    url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records/batch`,
    headers: authed(admin.token),
    payload: { records: recordsPayload },
  });
  expect(batch.statusCode, batch.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('records query engine (MN-012)', () => {
  it('select has / has_none', async () => {
    expect(await titles({ filter: { field: 'state', op: 'has', value: [opts['Doing']] } })).toEqual([
      'Beta',
      'Gamma',
    ]);
    expect(
      await titles({ filter: { field: 'state', op: 'has_none', value: [opts['Done'], opts['Doing']] } }),
    ).toEqual(['Alpha', 'Epsilon']);
  });

  it('number comparisons', async () => {
    expect(await titles({ filter: { field: 'estimate', op: 'gt', value: 5 } })).toEqual(['Gamma', 'Delta']);
    expect(await titles({ filter: { field: 'estimate', op: 'lte', value: 5 } })).toEqual(['Alpha', 'Beta']);
    expect(await titles({ filter: { field: 'estimate', op: 'eq', value: 13 } })).toEqual(['Delta']);
  });

  it('text contains with ILIKE escaping', async () => {
    expect(await titles({ filter: { field: 'brief', op: 'contains', value: 'SPEC' } })).toEqual(['Alpha']);
    expect(await titles({ filter: { field: 'brief', op: 'contains', value: '%' } })).toEqual([]);
  });

  it('date before/after/within relative ranges', async () => {
    expect(await titles({ filter: { field: 'due', op: 'within', value: 'next_7_days' } })).toEqual([
      'Beta',
      'Gamma',
    ]);
    const today = new Date().toISOString().slice(0, 10);
    expect(await titles({ filter: { field: 'due', op: 'before', value: today } })).toEqual(['Delta']);
  });

  it('checkbox eq treats missing as false', async () => {
    expect(await titles({ filter: { field: 'urgent_flag', op: 'eq', value: true } })).toEqual(['Delta']);
    const notUrgent = await titles({ filter: { field: 'urgent_flag', op: 'eq', value: false } });
    expect(notUrgent).toContain('Alpha');
    expect(notUrgent).toContain('Epsilon');
  });

  it('multi_select has / is_empty', async () => {
    expect(await titles({ filter: { field: 'tags', op: 'has', value: [opts['client']] } })).toEqual(['Gamma']);
    const noTags = await titles({ filter: { field: 'tags', op: 'is_empty' } });
    expect(noTags.sort()).toEqual(['Alpha', 'Delta', 'Epsilon']);
  });

  it('"me" token resolves for user fields', async () => {
    expect(await titles({ filter: { field: 'assignee', op: 'has', value: ['me'] } })).toEqual(['Beta']);
  });

  it('and/or nesting', async () => {
    const result = await titles({
      filter: {
        or: [
          { field: 'estimate', op: 'gt', value: 10 },
          {
            and: [
              { field: 'state', op: 'has', value: [opts['Doing']] },
              { field: 'tags', op: 'has', value: [opts['client']] },
            ],
          },
        ],
      },
    });
    expect(result.sort()).toEqual(['Delta', 'Gamma']);
  });

  it('multi-key sort with NULLS LAST', async () => {
    const result = await titles({
      sorts: [
        { field: 'due', direction: 'asc' },
        { field: 'estimate', direction: 'desc' },
      ],
    });
    // due asc: Delta(last month), Beta(today), Gamma(+5d), then null-due: Alpha, Epsilon
    expect(result).toEqual(['Delta', 'Beta', 'Gamma', 'Alpha', 'Epsilon']);
  });

  it('keyset cursor pages stably under concurrent inserts', async () => {
    const page1 = await query({ sorts: [{ field: 'estimate', direction: 'desc' }], limit: 2 });
    expect(page1.json().data).toHaveLength(2);

    // Concurrent insert between pages
    await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: authed(admin.token),
      payload: { values: { name: 'Zeta', estimate: 100 } },
    });

    const page2 = await query({
      sorts: [{ field: 'estimate', direction: 'desc' }],
      limit: 10,
      cursor: page1.json().next_cursor,
    });
    const ids1 = page1.json().data.map((r: { id: string }) => r.id);
    const ids2 = page2.json().data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    // Zeta (inserted at top) must NOT appear in page 2 — no duplicates, no shifts.
    expect(page2.json().data.map((r: { title: string }) => r.title)).not.toContain('Zeta');
  });

  it('invalid op-for-type and unknown fields → 422', async () => {
    for (const filter of [
      { field: 'estimate', op: 'contains', value: 'x' },
      { field: 'brief', op: 'gt', value: 1 },
      { field: 'ghost', op: 'eq', value: 1 },
      { field: 'state', op: 'has', value: ['not-an-option'] },
      { field: 'due', op: 'within', value: 'someday' },
    ]) {
      const res = await query({ filter });
      expect(res.statusCode, JSON.stringify(filter)).toBe(422);
    }
  });

  it('is injection-proof: hostile values are parameterized, hostile fields rejected', async () => {
    const hostileValue = await query({
      filter: { field: 'brief', op: 'eq', value: `'; DROP TABLE records; --` },
    });
    expect(hostileValue.statusCode).toBe(201);
    expect(hostileValue.json().data).toEqual([]);

    const hostileField = await query({
      filter: { field: `values->>'x'; DROP TABLE records; --`, op: 'eq', value: 1 },
    });
    expect(hostileField.statusCode).toBe(422);

    // table still alive
    expect((await query({})).statusCode).toBe(201);
  });

  it('q title search combines with filters', async () => {
    const result = await titles({
      q: 'a',
      filter: { field: 'estimate', op: 'gte', value: 5 },
    });
    // Zeta was inserted by the cursor test above (estimate 100, matches q=a)
    expect(result.sort()).toEqual(['Beta', 'Delta', 'Gamma', 'Zeta']);
  });
});
