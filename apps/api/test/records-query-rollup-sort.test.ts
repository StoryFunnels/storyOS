import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-267: sorting by a rollup field. Unlike formula (MN-260 — same-record
 * inputs, recompute-on-own-write is enough), a rollup's inputs live on OTHER
 * records reached through a relation, so there was NO recompute-on-related-
 * record-change plumbing before this (confirmed by the #267 spike: attachRollups
 * was pure read-time, and DomainEventsService had no rollup subscriber at all).
 *
 * This exercises the new cross-record invalidation plumbing end to end:
 *  - RollupInvalidationSubscriber (mirrors AutoLinkSubscriber's shape)
 *  - RecordsService.invalidateRollupsForChange (the "who is affected" discovery
 *    — unit-tested directly, with a mocked Db, in
 *    records.service.rollup-invalidation.test.ts, since Docker/Postgres are
 *    unreachable in some sandboxes; this file is the real-DB counterpart)
 *  - RecordsService.recomputeRollupsForRelationField (the aggregate + persist)
 *
 * Because the recompute is fire-and-forget (bounded fan-out — see
 * docs/architecture/record-storage.md's "Rollup materialization" staleness
 * bound), assertions that depend on a cascade poll briefly first, same pattern
 * apps/api/test/auto-link.test.ts already uses for its own fire-and-forget
 * on-write subscriber.
 */

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let membersDb: string;
let timeoffDb: string;
let memberFieldId: string; // relation field on Time Off → Members (side a)
let timeoffFieldId: string; // inverse relation field on Members → Time Off (side b)

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const queryUrl = () => `/workspaces/${wsId}/databases/${membersDb}/records/query`;
async function sortQuery(payload: Record<string, unknown>) {
  return inject('POST', queryUrl(), payload);
}
async function sortTitles(payload: Record<string, unknown>): Promise<string[]> {
  const res = await sortQuery(payload);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title);
}

/** The recompute cascade is fire-and-forget (bounded fan-out, never awaited by
 * the write that triggered it) — poll briefly rather than asserting immediately. */
async function pollUntilTitlesMatch(payload: Record<string, unknown>, expectedPrefix: string[]): Promise<string[]> {
  let titles: string[] = [];
  for (let i = 0; i < 40; i++) {
    titles = await sortTitles(payload);
    if (JSON.stringify(titles.slice(0, expectedPrefix.length)) === JSON.stringify(expectedPrefix)) return titles;
    await new Promise((r) => setTimeout(r, 50));
  }
  return titles; // let the assertion below fail with a readable diff
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Rollup Sorter');
  wsId = (await inject('POST', '/workspaces', { name: 'Rollup Sort WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  membersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Members' })).json().id;
  timeoffDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Time Off' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, { display_name: 'Days', type: 'number' });

  await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: timeoffDb, database_b_id: membersDb,
    cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
  });
  const timeoffFields = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}`)).json().fields;
  memberFieldId = timeoffFields.find((f: { apiName: string }) => f.apiName === 'member').id;
  const memberFields = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json().fields;
  timeoffFieldId = memberFields.find((f: { apiName: string }) => f.apiName === 'time_off').id;

  const rollup = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
    display_name: 'Days Used', type: 'rollup',
    config: { relation_field_id: timeoffFieldId, op: 'sum', target_field_api_name: 'days' },
  });
  expect(rollup.statusCode, rollup.body).toBe(201);

  // Beta(0) < Alpha(6) < Gamma(15), Delta/Epsilon unlinked (→ null) — same
  // shape as records-query-formula-sort.test.ts's fixture, deliberately, so
  // the nulls-first/DESC/cursor assertions below can mirror that file's.
  const members: Record<string, string> = {};
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
    members[name] = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, { values: { name } })).json().id;
  }

  async function addTimeOff(memberName: string, days: number) {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, { values: { name: `${memberName} PTO`, days } })).json();
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${rec.id}/links/${memberFieldId}`, {
      record_ids: [members[memberName]],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);
    return rec.id as string;
  }

  await addTimeOff('Beta', 0);
  await addTimeOff('Alpha', 2);
  await addTimeOff('Alpha', 4);
  await addTimeOff('Gamma', 15);

  // Linking is the case-(b) cascade (this record's own relation link-set
  // changed) — fire-and-forget, so give it a moment to land before any test runs.
  await pollUntilTitlesMatch({ sorts: [{ field: 'days_used', direction: 'asc' }] }, ['Beta', 'Alpha', 'Gamma']);
});

afterAll(async () => {
  await app.close();
});

describe('sorting by rollup fields (MN-267)', () => {
  it('materializes on link: the rollup value is sortable, not just displayable', async () => {
    const result = await sortTitles({ sorts: [{ field: 'days_used', direction: 'asc' }] });
    expect(result.slice(0, 3)).toEqual(['Beta', 'Alpha', 'Gamma']);
    expect(result.slice(3).sort()).toEqual(['Delta', 'Epsilon']);
  });

  it('sorts descending too (numeric cast of computed_values, not a text compare)', async () => {
    const result = await sortTitles({ sorts: [{ field: 'days_used', direction: 'desc' }] });
    expect(result.slice(0, 3)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('nulls: "first" places empty rollup values before non-null ones', async () => {
    const result = await sortTitles({
      sorts: [{ field: 'days_used', direction: 'asc' }, { field: 'name', direction: 'asc' }],
      nulls: 'first',
    });
    expect(result).toEqual(['Delta', 'Epsilon', 'Beta', 'Alpha', 'Gamma']);
  });

  it('keyset cursor pages stably across the null/non-null boundary on a rollup key', async () => {
    const sorts = [
      { field: 'days_used', direction: 'asc' as const },
      { field: 'name', direction: 'asc' as const },
    ];
    const page1 = await sortQuery({ sorts, nulls: 'first', limit: 2 });
    expect(page1.json().data.map((r: { title: string }) => r.title)).toEqual(['Delta', 'Epsilon']);

    const page2 = await sortQuery({ sorts, nulls: 'first', limit: 10, cursor: page1.json().next_cursor });
    expect(page2.json().data.map((r: { title: string }) => r.title)).toEqual(['Beta', 'Alpha', 'Gamma']);

    const ids1 = page1.json().data.map((r: { id: string }) => r.id);
    const ids2 = page2.json().data.map((r: { id: string }) => r.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
    expect(page2.json().has_more).toBe(false);
  });

  it('keyset cursor pages stably past a NON-NULL cursor value on a nulls-first DESC rollup key', async () => {
    const sorts = [{ field: 'days_used', direction: 'desc' as const }];
    const page1 = await sortQuery({ sorts, nulls: 'first', limit: 3 });
    const page1Titles = page1.json().data.map((r: { title: string }) => r.title);
    expect(page1Titles.slice(0, 2).sort()).toEqual(['Delta', 'Epsilon']);
    expect(page1Titles[2]).toBe('Gamma');

    const page2 = await sortQuery({ sorts, nulls: 'first', limit: 10, cursor: page1.json().next_cursor });
    expect(page2.json().data.map((r: { title: string }) => r.title)).toEqual(['Alpha', 'Beta']);
  });

  /**
   * The core AC (#267): change a RELATED record and assert the rollup-bearing
   * record's materialized value updates — WITHOUT the rollup-bearing record
   * (a Member) itself being re-saved. This is exactly the gap formula didn't
   * have (formula only ever depends on its own record's write) and rollup did.
   */
  it('recompute-on-related-record-change: editing a linked Time Off record\'s own field updates the Member\'s MATERIALIZED rollup sort value', async () => {
    // Before: Beta(0) < Alpha(6) < Gamma(15).
    expect((await sortTitles({ sorts: [{ field: 'days_used', direction: 'asc' }] })).slice(0, 3)).toEqual([
      'Beta', 'Alpha', 'Gamma',
    ]);

    const timeoffList = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}/records?limit=50`)).json();
    const betaPto = timeoffList.data.find((r: { title: string }) => r.title === 'Beta PTO');

    // The RELATED record's own field changes (0 → 20) — Beta (the Member) is
    // never touched by this request at all.
    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${timeoffDb}/records/${betaPto.id}`, {
      values: { days: 20 },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    // Beta's materialized `days_used` must climb above Gamma's 15 — recomputed
    // by RollupInvalidationSubscriber off the Time Off record's write, not
    // Beta's (Beta was never in this request's write path).
    const reordered = await pollUntilTitlesMatch(
      { sorts: [{ field: 'days_used', direction: 'asc' }] },
      ['Alpha', 'Gamma', 'Beta'],
    );
    expect(reordered.slice(0, 3)).toEqual(['Alpha', 'Gamma', 'Beta']);

    // Restore for the tests below.
    const restore = await inject('PATCH', `/workspaces/${wsId}/databases/${timeoffDb}/records/${betaPto.id}`, {
      values: { days: 0 },
    });
    expect(restore.statusCode, restore.body).toBe(200);
    await pollUntilTitlesMatch({ sorts: [{ field: 'days_used', direction: 'asc' }] }, ['Beta', 'Alpha', 'Gamma']);
  });

  it('backfills existing records when a rollup field is added after the fact', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const freshMembers = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Fresh Members' })).json().id;
    const freshTimeoff = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Fresh Time Off' })).json().id;
    await inject('POST', `/workspaces/${wsId}/databases/${freshTimeoff}/fields`, { display_name: 'Days', type: 'number' });
    await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: freshTimeoff, database_b_id: freshMembers,
      cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
    });
    const freshTimeoffFields = (await inject('GET', `/workspaces/${wsId}/databases/${freshTimeoff}`)).json().fields;
    const freshMemberFieldId = freshTimeoffFields.find((f: { apiName: string }) => f.apiName === 'member').id;

    const low = (await inject('POST', `/workspaces/${wsId}/databases/${freshMembers}/records`, { values: { name: 'Low' } })).json();
    const high = (await inject('POST', `/workspaces/${wsId}/databases/${freshMembers}/records`, { values: { name: 'High' } })).json();
    const lowPto = (await inject('POST', `/workspaces/${wsId}/databases/${freshTimeoff}/records`, { values: { name: 'Low PTO', days: 1 } })).json();
    const highPto = (await inject('POST', `/workspaces/${wsId}/databases/${freshTimeoff}/records`, { values: { name: 'High PTO', days: 9 } })).json();
    await inject('PUT', `/workspaces/${wsId}/databases/${freshTimeoff}/records/${lowPto.id}/links/${freshMemberFieldId}`, { record_ids: [low.id] });
    await inject('PUT', `/workspaces/${wsId}/databases/${freshTimeoff}/records/${highPto.id}/links/${freshMemberFieldId}`, { record_ids: [high.id] });

    const freshMemberFields = (await inject('GET', `/workspaces/${wsId}/databases/${freshMembers}`)).json().fields;
    const freshTimeoffFieldId = freshMemberFields.find((f: { apiName: string }) => f.apiName === 'time_off').id;

    // The rollup field is created AFTER both records (and their links) already
    // exist — no record was touched after the field was created, so if only
    // recompute-on-related-change ran (no backfill), both would sort as null.
    const rollup = await inject('POST', `/workspaces/${wsId}/databases/${freshMembers}/fields`, {
      display_name: 'Days Used', type: 'rollup',
      config: { relation_field_id: freshTimeoffFieldId, op: 'sum', target_field_api_name: 'days' },
    });
    expect(rollup.statusCode, rollup.body).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${freshMembers}/records/query`,
      headers: authed(admin.token),
      payload: { sorts: [{ field: 'days_used', direction: 'asc' }] },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.map((r: { title: string }) => r.title)).toEqual(['Low', 'High']);
  });

  it('a `count` rollup recomputes on link add/remove, independent of any target field value', async () => {
    const countField = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
      display_name: 'Requests', type: 'rollup', config: { relation_field_id: timeoffFieldId, op: 'count' },
    });
    expect(countField.statusCode, countField.body).toBe(201);

    const delta = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records?limit=50`))
      .json()
      .data.find((r: { title: string }) => r.title === 'Delta');
    expect(delta.values.requests).toBe(0);

    const newPto = (await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, { values: { name: 'Delta PTO', days: 3 } })).json();
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${newPto.id}/links/${memberFieldId}`, {
      record_ids: [delta.id],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);

    let requests = 0;
    for (let i = 0; i < 40; i++) {
      const row = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records/${delta.id}`)).json();
      requests = row.values.requests;
      if (requests === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(requests).toBe(1);

    // Unlink again — writeLinks captures the before-set at write time (this
    // is exactly the case a post-hoc record_links re-query would miss).
    const unlink = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${newPto.id}/links/${memberFieldId}`, {
      record_ids: [],
    });
    expect(unlink.statusCode, unlink.body).toBeLessThan(300);

    let requestsAfterUnlink = 1;
    for (let i = 0; i < 40; i++) {
      const row = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records/${delta.id}`)).json();
      requestsAfterUnlink = row.values.requests;
      if (requestsAfterUnlink === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(requestsAfterUnlink).toBe(0);
  });
});
