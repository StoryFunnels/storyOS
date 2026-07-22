import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-295: filtered rollups — an optional filter on a Rollup field's config
 * scopes the aggregate to only the linked records matching it (e.g. "count of
 * Time Off requests where State != Approved"), reusing:
 *  - the SAME filter AST as saved views / POST /records/query
 *    (packages/schemas' filterSchema, compiled by query-compiler's
 *    compileFilter — see assertRollupFilter/attachRollups/
 *    computeRollupValuesForChunk in the API)
 *  - MN-267's rollup-invalidation trigger surface (RollupInvalidationSubscriber
 *    → RecordsService.invalidateRollupsForChange → recomputeRollupsForRelationField)
 *    rather than a second recompute mechanism — a filtered rollup recomputes
 *    on the SAME "related record changed" / "link changed" events an
 *    unfiltered rollup already does, just with the filter applied inside the
 *    aggregate query itself.
 *
 * Fixture mirrors records-query-rollup-sort.test.ts's Members/Time Off shape
 * deliberately, plus a `state` select field on Time Off to filter on — chosen
 * specifically NOT to be the rollup's target field (`days`), so the
 * recompute-on-filter-field-change assertions below exercise the genuinely
 * new invalidation path (MN-267 alone would only re-trigger on `days`
 * changing, never on `state`).
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let membersDb: string;
let timeoffDb: string;
let memberFieldId: string; // relation field on Time Off → Members (side a)
let timeoffFieldId: string; // inverse relation field on Members → Time Off (side b)
let stateOpenId: string;
let stateApprovedId: string;
let openCountFieldApi: string;
let daysUsedOpenFieldApi: string;
let alphaId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function getMemberValues(recordId: string): Promise<Record<string, unknown>> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records/${recordId}`);
  return res.json().values;
}

/** The recompute cascade is fire-and-forget — poll briefly rather than asserting immediately
 * (same pattern records-query-rollup-sort.test.ts and auto-link.test.ts already use). */
async function pollUntil(recordId: string, fieldApi: string, expected: unknown): Promise<unknown> {
  let value: unknown;
  for (let i = 0; i < 40; i++) {
    value = (await getMemberValues(recordId))[fieldApi];
    if (value === expected) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return value; // let the assertion below fail with a readable diff
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Rollup Filterer');
  wsId = (await inject('POST', '/workspaces', { name: 'Rollup Filter WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  membersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Members' })).json().id;
  timeoffDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Time Off' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, { display_name: 'Days', type: 'number' });
  const state = await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, {
    display_name: 'State',
    type: 'select',
    options: [{ label: 'Open' }, { label: 'Approved' }],
  });
  const stateOptions = state.json().options as Array<{ label: string; id: string }>;
  stateOpenId = stateOptions.find((o) => o.label === 'Open')!.id;
  stateApprovedId = stateOptions.find((o) => o.label === 'Approved')!.id;

  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: timeoffDb, database_b_id: membersDb,
    cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
  });
  const timeoffFields = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}`)).json().fields;
  memberFieldId = timeoffFields.find((f: { apiName: string }) => f.apiName === 'member').id;
  const memberFields = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json().fields;
  timeoffFieldId = memberFields.find((f: { apiName: string }) => f.apiName === 'time_off').id;

  // Filter-only count (the ticket's own motivating example: "count of linked
  // records where State != Done") — no target_field_api_name at all.
  const openCount = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
    display_name: 'Open Requests',
    type: 'rollup',
    config: {
      relation_field_id: timeoffFieldId,
      op: 'count',
      filter: { field: 'state', op: 'neq', value: stateApprovedId },
    },
  });
  expect(openCount.statusCode, openCount.body).toBe(201);
  openCountFieldApi = openCount.json().apiName;

  // Filtered sum whose filter field (`state`) is DIFFERENT from its target
  // field (`days`) — the case an unfiltered-rollup's invalidation logic
  // (target-field-only) would miss.
  const daysUsedOpen = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
    display_name: 'Days Used (Open)',
    type: 'rollup',
    config: {
      relation_field_id: timeoffFieldId,
      op: 'sum',
      target_field_api_name: 'days',
      filter: { field: 'state', op: 'neq', value: stateApprovedId },
    },
  });
  expect(daysUsedOpen.statusCode, daysUsedOpen.body).toBe(201);
  daysUsedOpenFieldApi = daysUsedOpen.json().apiName;

  alphaId = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, { values: { name: 'Alpha' } })).json().id;

  async function addTimeOff(days: number, state: string) {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, {
      values: { name: `PTO ${days}`, days, state },
    })).json();
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${rec.id}/links/${memberFieldId}`, {
      record_ids: [alphaId],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);
    return rec.id as string;
  }

  // Alpha: 2 Open (5 + 3 days) + 1 Approved (10 days) — the filter should
  // exclude the Approved one from both `open_count` and `days_used_open`.
  await addTimeOff(5, stateOpenId);
  await addTimeOff(3, stateOpenId);
  await addTimeOff(10, stateApprovedId);

  await pollUntil(alphaId, openCountFieldApi, 2);
});

afterAll(async () => {
  await app.close();
});

describe('filtered rollups (MN-295)', () => {
  it('count with a filter counts only the linked records matching the condition', async () => {
    expect(await getMemberValues(alphaId)).toMatchObject({ [openCountFieldApi]: 2 });
  });

  it('sum with a filter aggregates only the linked records matching the condition', async () => {
    expect(await getMemberValues(alphaId)).toMatchObject({ [daysUsedOpenFieldApi]: 8 });
  });

  /**
   * NOT tested here: filtering a QUERY by a rollup field's computed VALUE
   * (`filter: {field: <rollup>, op: 'eq', value: N}`) — that's a separate,
   * PRE-EXISTING restriction unrelated to MN-295. query-compiler.ts's
   * compileCondition() has never had a `case 'rollup'` (nor `case 'formula'`)
   * in its type switch, all the way back to the file's first commit
   * (395a611, MN-012) — confirmed by git log -p showing the `default: throw
   * err('filters on "${def.type}" fields are not supported')` fallback
   * unchanged since then, and by this PR's own diff touching nothing in
   * compileCondition. Only sortExpr/fieldExpr support rollup (and formula)
   * fields — i.e. you can sort a query by a rollup's materialized value
   * (asserted below, and by records-query-rollup-sort.test.ts for the
   * unfiltered case), but not filter by it. Out of scope for this ticket.
   */
  it('is sortable the same as an unfiltered rollup (materialized into computed_values)', async () => {
    const beta = (
      await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, { values: { name: 'Beta' } })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${membersDb}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: openCountFieldApi, direction: 'desc' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    // Alpha (open_count 2) sorts above Beta (no Time Off records → 0).
    expect(res.json().data.map((r: { id: string }) => r.id)).toEqual([alphaId, beta.id]);
  });

  it('recomputes when a linked record\'s FILTERED-ON field changes, even though the target field did not (reuses MN-267\'s invalidation, not a second mechanism)', async () => {
    const timeoffList = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}/records?limit=50`)).json();
    const threeDayPto = timeoffList.data.find((r: { title: string }) => r.title === 'PTO 3');

    // Only `state` changes — the rollup's TARGET field (`days`) is untouched,
    // so a naive "recompute only when the target field changes" invalidation
    // (i.e. MN-267 unextended) would miss this entirely.
    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${timeoffDb}/records/${threeDayPto.id}`, {
      values: { state: stateApprovedId },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    expect(await pollUntil(alphaId, openCountFieldApi, 1)).toBe(1);
    expect(await pollUntil(alphaId, daysUsedOpenFieldApi, 5)).toBe(5);

    // Restore for isolation from any test ordering assumptions.
    const restore = await inject('PATCH', `/workspaces/${wsId}/databases/${timeoffDb}/records/${threeDayPto.id}`, {
      values: { state: stateOpenId },
    });
    expect(restore.statusCode, restore.body).toBe(200);
    await pollUntil(alphaId, openCountFieldApi, 2);
    await pollUntil(alphaId, daysUsedOpenFieldApi, 8);
  });

  it('backward compatible: a rollup with NO filter still aggregates every linked record unconditionally', async () => {
    const allCount = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'All Requests',
      type: 'rollup',
      config: { relation_field_id: timeoffFieldId, op: 'count' },
    });
    expect(allCount.statusCode, allCount.body).toBe(201);
    const allCountApi = allCount.json().apiName;

    expect(await pollUntil(alphaId, allCountApi, 3)).toBe(3);
  });
});
