import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-260: sorting by a formula field. #252 spiked this and found sorting by a
 * computed field architecturally unsupported — SORTABLE excluded formula/rollup,
 * fieldExpr() read raw stored JSONB (nothing there for a formula), and
 * attachFormulas() computed values AFTER the SQL page (and its ORDER BY) had
 * already run. MN-260's decision: materialize formula values into a new
 * `computed_values` column, recomputed on the record's own write, so SORTABLE/
 * fieldExpr()/the keyset cursor treat it like any other stored field — same
 * machinery #252 already hardened, not a second (offset) pagination mode.
 *
 * Rollup was NOT in scope for MN-260 — the spike for that ticket found no
 * existing recompute-on-related-record-change plumbing for rollups
 * (attachRollups was a pure read-time, per-fetched-page computation; no
 * DomainEventsService subscriber touched rollup at all). #267 built that
 * plumbing (RollupInvalidationSubscriber + RecordsService.invalidateRollupsForChange/
 * recomputeRollupsForRelationField materializing into the same computed_values
 * column) — see records-query-rollup-sort.test.ts for rollup's own sort/cursor
 * coverage and the cross-record recompute test. A formula that reaches into a
 * rollup is sortable now too (asserted below); one reaching into a `lookup`
 * still isn't — lookup has no such plumbing.
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const queryUrl = () => `/workspaces/${wsId}/databases/${dbId}/records/query`;
async function sortQuery(payload: Record<string, unknown>) {
  return inject('POST', queryUrl(), payload);
}
async function sortTitles(payload: Record<string, unknown>): Promise<string[]> {
  const res = await sortQuery(payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title);
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Sorter');
  wsId = (await inject('POST', '/workspaces', { name: 'Formula Sort WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Estimate', type: 'number' });
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Spent', type: 'number' });
  const formula = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Remaining', type: 'formula', config: { expression: '{Estimate} - {Spent}' },
  });
  expect(formula.statusCode, formula.body).toBe(201);
  expect(formula.json().config.result_type).toBe('number');

  // Alpha 10-4=6, Beta 5-5=0, Gamma 20-5=15, Delta estimate only (spent missing → null),
  // Epsilon neither (→ null). Two nulls, three non-null, mirrors #252's nulls-first fixture shape.
  const batch = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
    records: [
      { values: { name: 'Alpha', estimate: 10, spent: 4 } },
      { values: { name: 'Beta', estimate: 5, spent: 5 } },
      { values: { name: 'Gamma', estimate: 20, spent: 5 } },
      { values: { name: 'Delta', estimate: 8 } },
      { values: { name: 'Epsilon' } },
    ],
  });
  expect(batch.statusCode, batch.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('sorting by formula fields (MN-260)', () => {
  it('materializes on create: the formula value is immediately sortable, not just displayable', async () => {
    const result = await sortTitles({ sorts: [{ field: 'remaining', direction: 'asc' }] });
    // NULLS LAST default: 0, 6, 15, then the two nulls (order between them undetermined by value).
    expect(result.slice(0, 3)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(result.slice(3).sort()).toEqual(['Delta', 'Epsilon']);
  });

  it('sorts descending too (numeric cast of computed_values, not a text compare)', async () => {
    const result = await sortTitles({ sorts: [{ field: 'remaining', direction: 'desc' }] });
    expect(result.slice(0, 3)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  // Deterministic tiebreak for the null bucket, same trick as records-query.test.ts:
  // a second sort key (estimate desc) breaks the Delta/Epsilon tie. With nulls:
  // 'first' that key is ALSO nulls-first, so Epsilon (no estimate) leads Delta.
  it('nulls: "first" places empty formula values before non-null ones', async () => {
    const result = await sortTitles({
      sorts: [{ field: 'remaining', direction: 'asc' }, { field: 'estimate', direction: 'desc' }],
      nulls: 'first',
    });
    expect(result).toEqual(['Epsilon', 'Delta', 'Beta', 'Alpha', 'Gamma']);
  });

  it('keyset cursor pages stably across the null/non-null boundary on a formula key', async () => {
    const sorts = [
      { field: 'remaining', direction: 'asc' as const },
      { field: 'estimate', direction: 'desc' as const },
    ];
    const page1 = await sortQuery({ sorts, nulls: 'first', limit: 2 });
    expect(page1.json().data.map((r: { title: string }) => r.title)).toEqual(['Epsilon', 'Delta']);

    const page2 = await sortQuery({ sorts, nulls: 'first', limit: 10, cursor: page1.json().next_cursor });
    expect(page2.json().data.map((r: { title: string }) => r.title)).toEqual(['Beta', 'Alpha', 'Gamma']);

    const ids1 = page1.json().data.map((r: { id: string }) => r.id);
    const ids2 = page2.json().data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    expect(page2.json().has_more).toBe(false);
  });

  // The exact gap #252's own PR found on a plain field: a NON-NULL cursor value on
  // a nulls-first DESC key had zero coverage. Reproduced here on the formula's
  // materialized (computed_values, ::numeric-cast) expression specifically —
  // page 1 must end on a real (non-null) `remaining` value, not a null one.
  it('keyset cursor pages stably past a NON-NULL cursor value on a nulls-first DESC formula key', async () => {
    const sorts = [{ field: 'remaining', direction: 'desc' as const }];
    // limit=3 → both nulls (Epsilon, Delta, order unconstrained) + Gamma (15, the
    // first non-null desc value) so the cursor is real: Gamma's remaining=15.
    const page1 = await sortQuery({ sorts, nulls: 'first', limit: 3 });
    const page1Titles = page1.json().data.map((r: { title: string }) => r.title);
    expect(page1Titles.slice(0, 2).sort()).toEqual(['Delta', 'Epsilon']);
    expect(page1Titles[2]).toBe('Gamma');

    const page2 = await sortQuery({ sorts, nulls: 'first', limit: 10, cursor: page1.json().next_cursor });
    expect(page2.json().data.map((r: { title: string }) => r.title)).toEqual(['Alpha', 'Beta']);
  });

  it('recompute-on-write: changing the record\'s own field updates the MATERIALIZED sort value, not just the displayed one', async () => {
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=50`)).json();
    const alpha = list.data.find((r: { title: string }) => r.title === 'Alpha');

    // Before: Beta(0) < Alpha(6) < Gamma(15).
    expect((await sortTitles({ sorts: [{ field: 'remaining', direction: 'asc' }] })).slice(0, 3)).toEqual([
      'Beta', 'Alpha', 'Gamma',
    ]);

    // Alpha's own field changes (10 - 19 = -9) — no touch to `remaining` itself
    // (which is read-only anyway) and no re-save of any other record.
    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${alpha.id}`, {
      values: { spent: 19 },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    const refetched = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${alpha.id}`);
    expect(refetched.json().values.remaining).toBe(-9); // displayed value: always fresh, was already correct pre-#260

    // The materialized SORT value must reflect it immediately too (this is the
    // part that regresses if recompute-on-write is skipped or fire-and-forgotten
    // without being awaited before the response returns).
    const reordered = await sortTitles({ sorts: [{ field: 'remaining', direction: 'asc' }] });
    expect(reordered.slice(0, 3)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('backfills existing records when a formula field is added after the fact', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const freshDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Backfill' })).json().id;
    await inject('POST', `/workspaces/${wsId}/databases/${freshDb}/fields`, { display_name: 'Score', type: 'number' });

    // Records exist BEFORE the formula field does.
    await inject('POST', `/workspaces/${wsId}/databases/${freshDb}/records/batch`, {
      records: [
        { values: { name: 'Low', score: 1 } },
        { values: { name: 'High', score: 9 } },
        { values: { name: 'Mid', score: 5 } },
      ],
    });

    const formula = await inject('POST', `/workspaces/${wsId}/databases/${freshDb}/fields`, {
      display_name: 'Doubled', type: 'formula', config: { expression: '{Score} * 2' },
    });
    expect(formula.statusCode, formula.body).toBe(201);

    // No record was touched after the field was created — if only recompute-on-write
    // ran (no backfill), every one of these would sort as null.
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${freshDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'doubled', direction: 'asc' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.map((r: { title: string }) => r.title)).toEqual(['Low', 'Mid', 'High']);
  });

  it('allows sorting by a rollup, and by a formula that (transitively) depends on one (MN-267) — but still rejects one that depends on a lookup', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const membersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Members' })).json().id;
    const timeoffDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Time Off' })).json().id;
    await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, { display_name: 'Allocation', type: 'number' });
    await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, { display_name: 'Days', type: 'number' });

    await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: timeoffDb, database_b_id: membersDb,
      cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
    });
    const memberFields = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json().fields;
    const timeOffRelationField = memberFields.find((f: { apiName: string }) => f.apiName === 'time_off');

    const rollup = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Days Used', type: 'rollup',
      config: { relation_field_id: timeOffRelationField.id, op: 'sum', target_field_api_name: 'days' },
    });
    expect(rollup.statusCode, rollup.body).toBe(201);

    const balance = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Balance', type: 'formula', config: { expression: '{Allocation} - {Days Used}' },
    });
    expect(balance.statusCode, balance.body).toBe(201);

    // A same-record-only formula on the same database still works…
    const doubled = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Double Allocation', type: 'formula', config: { expression: '{Allocation} * 2' },
    });
    expect(doubled.statusCode, doubled.body).toBe(201);
    const okSort = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${membersDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'double_allocation', direction: 'asc' }] },
    });
    expect(okSort.statusCode, okSort.body).toBe(201);

    // MN-267: rollup now has real recompute-on-related-record-change plumbing
    // (RollupInvalidationSubscriber) — it's sortable directly, and so is a
    // formula that (transitively) depends on one. See records-query-rollup-sort.test.ts
    // for the actual ordering/cursor coverage; this file only asserts the gate.
    const rollupSort = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${membersDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'days_used', direction: 'asc' }] },
    });
    expect(rollupSort.statusCode, rollupSort.body).toBe(201);

    const balanceSort = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${membersDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'balance', direction: 'asc' }] },
    });
    expect(balanceSort.statusCode, balanceSort.body).toBe(201);

    // …but `lookup` still has no such plumbing — a formula reaching into one
    // 422s rather than silently sorting on a value materialized as always null.
    const lookupField = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Any Day Off', type: 'lookup',
      config: { relation_field_id: timeOffRelationField.id, target_field_api_name: 'days' },
    });
    expect(lookupField.statusCode, lookupField.body).toBe(201);
    const throughLookup = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Plus Lookup', type: 'formula', config: { expression: '{Allocation} + {Any Day Off}' },
    });
    expect(throughLookup.statusCode, throughLookup.body).toBe(201);
    const badSort = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${membersDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'plus_lookup', direction: 'asc' }] },
    });
    expect(badSort.statusCode, badSort.body).toBe(422);
  });
});
