import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #501 — a relation field's picker had no way to narrow which target-database
 * records appear. Scope decision (Ievgen): a relation-picker FILTER, reusing
 * the existing view-filter AST, compiled against the relation's TARGET
 * database — not a new "select with live options" field type.
 */
let app: NestFastifyApplication;
let token: string;
let wsId: string;
let companiesDb: string;
let leadsDb: string;
let industryFieldId: string;
let techOptionId: string;
let retailOptionId: string;
let companyFieldId: string; // relation on Leads -> Companies
let acmeId: string; // Industry: Tech
let globexId: string; // Industry: Retail
let formToken: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

async function setFormFilter(filter: unknown) {
  const view = (await as('GET', `/workspaces/${wsId}/databases/${leadsDb}`)).json().views.find((v: { name: string }) => v.name === 'Lead form');
  const res = await as('PATCH', `/workspaces/${wsId}/databases/${leadsDb}/views/${view.id}`, {
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: {
        access: 'public',
        public_token: formToken,
        fields: [{ field_id: companyFieldId, relation_filter: filter }],
      },
    },
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  app = await createTestApp();
  const signup = await signUpUser(app, 'FormRelFilter');
  token = signup.token;
  wsId = (await as('POST', '/workspaces', { name: 'Rel Filter Forms WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  companiesDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  leadsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;

  const industry = await as('POST', `/workspaces/${wsId}/databases/${companiesDb}/fields`, {
    display_name: 'Industry',
    type: 'select',
    options: [{ label: 'Tech' }, { label: 'Retail' }],
  });
  industryFieldId = industry.json().apiName;
  const industryOptions = industry.json().options as Array<{ id: string; label: string }>;
  techOptionId = industryOptions.find((o) => o.label === 'Tech')!.id;
  retailOptionId = industryOptions.find((o) => o.label === 'Retail')!.id;

  const acme = await as('POST', `/workspaces/${wsId}/databases/${companiesDb}/records`, {
    values: { name: 'Acme Inc', industry: techOptionId },
  });
  acmeId = acme.json().id;
  const globex = await as('POST', `/workspaces/${wsId}/databases/${companiesDb}/records`, {
    values: { name: 'Globex Corp', industry: retailOptionId },
  });
  globexId = globex.json().id;

  const rel = await as('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: leadsDb,
    database_b_id: companiesDb,
    cardinality: 'one_to_many',
    field_a_name: 'Company',
    field_b_name: 'Leads',
  });
  companyFieldId = rel.json().field_a.id;

  formToken = 'rel-filter-tok';
  const view = await as('POST', `/workspaces/${wsId}/databases/${leadsDb}/views`, {
    name: 'Lead form',
    type: 'form',
    config: {
      sorts: [],
      hidden_field_ids: [],
      card_field_ids: [],
      column_widths: {},
      form: {
        title: 'New lead',
        access: 'public',
        public_token: formToken,
        fields: [{ field_id: companyFieldId }],
      },
    },
  });
  expect(view.statusCode, view.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('public form relation-picker filter (#501)', () => {
  it('with no filter, both companies are candidates (baseline)', async () => {
    const res = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual([acmeId, globexId].sort());
  });

  it('a stored filter narrows the candidates to only matching TARGET-database records', async () => {
    await setFormFilter({ field: industryFieldId, op: 'eq', value: techOptionId });
    const res = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual([{ id: acmeId, title: 'Acme Inc', number: expect.any(Number) }]);
  });

  it('the filter combines with the q title search, not replaces it', async () => {
    await setFormFilter({ field: industryFieldId, op: 'eq', value: retailOptionId });
    // Matches the filter but not the query text.
    const miss = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}?q=Acme`);
    expect(miss.statusCode, miss.body).toBe(200);
    expect(miss.json()).toEqual([]);
    // Matches both.
    const hit = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}?q=Globex`);
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json()).toEqual([{ id: globexId, title: 'Globex Corp', number: expect.any(Number) }]);
  });

  it('a filter referencing a field the target database no longer has degrades to no-op rather than 500ing a public visitor', async () => {
    await setFormFilter({ field: 'does_not_exist_anymore', op: 'eq', value: 'x' });
    const res = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual([acmeId, globexId].sort());
  });

  it('inline create-new is unaffected by the filter — still title-only, no filter applied', async () => {
    await setFormFilter({ field: industryFieldId, op: 'eq', value: techOptionId });
    const res = await pub('POST', `/public/forms/${formToken}/relations/${companyFieldId}`, { title: 'Initech LLC' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().title).toBe('Initech LLC');
  });

  /**
   * Vera's finding on PR #607 — the filter narrowed the SEARCH endpoint only.
   * A crafted submit naming a filtered-out id directly (skipping the search
   * step entirely) went straight through. Reproduces her exact repro:
   * filter = Industry=Tech, anonymous POST submits Globex (Retail) directly.
   */
  it('rejects a direct submit naming a relation id the stored filter excludes (#607 security bypass)', async () => {
    await setFormFilter({ field: industryFieldId, op: 'eq', value: techOptionId });
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { company: [globexId] },
    });
    expect(res.statusCode, res.body).toBe(422);
    const before = await as('GET', `/workspaces/${wsId}/databases/${companiesDb}/records/${globexId}`);
    // No lead was linked to Globex — the rejected submission created nothing.
    expect(before.statusCode).toBe(200);
  });

  it('accepts a direct submit naming a relation id that DOES satisfy the stored filter', async () => {
    await setFormFilter({ field: industryFieldId, op: 'eq', value: techOptionId });
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { company: [acmeId] },
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a filter referencing a field the target database no longer has does not block submission (same degrade as search)', async () => {
    await setFormFilter({ field: 'does_not_exist_anymore', op: 'eq', value: 'x' });
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { company: [globexId] },
    });
    expect(res.statusCode, res.body).toBe(201);
  });
});
