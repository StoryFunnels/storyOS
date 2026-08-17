import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #300 slice B — sorting and filtering by a FORMULA RELATION AGGREGATE
 * (`count({Issues})`, `sum({Issues.Estimate})`).
 *
 * #298 shipped the engine and deliberately refused to materialize these: a
 * cross-record value frozen at the parent's own write time is stale the moment
 * a linked record changes, and sorting by a value that was never stored orders
 * the page by null while looking like the sort was ignored.
 *
 * What changed is the plumbing, not the reasoning — invalidateRollupsForChange
 * now recomputes these on exactly the events that can move them, the same
 * guarantee that earned rollups (MN-267) their place in computed_values. These
 * tests exist to hold that guarantee: every one of them asserts the resulting
 * ORDER or matched SET after a related change, never merely a 2xx.
 */

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let projectsDb: string;
let issuesDb: string;
let projectFieldId: string; // the relation field on ISSUES, pointing at its project

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

async function project(name: string): Promise<{ id: string }> {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name } });
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json();
}

async function issue(projectId: string, values: Record<string, unknown>): Promise<{ id: string }> {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${issuesDb}/records`, { values });
  expect(res.statusCode, res.body).toBeLessThan(300);
  const created = res.json();
  // Linked from the ISSUE side: in a one_to_many relation side A is the MANY
  // side, so each issue points at one project (and a project collects many).
  // The field id goes in the path, not the body.
  const link = await inject(
    'PUT',
    `/workspaces/${wsId}/databases/${issuesDb}/records/${created.id}/links/${projectFieldId}`,
    { record_ids: [projectId] },
  );
  expect(link.statusCode, link.body).toBeLessThan(300);
  return created;
}

/**
 * The recompute cascade is fire-and-forget by design (bounded fan-out, never
 * awaited by the write that triggered it), so a materialized value lands shortly
 * AFTER the write returns. Poll rather than racing it — asserting immediately
 * tests the scheduler, not the behaviour.
 */
async function pollQuery(
  payload: Record<string, unknown>,
  until: (rows: Array<Record<string, never>>) => boolean,
): Promise<Array<Record<string, never>>> {
  let rows: Array<Record<string, never>> = [];
  for (let i = 0; i < 40; i++) {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
    rows = res.json().data;
    if (until(rows)) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return rows; // let the assertion below fail with a readable diff
}

const titlesOf = (rows: Array<Record<string, never>>) => rows.map((r) => (r as { title: string }).title);

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Aggregate Sorter');
  wsId = (await inject('POST', '/workspaces', { name: 'Aggregate Sort WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  issuesDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Issues' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${issuesDb}/fields`, { display_name: 'Estimate', type: 'number' });

  const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: issuesDb, // A is the MANY side: many issues, one project
    database_b_id: projectsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Project',
    field_b_name: 'Issues',
  });
  expect(rel.statusCode, rel.body).toBeLessThan(300);
  const issueFields = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb}`)).json().fields;
  const projectField = issueFields.find((f: { type: string }) => f.type === 'relation');
  expect(projectField, JSON.stringify(issueFields.map((f: { api_name: string }) => f.api_name))).toBeDefined();
  projectFieldId = projectField.id;

  const counted = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
    display_name: 'Open Issues',
    type: 'formula',
    config: { expression: 'count({Issues})' },
  });
  expect(counted.statusCode, counted.body).toBe(201);
  expect(counted.json().config.result_type).toBe('number');

  const totalled = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
    display_name: 'Total Estimate',
    type: 'formula',
    config: { expression: 'sum({Issues.Estimate})' },
  });
  expect(totalled.statusCode, totalled.body).toBe(201);
});

afterAll(async () => {
  await app?.close();
});

describe('sorting by a formula relation aggregate (#300)', () => {
  it('orders by the aggregate, not by null', async () => {
    const big = await project('Big');
    const small = await project('Small');
    await project('Empty');
    await issue(big.id, { name: 'b1', estimate: 5 });
    await issue(big.id, { name: 'b2', estimate: 8 });
    await issue(small.id, { name: 's1', estimate: 1 });

    const rows = await pollQuery(
      { sorts: [{ field: 'open_issues', direction: 'desc' }] },
      (r) => titlesOf(r).slice(0, 2).join() === 'Big,Small',
    );
    // Big (2 issues) before Small (1) before Empty (0). Under #298 all three
    // sorted by null and came back in insertion order, which looks identical to
    // "the sort was ignored".
    expect(titlesOf(rows)).toEqual(['Big', 'Small', 'Empty']);
  });

  it('sorts by a sum across the link, not by the count', async () => {
    const rows = await pollQuery(
      { sorts: [{ field: 'total_estimate', direction: 'desc' }] },
      (r) => titlesOf(r)[0] === 'Big',
    );
    // Big totals 13, Small 1 — the same ORDER as the count here, so the real
    // assertion is the value below: a sum that silently counted would read 2.
    expect(titlesOf(rows).slice(0, 2)).toEqual(['Big', 'Small']);
    const bigRow = rows.find((r) => (r as { title: string }).title === 'Big') as unknown as {
      values: Record<string, unknown>;
    };
    expect(bigRow.values.total_estimate).toBe(13);
  });

  it('an empty relation is 0 for count and empty for sum', async () => {
    const rows = await pollQuery({ filter: { and: [{ field: 'name', op: 'eq', value: 'Empty' }] } }, (r) => r.length === 1);
    const values = (rows[0] as unknown as { values: Record<string, unknown> }).values;
    expect(values.open_issues).toBe(0);
    // Not 0 — "no data" and "adds up to zero" are different answers, and this
    // matches Rollup deliberately so the two never disagree.
    expect(values.total_estimate).toBeNull();
  });
});

describe('filtering by a formula relation aggregate (#300)', () => {
  it('matches on the aggregate', async () => {
    const rows = await pollQuery(
      { filter: { and: [{ field: 'open_issues', op: 'gte', value: 2 }] } },
      (r) => r.length === 1,
    );
    expect(titlesOf(rows)).toEqual(['Big']);
  });

  it('is_empty does not match a record whose aggregate is 0', async () => {
    const rows = await pollQuery({ filter: { and: [{ field: 'open_issues', op: 'is_empty' }] } }, () => true);
    // A count of 0 is a real value, not an absent one. Treating it as empty
    // would make "projects with no issues" and "projects we haven't computed
    // yet" indistinguishable.
    expect(titlesOf(rows)).not.toContain('Empty');
  });
});

describe('invalidation keeps the materialized aggregate honest (#300)', () => {
  it('refreshes when a LINKED RECORD changes', async () => {
    const shifting = await project('Shifting');
    const only = await issue(shifting.id, { name: 'first', estimate: 2 });

    await pollQuery(
      { filter: { and: [{ field: 'total_estimate', op: 'eq', value: 2 }] } },
      (r) => titlesOf(r).includes('Shifting'),
    );

    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${issuesDb}/records/${only.id}`, {
      values: { estimate: 40 },
    });
    expect(patch.statusCode, patch.body).toBeLessThan(300);

    // This is the guarantee #298 could not make, and the whole reason it
    // refused to materialize: the parent was never written, only its child.
    const rows = await pollQuery(
      { filter: { and: [{ field: 'total_estimate', op: 'eq', value: 40 }] } },
      (r) => titlesOf(r).includes('Shifting'),
    );
    expect(titlesOf(rows)).toContain('Shifting');
  });

  it('refreshes when the LINK SET changes', async () => {
    const growing = await project('Growing');
    await pollQuery(
      { filter: { and: [{ field: 'open_issues', op: 'eq', value: 0 }] } },
      (r) => titlesOf(r).includes('Growing'),
    );

    await issue(growing.id, { name: 'new one', estimate: 3 });

    const rows = await pollQuery(
      { filter: { and: [{ field: 'open_issues', op: 'eq', value: 1 }] } },
      (r) => titlesOf(r).includes('Growing'),
    );
    expect(titlesOf(rows)).toContain('Growing');
  });
});

describe('a formula over a LOOKUP is still refused (#300)', () => {
  it('says so rather than sorting by a value nothing recomputes', async () => {
    const lookup = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Any Estimate',
      type: 'lookup',
      config: {
        relation_field_id: (await inject('GET', `/workspaces/${wsId}/databases/${projectsDb}`)).json()
          .fields.find((f: { type: string }) => f.type === 'relation').id,
        target_field_api_name: 'estimate',
      },
    });
    expect(lookup.statusCode, lookup.body).toBe(201);
    const viaLookup = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Lookup Doubled',
      type: 'formula',
      config: { expression: 'concat({Any Estimate}, "!")' },
    });
    expect(viaLookup.statusCode, viaLookup.body).toBe(201);

    const res = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records/query`, {
      sorts: [{ field: 'lookup_doubled', direction: 'asc' }],
    });
    // Nothing recomputes a materialized copy of a lookup, so this must keep
    // refusing loudly — lifting the relation-aggregate ban must not quietly
    // lift this one too.
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('lookup');
  });
});
