import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-287: RollupInvalidationSubscriber (MN-267) picks up `record_linked` from
 * RelationsService's addLinks/replaceLinks/removeLinks, but two other code
 * paths write `record_links` directly and, until now, emitted nothing:
 *
 *  - AutoLinkService.insertPlannedLinks (the shared write path for both
 *    on-write auto-link and the "run now" sweep)
 *  - RecordsService.duplicate()'s raw record_links copy (bypasses
 *    writeLinks() entirely — the point is copying links, not re-resolving them)
 *
 * This is the DB-integration counterpart to records-query-rollup-sort.test.ts's
 * "count rollup recomputes on link add/remove" case, but the link is created by
 * auto-link / duplicate() instead of the Links API — so a green run here proves
 * MN-287's record_linked emit (mirroring RelationsService.addLinks' shape) is
 * actually wired into RollupInvalidationSubscriber's cascade for both paths,
 * not just asserted by inspection. The recompute is fire-and-forget, same as
 * MN-267's own tests, so assertions poll briefly rather than checking immediately.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let membersDb: string;
let timeoffDb: string;
let memberFieldId: string; // relation field on Time Off -> Members (side a)
let timeoffFieldId: string; // inverse relation field on Members -> Time Off (side b)
let assigneeEmailApi: string;
let memberEmailApi: string;
let relationId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function memberRequests(memberId: string): Promise<number> {
  const row = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}/records/${memberId}`)).json();
  return row.values.requests as number;
}

/** The recompute cascade is fire-and-forget — poll briefly, same pattern as
 * records-query-rollup-sort.test.ts and auto-link.test.ts. */
async function pollRequestsUntil(memberId: string, expected: number): Promise<number> {
  let requests = -1;
  for (let i = 0; i < 40; i++) {
    requests = await memberRequests(memberId);
    if (requests === expected) return requests;
    await new Promise((r) => setTimeout(r, 50));
  }
  return requests; // let the assertion below fail with a readable diff
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Rollup Cascade');
  wsId = (await inject('POST', '/workspaces', { name: 'Rollup Cascade WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  membersDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Members' })).json().id;
  timeoffDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Time Off' })).json().id;

  const memberEmail = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, { display_name: 'Email', type: 'email' });
  memberEmailApi = memberEmail.json().apiName;
  const assigneeEmail = await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/fields`, { display_name: 'Assignee Email', type: 'email' });
  assigneeEmailApi = assigneeEmail.json().apiName;

  const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: timeoffDb, database_b_id: membersDb,
    cardinality: 'one_to_many', field_a_name: 'Member', field_b_name: 'Time Off',
  })).json();
  relationId = rel.id;
  const timeoffFields = (await inject('GET', `/workspaces/${wsId}/databases/${timeoffDb}`)).json().fields;
  memberFieldId = timeoffFields.find((f: { apiName: string }) => f.apiName === 'member').id;
  const memberFields = (await inject('GET', `/workspaces/${wsId}/databases/${membersDb}`)).json().fields;
  timeoffFieldId = memberFields.find((f: { apiName: string }) => f.apiName === 'time_off').id;

  const rollup = await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/fields`, {
    display_name: 'Requests', type: 'rollup',
    config: { relation_field_id: timeoffFieldId, op: 'count' },
  });
  expect(rollup.statusCode, rollup.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('rollup invalidation cascade from auto-link (MN-287)', () => {
  it('on-write auto-link recomputes the count rollup, with no direct write to the Member record', async () => {
    const member = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, {
      values: { name: 'Auto Member', [memberEmailApi]: 'auto@x.com' },
    })).json();
    expect(await memberRequests(member.id)).toBe(0);

    await inject('PATCH', `/workspaces/${wsId}/relations/${relationId}`, {
      auto_link: { conditions: [{ field_a: assigneeEmailApi, field_b: memberEmailApi }], case_sensitive: false },
    });

    // Creating this record is the ONLY write in this test — the on-write
    // AutoLinkSubscriber links it to `member`, and that link-insert
    // (AutoLinkService.insertPlannedLinks) must itself emit record_linked for
    // the Member's rollup to ever recompute; `member` is never touched directly.
    await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, {
      values: { name: 'Auto PTO', [assigneeEmailApi]: 'auto@x.com' },
    });

    expect(await pollRequestsUntil(member.id, 1)).toBe(1);
  });

  it('run-now auto-link recomputes the count rollup for every match it creates', async () => {
    await inject('PATCH', `/workspaces/${wsId}/relations/${relationId}`, { auto_link: null });
    const member = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, {
      values: { name: 'Sweep Member', [memberEmailApi]: 'sweep@x.com' },
    })).json();
    // Two Time Off rows seeded while rules are off, so run-now creates both links itself.
    await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, {
      values: { name: 'Sweep PTO 1', [assigneeEmailApi]: 'sweep@x.com' },
    });
    await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, {
      values: { name: 'Sweep PTO 2', [assigneeEmailApi]: 'sweep@x.com' },
    });
    expect(await memberRequests(member.id)).toBe(0);

    await inject('PATCH', `/workspaces/${wsId}/relations/${relationId}`, {
      auto_link: { conditions: [{ field_a: assigneeEmailApi, field_b: memberEmailApi }], case_sensitive: false },
    });
    const run = await inject('POST', `/workspaces/${wsId}/relations/${relationId}/auto-link`);
    expect(run.statusCode, run.body).toBe(201);
    expect(run.json().created).toBe(2);

    expect(await pollRequestsUntil(member.id, 2)).toBe(2);
  });
});

describe('rollup invalidation cascade from record duplicate() (MN-287)', () => {
  it('duplicating a linked record recomputes the target\'s count rollup, with no direct write to the target', async () => {
    await inject('PATCH', `/workspaces/${wsId}/relations/${relationId}`, { auto_link: null });
    const member = (await inject('POST', `/workspaces/${wsId}/databases/${membersDb}/records`, {
      values: { name: 'Dup Member' },
    })).json();
    const original = (await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records`, {
      values: { name: 'Original PTO' },
    })).json();
    // Link via the dedicated Links API (already known-good, per MN-267) so the
    // baseline count is established independent of anything this ticket touches.
    const link = await inject('PUT', `/workspaces/${wsId}/databases/${timeoffDb}/records/${original.id}/links/${memberFieldId}`, {
      record_ids: [member.id],
    });
    expect(link.statusCode, link.body).toBeLessThan(300);
    expect(await pollRequestsUntil(member.id, 1)).toBe(1);

    // The ONLY write in the assertion below is duplicating `original` — its
    // relation link to `member` is copied by RecordsService.duplicate() via a
    // raw record_links insert (bypassing writeLinks() entirely, by design: the
    // point is copying the link, not re-resolving it), so this only recomputes
    // if duplicate() itself now emits record_linked for that copy.
    const dup = await inject('POST', `/workspaces/${wsId}/databases/${timeoffDb}/records/${original.id}/duplicate`);
    expect(dup.statusCode, dup.body).toBe(201);
    expect(dup.json().values.member?.[0]?.id).toBe(member.id);

    expect(await pollRequestsUntil(member.id, 2)).toBe(2);
  });
});
