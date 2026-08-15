import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';

/**
 * #298 — relation aggregates end to end, through the real API.
 *
 * Projects ──< Issues, with each issue carrying an Estimate and a State.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let projectsDb: string;
let issuesDb: string;
let relationFieldApi: string;
let relationFieldId: string;
let estimateApi: string;
let stateApi: string;
let doneOptionId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

async function addField(db: string, body: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/fields`, body);
  expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);
  return res.json();
}

async function addFormula(expression: string, name = `f_${Math.abs(hash(expression))}`) {
  return addField(projectsDb, { display_name: name, type: 'formula', config: { expression } });
}

/** Stable name per expression without Math.random (banned in this repo's scripts). */
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

async function createRecord(db: string, values: Record<string, unknown>) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, { values });
  expect(res.statusCode, JSON.stringify(res.json())).toBeLessThan(300);
  return res.json() as { id: string; values: Record<string, unknown> };
}

async function readProject(id: string) {
  return (
    await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${id}`)
  ).json() as { values: Record<string, unknown> };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'rel-agg');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Aggregates Co' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  projectsDb = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })
  ).json().id;
  issuesDb = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Issues' })
  ).json().id;

  estimateApi = (await addField(issuesDb, { display_name: 'Estimate', type: 'number' })).apiName;
  const state = await addField(issuesDb, {
    display_name: 'State',
    type: 'select',
    options: [{ label: 'Done', color: 'green' }, { label: 'Open', color: 'gray' }],
  });
  stateApi = state.apiName;
  const stateDetail = (
    await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${issuesDb}`)
  ).json();
  doneOptionId = stateDetail.fields.find((f: { apiName: string }) => f.apiName === stateApi).options.find(
    (o: { label: string }) => o.label === 'Done',
  ).id;

  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsDb,
    database_b_id: issuesDb,
    cardinality: 'many_to_many',
    field_a_name: 'Issues',
    field_b_name: 'Projects',
  });
  expect(rel.statusCode, JSON.stringify(rel.json())).toBeLessThan(300);
  const projectsDetail = (
    await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}`)
  ).json();
  const relationField = projectsDetail.fields.find((f: { type: string }) => f.type === 'relation');
  relationFieldApi = relationField.apiName;
  // The links route takes the field's ID, not its api_name.
  relationFieldId = relationField.id;
});

afterAll(async () => {
  await app?.close();
});

/** A project linked to issues with the given (estimate, done?) pairs. */
async function projectWith(issues: Array<[number | null, boolean]>) {
  const project = await createRecord(projectsDb, { name: 'P' });
  for (const [estimate, done] of issues) {
    const issue = await createRecord(issuesDb, {
      name: 'I',
      ...(estimate === null ? {} : { [estimateApi]: estimate }),
      ...(done ? { [stateApi]: doneOptionId } : {}),
    });
    const link = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${project.id}/links/${relationFieldId}`,
      { record_ids: [issue.id] },
    );
    expect(link.statusCode).toBeLessThan(300);
  }
  return project.id;
}

describe('relation aggregates through the API (#298)', () => {
  it('counts, sums and conditions across the link', async () => {
    const countF = await addFormula(`count({Issues})`, 'IssueCount');
    const sumF = await addFormula(`sum({Issues.Estimate})`, 'TotalEstimate');
    const doneF = await addFormula(`count({Issues}, {Issues.State} = "Done")`, 'DoneCount');

    const id = await projectWith([[3, true], [5, false], [2, true]]);
    const values = (await readProject(id)).values;

    expect(values[countF.apiName]).toBe(3);
    expect(values[sumF.apiName]).toBe(10);
    // The condition compares the select's LABEL, matching how own-record
    // formulas read selects — otherwise the user would have to write a uuid.
    expect(values[doneF.apiName]).toBe(2);
  });

  it('a project with no linked issues reads 0 / null, matching rollup', async () => {
    const countF = await addFormula(`count({Issues})`, 'EmptyCount');
    const sumF = await addFormula(`sum({Issues.Estimate})`, 'EmptySum');
    const id = await projectWith([]);
    const values = (await readProject(id)).values;
    expect(values[countF.apiName]).toBe(0);
    expect(values[sumF.apiName]).toBeNull();
  });

  it('agrees with the equivalent Rollup field on the same data', async () => {
    const relField = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}`)
    ).json().fields.find((f: { type: string }) => f.type === 'relation');
    const rollup = await addField(projectsDb, {
      display_name: 'RollupTotal',
      type: 'rollup',
      config: { relation_field_id: relField.id, op: 'sum', target_field_api_name: estimateApi },
    });
    const formula = await addFormula(`sum({Issues.Estimate})`, 'FormulaTotal');

    const id = await projectWith([[7, true], [1, false]]);
    const values = (await readProject(id)).values;
    // Two paths, same data — a user who has both must never see them disagree.
    expect(values[formula.apiName]).toBe(8);
    expect(values[rollup.apiName]).toBe(8);
  });
});

describe('the aggregate is batch-loaded, not per record (#298)', () => {
  /**
   * The AC asks for this to be ASSERTED, not assumed: reading a page of N
   * records must issue one round of record queries per referenced relation, not
   * one per record. Spying on the record loader is the direct way to see it —
   * a per-record implementation would scale this count with N.
   */
  it('issues the same number of record queries for 1 record as for 12', async () => {
    await addFormula(`count({Issues})`, 'BatchCount');
    const db = app.get<{ query: { records: { findMany: (...a: unknown[]) => unknown } } }>(DB);

    const pageQueryCount = async (limit: number) => {
      const spy = vi.spyOn(db.query.records, 'findMany');
      const res = await as(
        admin.token,
        'GET',
        `/workspaces/${wsId}/databases/${projectsDb}/records?limit=${limit}`,
      );
      expect(res.statusCode).toBe(200);
      const calls = spy.mock.calls.length;
      spy.mockRestore();
      return calls;
    };

    const small = await pageQueryCount(1);
    const large = await pageQueryCount(12);
    // Guard against a vacuous pass: if the spy never fired, `0 === 0` would look
    // like perfect batching while asserting nothing at all.
    expect(small).toBeGreaterThan(0);
    expect(large).toBe(small);
  });
});
