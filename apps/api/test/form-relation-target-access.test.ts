import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #1071 — the forms twin of #941. A public form's relation picker (`/public/forms/:token/relations/:fieldId`) lists the
 * ids and titles of records in the relation's TARGET database to anyone with the link. Saving a form checked only that
 * the field belongs to the form's own database, so a guest with `editor` on database A could publish a form exposing
 * A's relation to database B — which they hold no grant on — and every anonymous visitor could list B.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let guest: { token: string; email: string };
let ws: string;
let srcDb: string;
let tgtDb: string;
let nameFieldId: string;
let relFieldId: string;
let relApi: string;
let secretId: string;
const SECRET = 'Acquisition target: Zanzibar Holdings';

const inject = (token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });

const formConfig = (fieldIds: string[], access: 'members' | 'link' | 'public' = 'public') => ({
  sorts: [],
  hidden_field_ids: [],
  card_field_ids: [],
  column_widths: {},
  form: { title: 'Intake', access, fields: fieldIds.map((field_id) => ({ field_id })) },
});
const createForm = (token: string, fieldIds: string[], access?: 'members' | 'link' | 'public') =>
  inject(token, 'POST', `/workspaces/${ws}/databases/${srcDb}/views`, { name: 'Intake form', type: 'form', config: formConfig(fieldIds, access) });
const updateForm = (token: string, viewId: string, fieldIds: string[], access?: 'members' | 'link' | 'public') =>
  inject(token, 'PATCH', `/workspaces/${ws}/databases/${srcDb}/views/${viewId}`, { config: formConfig(fieldIds, access) });
const pickerOf = async (token: string) => inject(null, 'GET', `/public/forms/${token}/relations/${relFieldId}`);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Form Owner');
  guest = await signUpUser(app, 'Form Guest');
  ws = (await inject(owner.token, 'POST', '/workspaces', { name: 'Form Rel WS' })).json().id;
  const open = (await inject(owner.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const closed = (await inject(owner.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'Board only' })).json().id;
  srcDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: open, name: 'Client tasks' })).json().id;
  tgtDb = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases`, { space_id: closed, name: 'Deals' })).json().id;
  const rel = await inject(owner.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: srcDb, database_b_id: tgtDb, cardinality: 'one_to_many', field_a_name: 'Deal' });
  expect(rel.statusCode, rel.body).toBe(201);
  relFieldId = rel.json().field_a.id;
  secretId = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${tgtDb}/records`, { values: { name: SECRET } })).json().id;
  const detail = (await inject(owner.token, 'GET', `/workspaces/${ws}/databases/${srcDb}`)).json();
  type F = { id: string; type: string; apiName?: string; api_name?: string };
  nameFieldId = detail.fields.find((f: F) => f.type === 'title' || (f.apiName ?? f.api_name) === 'name').id;
  const relField = detail.fields.find((f: F) => f.id === relFieldId);
  relApi = relField.apiName ?? relField.api_name;
  const inv = await inject(owner.token, 'POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ database_id: srcDb, role: 'editor' }] });
  expect(inv.statusCode, inv.body).toBe(201);
  expect((await inject(guest.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! })).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('a public form can expose a relation only if its publisher can read the target (#1071)', () => {
  it('a GUEST with editor on the source but NO grant on the target cannot create a public form with the relation', async () => {
    const res = await createForm(guest.token, [nameFieldId, relFieldId]);
    // on main this saved and minted a token; what an anonymous visitor then lists is the evidence
    const leaked = res.statusCode === 201 ? (await pickerOf(res.json().config.form.public_token)).body : '';
    expect(res.statusCode, `form saved; anonymous picker served: ${leaked}`).toBe(422);
    expect(res.body).not.toContain(SECRET);
  });

  it('nor publish an existing members-only form that carries the relation, and the form stays unpublished', async () => {
    const draft = await createForm(guest.token, [nameFieldId, relFieldId], 'members');
    expect(draft.statusCode, draft.body).toBe(201);
    const res = await updateForm(guest.token, draft.json().id, [nameFieldId, relFieldId], 'link');
    const leaked = res.statusCode === 200 ? (await pickerOf(res.json().config.form.public_token)).body : '';
    expect(res.statusCode, `form published; anonymous picker served: ${leaked}`).toBe(422);
    const views = (await inject(owner.token, 'GET', `/workspaces/${ws}/databases/${srcDb}`)).json().views as Array<{ id: string; config: { form?: { public_token?: string } } }>;
    expect(views.find((v) => v.id === draft.json().id)!.config.form?.public_token).toBeUndefined();
  });

  it('the guest CAN publish a form over their own data (no relation)', async () => {
    const res = await createForm(guest.token, [nameFieldId]);
    expect(res.statusCode, res.body).toBe(201);
    expect((await inject(null, 'GET', `/public/forms/${res.json().config.form.public_token}`)).statusCode).toBe(200);
  });

  it('MUST KEEP WORKING: an admin publishes the relation; the picker serves options and a linked submission is accepted', async () => {
    const res = await createForm(owner.token, [nameFieldId, relFieldId]);
    expect(res.statusCode, res.body).toBe(201);
    const token = res.json().config.form.public_token as string;
    const picker = await pickerOf(token);
    expect(picker.statusCode, picker.body).toBe(200);
    expect(picker.json()).toEqual([{ id: secretId, title: SECRET, number: expect.any(Number) }]);
    const submit = await inject(null, 'POST', `/public/forms/${token}`, { values: { name: 'Linked lead', [relApi]: [secretId] } });
    expect(submit.statusCode, submit.body).toBe(201);
    const rows = (await inject(owner.token, 'POST', `/workspaces/${ws}/databases/${srcDb}/records/query`, { limit: 50 })).json().data as Array<{ id: string; title: string }>;
    const row = rows.find((r) => r.title === 'Linked lead')!;
    expect(row).toBeTruthy();
    const linked = (await inject(owner.token, 'GET', `/workspaces/${ws}/databases/${srcDb}/records/${row.id}`)).json();
    expect(JSON.stringify(linked)).toContain(secretId);

    // ...and the guest may still edit the admin's published form (the relation was not newly exposed by them).
    const edit = await updateForm(guest.token, res.json().id, [relFieldId, nameFieldId]);
    expect(edit.statusCode, edit.body).toBe(200);
  });

  it('a guest who DOES hold a grant on the target can publish the relation', async () => {
    await inject(owner.token, 'POST', `/workspaces/${ws}/grants`, { user_id: (await inject(guest.token, 'GET', '/me')).json().id, database_id: tgtDb, role: 'viewer' });
    const res = await createForm(guest.token, [nameFieldId, relFieldId]);
    expect(res.statusCode, res.body).toBe(201);
    expect((await pickerOf(res.json().config.form.public_token)).json()).toEqual([{ id: secretId, title: SECRET, number: expect.any(Number) }]);
  });
});
