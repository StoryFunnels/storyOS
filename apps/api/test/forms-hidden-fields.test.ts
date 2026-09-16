import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #716 — a form field can carry `hidden` + a fixed `value`, stamped
 * server-side onto every record the form creates, never accepted from the
 * submission body. Exercises the ticket's own AC0-AC6:
 * - AC1 (the load-bearing one): the value comes from stored config, and a
 *   client-supplied value for the same hidden field is ignored.
 * - AC2: hidden + visible_when together is a config error.
 * - AC3: required on a hidden field never blocks submission.
 * - AC4: relation/text/select field types; a stale/cross-database relation
 *   target fails at CONFIG-SAVE time, not silently at submit time.
 * - AC5: a form with no hidden fields behaves exactly as before.
 * - AC6: the live check — submit, confirm the link lands; then attempt to
 *   override it directly and confirm it's ignored.
 */
let app: NestFastifyApplication;
let token: string;
let wsId: string;
let jobsDb: string;
let applicantsDb: string;
let jobFieldId: string; // relation on Applicants -> Jobs
let jobApiName: string;
let nameFieldId: string;
let sourceFieldId: string; // text
let sourceApiName: string;
let stageFieldId: string; // select
let stageApiName: string;
let openStageId: string;
let closedStageId: string;
let borderlandsJobId: string;
let otherJobId: string;
let otherWsCompaniesDb: string;
let crossWorkspaceRecordId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

async function findView(name: string) {
  const list = (await as('GET', `/workspaces/${wsId}/databases/${applicantsDb}`)).json().views;
  return list.find((v: { name: string }) => v.name === name);
}

async function saveFormFields(token_: string, fields: unknown[]) {
  const view = await findView('Applicant form');
  return as('PATCH', `/workspaces/${wsId}/databases/${applicantsDb}/views/${view.id}`, {
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: { access: 'public', public_token: token_, fields },
    },
  });
}

beforeAll(async () => {
  app = await createTestApp();
  const signup = await signUpUser(app, 'FormHidden');
  token = signup.token;
  wsId = (await as('POST', '/workspaces', { name: 'Hidden Fields WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  jobsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Jobs' })).json().id;
  applicantsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Applicants' })).json().id;

  const borderlands = await as('POST', `/workspaces/${wsId}/databases/${jobsDb}/records`, { values: { name: 'Borderlands Job' } });
  borderlandsJobId = borderlands.json().id;
  const other = await as('POST', `/workspaces/${wsId}/databases/${jobsDb}/records`, { values: { name: 'Other Job' } });
  otherJobId = other.json().id;

  const rel = await as('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: applicantsDb,
    database_b_id: jobsDb,
    cardinality: 'one_to_many',
    field_a_name: 'Job',
    field_b_name: 'Applicants',
  });
  jobFieldId = rel.json().field_a.id;
  jobApiName = rel.json().field_a.api_name ?? rel.json().field_a.apiName;

  const dbFields = (await as('GET', `/workspaces/${wsId}/databases/${applicantsDb}`)).json().fields as Array<{
    id: string; type: string; api_name: string;
  }>;
  nameFieldId = dbFields.find((f) => f.type === 'title' || f.api_name === 'name')!.id;

  const source = await as('POST', `/workspaces/${wsId}/databases/${applicantsDb}/fields`, {
    display_name: 'Source', type: 'text',
  });
  sourceFieldId = source.json().id;
  sourceApiName = source.json().api_name ?? source.json().apiName;

  const stage = await as('POST', `/workspaces/${wsId}/databases/${applicantsDb}/fields`, {
    display_name: 'Stage', type: 'select', options: [{ label: 'Open' }, { label: 'Closed' }],
  });
  stageFieldId = stage.json().id;
  stageApiName = stage.json().api_name ?? stage.json().apiName;
  const stageOptions = stage.json().options as Array<{ id: string; label: string }>;
  openStageId = stageOptions.find((o) => o.label === 'Open')!.id;
  closedStageId = stageOptions.find((o) => o.label === 'Closed')!.id;

  const view = await as('POST', `/workspaces/${wsId}/databases/${applicantsDb}/views`, {
    name: 'Applicant form',
    type: 'form',
    config: {
      sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {},
      form: { title: 'Apply', access: 'public', public_token: 'hidden-tok', fields: [{ field_id: nameFieldId }] },
    },
  });
  expect(view.statusCode, view.body).toBe(201);

  // A second, unrelated workspace + database, for the cross-workspace relation-target test.
  const otherSignup = await signUpUser(app, 'FormHiddenOther');
  const otherWs = await app.inject({
    method: 'POST', url: '/api/v1/workspaces', headers: authed(otherSignup.token), payload: { name: 'Other WS' } as never,
  });
  const otherWsId = otherWs.json().id;
  const otherSpaceId = (
    await app.inject({ method: 'GET', url: `/api/v1/workspaces/${otherWsId}/spaces`, headers: authed(otherSignup.token) })
  ).json()[0].id;
  const otherDb = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${otherWsId}/databases`, headers: authed(otherSignup.token),
    payload: { space_id: otherSpaceId, name: 'Companies' } as never,
  });
  otherWsCompaniesDb = otherDb.json().id;
  const crossRec = await app.inject({
    method: 'POST', url: `/api/v1/workspaces/${otherWsId}/databases/${otherWsCompaniesDb}/records`,
    headers: authed(otherSignup.token), payload: { values: { name: 'Not mine' } } as never,
  });
  crossWorkspaceRecordId = crossRec.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#716 — hidden form fields with a fixed value', () => {
  it('AC5: a form with no hidden fields behaves exactly as before', async () => {
    const res = await pub('POST', '/public/forms/hidden-tok', { values: { name: 'Plain Applicant' } });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('AC2: hidden + visible_when together is rejected as a config error', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: jobFieldId, hidden: true, value: borderlandsJobId, visible_when: { field_id: nameFieldId, op: 'not_empty' } },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('AC4: a relation fixed value naming a record in the WRONG database is rejected at config-save time', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: jobFieldId, hidden: true, value: crossWorkspaceRecordId },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('AC4: a relation fixed value naming a record that does not exist at all is rejected at config-save time', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: jobFieldId, hidden: true, value: '00000000-0000-0000-0000-000000000000' },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('AC4: a select fixed value that is not a real option id is rejected at config-save time', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: stageFieldId, hidden: true, value: 'Open' }, // a LABEL, not an option id
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('AC4: a hidden field on an out-of-scope type (number/date/etc.) is rejected — only relation/text/select/workflow', async () => {
    const number = await as('POST', `/workspaces/${wsId}/databases/${applicantsDb}/fields`, {
      display_name: 'Score', type: 'number',
    });
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: number.json().id, hidden: true, value: 42 },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('AC4: a text fixed value must be a string', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: sourceFieldId, hidden: true, value: 12345 },
    ]);
    expect(res.statusCode).toBe(422);
  });

  it('a valid hidden relation + text + select configuration saves cleanly', async () => {
    const res = await saveFormFields('hidden-tok', [
      { field_id: nameFieldId },
      { field_id: jobFieldId, hidden: true, value: borderlandsJobId },
      { field_id: sourceFieldId, hidden: true, value: 'careers-page-utm' },
      { field_id: stageFieldId, hidden: true, value: openStageId, required: true }, // AC3: required on hidden — must not block submission
    ]);
    expect(res.statusCode, res.body).toBe(200);
  });

  it("the public GET definition never exposes the hidden fields at all", async () => {
    const res = await pub('GET', '/public/forms/hidden-tok');
    expect(res.statusCode, res.body).toBe(200);
    const fieldIds = (res.json().fields as Array<{ field_id: string }>).map((f) => f.field_id);
    expect(fieldIds).toEqual([nameFieldId]);
  });

  it('AC3 + AC6 (first half): submitting with only the visible field succeeds and stamps every hidden fixed value', async () => {
    const res = await pub('POST', '/public/forms/hidden-tok', { values: { name: 'Borderlands Applicant' } });
    expect(res.statusCode, res.body).toBe(201);
    const record = await as('GET', `/workspaces/${wsId}/databases/${applicantsDb}/records/${res.json().id}`);
    const values = record.json().values;
    expect(values[sourceApiName]).toBe('careers-page-utm');
    expect(values[stageApiName]).toBe(openStageId);
    expect((values[jobApiName] as Array<{ id: string }>).map((c) => c.id)).toEqual([borderlandsJobId]);
  });

  it('AC1 + AC6 (second half, the one that PROVES AC1): a client-supplied value for a hidden field is ignored, not merged', async () => {
    const res = await pub('POST', '/public/forms/hidden-tok', {
      values: {
        name: 'Attacker Applicant',
        // Attempting to override every hidden field directly, keyed exactly
        // as a legitimate visible submission would be (by api_name).
        [jobApiName]: otherJobId,
        [sourceApiName]: 'forged-source',
        [stageApiName]: closedStageId,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const record = await as('GET', `/workspaces/${wsId}/databases/${applicantsDb}/records/${res.json().id}`);
    const values = record.json().values;
    // The real, stored fixed values won — not the attacker's.
    expect(values[sourceApiName]).toBe('careers-page-utm');
    expect(values[stageApiName]).toBe(openStageId);
    const jobIds = (values[jobApiName] as Array<{ id: string }>).map((c) => c.id);
    expect(jobIds).toEqual([borderlandsJobId]);
    expect(jobIds).not.toContain(otherJobId);
  });
});
