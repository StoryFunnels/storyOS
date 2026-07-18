import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Public-form relation + user inputs (#224 — forms builder polish). Extends the
 * MN-101 public form path: a form can now expose a `relation` field (record
 * picker + inline create-new, scoped through the token) and a `user` field
 * (people picker over the workspace roster, id + name only — no email/PII).
 */
let app: NestFastifyApplication;
let token: string;
let wsId: string;
let ownerId: string;
let ownerName: string;
let leadsDb: string;
let companiesDb: string;
let nameFieldId: string;
let companyFieldId: string; // relation on Leads -> Companies
let ownerFieldId: string; // user field on Leads
let acmeId: string;
let formToken: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
/** Unauthenticated request — the public form path. */
async function pub(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  const signup = await signUpUser(app, 'FormRelUser');
  token = signup.token;
  wsId = (await as('POST', '/workspaces', { name: 'Rel Forms WS' })).json().id;
  const me = await as('GET', '/me');
  ownerId = me.json().id;
  ownerName = me.json().name;

  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  companiesDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Companies' })).json().id;
  leadsDb = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;

  acmeId = (await as('POST', `/workspaces/${wsId}/databases/${companiesDb}/records`, { values: { name: 'Acme Inc' } })).json().id;

  const leadFields = (await as('GET', `/workspaces/${wsId}/databases/${leadsDb}`)).json().fields as Array<{ id: string; type: string; api_name: string }>;
  nameFieldId = leadFields.find((f) => f.type === 'title' || f.api_name === 'name')!.id;

  const rel = await as('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: leadsDb,
    database_b_id: companiesDb,
    cardinality: 'one_to_many',
    field_a_name: 'Company',
    field_b_name: 'Leads',
  });
  expect(rel.statusCode, rel.body).toBe(201);
  companyFieldId = rel.json().field_a.id;

  ownerFieldId = (await as('POST', `/workspaces/${wsId}/databases/${leadsDb}/fields`, { display_name: 'Owner', type: 'user' })).json().id;

  formToken = 'rel-user-tok';
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
        fields: [
          { field_id: nameFieldId, required: true },
          { field_id: companyFieldId },
          { field_id: ownerFieldId },
        ],
      },
    },
  });
  expect(view.statusCode, view.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('public form relation + user inputs (#224)', () => {
  it('exposes relation target info and the member roster (name only, no email) in the definition', async () => {
    const res = await pub('GET', `/public/forms/${formToken}`);
    expect(res.statusCode, res.body).toBe(200);
    const def = res.json();
    const companyField = def.fields.find((f: { field_id: string }) => f.field_id === companyFieldId);
    expect(companyField).toMatchObject({
      type: 'relation',
      relation: { target_database_id: companiesDb, target_database_name: 'Companies', single: true },
    });

    const ownerField = def.fields.find((f: { field_id: string }) => f.field_id === ownerFieldId);
    expect(ownerField.type).toBe('user');
    expect(ownerField.members).toEqual([{ id: ownerId, name: ownerName }]);
    // Conservative PII: no email leaks through the public roster.
    expect(JSON.stringify(ownerField.members)).not.toContain('@');
    // single-pick — the renderer must submit a bare id, not an array (below).
    expect(ownerField.multi).toBe(false);
  });

  it('rejects an array value for a non-multi user field (422) — the exact shape the write path enforces', async () => {
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { name: 'Bad Owner Shape', owner: [ownerId] },
    });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('a guest can search candidate records for the relation field, scoped to the target database', async () => {
    const res = await pub('GET', `/public/forms/${formToken}/relations/${companyFieldId}?q=Acme`);
    expect(res.statusCode, res.body).toBe(200);
    const results = res.json();
    expect(results).toEqual([{ id: acmeId, title: 'Acme Inc', number: expect.any(Number) }]);
  });

  it('a guest cannot search through a field the form does not expose', async () => {
    const res = await pub('GET', `/public/forms/${formToken}/relations/${nameFieldId}`);
    expect(res.statusCode).toBe(404);
  });

  it('a guest can create a new linked record inline (title only)', async () => {
    const res = await pub('POST', `/public/forms/${formToken}/relations/${companyFieldId}`, { title: 'Globex Corp' });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created.title).toBe('Globex Corp');

    // Anonymous author — same trust level as the main submit path.
    const rows = (await as('POST', `/workspaces/${wsId}/databases/${companiesDb}/records/query`, { limit: 50 })).json().data as Array<{
      id: string;
      created_by: string | null;
    }>;
    const row = rows.find((r) => r.id === created.id);
    expect(row?.created_by ?? null).toBeNull();
  });

  it('a full submission links the relation and stamps the user field, anonymously', async () => {
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { name: 'Wile E. Coyote', company: [acmeId], owner: ownerId },
    });
    expect(res.statusCode, res.body).toBe(201);

    const rows = (await as('POST', `/workspaces/${wsId}/databases/${leadsDb}/records/query`, { limit: 50 })).json().data as Array<{
      title: string;
      created_by: string | null;
      values: Record<string, unknown>;
    }>;
    const row = rows.find((r) => r.title === 'Wile E. Coyote');
    expect(row, 'the guest submission must have created a record').toBeTruthy();
    expect(row!.created_by, 'a public submit must have no author').toBeNull();
    expect(row!.values.owner).toBe(ownerId);
  });

  it('rejects an unresolvable relation target on submit (422) — no silent drop of a bad link', async () => {
    const res = await pub('POST', `/public/forms/${formToken}`, {
      values: { name: 'Bad Link', company: ['00000000-0000-0000-0000-000000000000'] },
    });
    expect(res.statusCode, res.body).toBe(422);
  });
});
