import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #909 / #908 surfaces 1 and 2 — a PUBLIC or PORTAL view's title is computed from the fields that share PUBLISHES, and nothing
 * else (Otto, 2026-10-14). Fixture (Vera's repro): Invoices' title is `concat("Invoice to ", {Cust Email})`, Cust Email a LOOKUP into
 * Customers. Share A publishes only `memo`; share B also publishes the lookup; a portal share is recipient-scoped (which exposes no
 * lookup at all). Projects has an own-record text input (`Code`) the share does not publish. Every assertion is on the served BODY.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, invoices: string, projects: string;
let invoiceId: string, projectId: string;
let lookupApi: string, memoApi: string, codeApi: string, ownerEmailApi: string;
let invoicesView: string, projectsView: string;
let orders: string, ordersView: string, ordersInvoiceApi: string, orderId: string;
const SECRET = 'ceo@zanzibar-secret.example';
const CODE = 'PX-1138-confidential';

const own = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(owner.token), payload: payload as never });
const pub = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });
const share = async (db: string, view: string, body: Record<string, unknown>) => {
  const res = await own('POST', `/workspaces/${ws}/databases/${db}/views/${view}/share`, body);
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res.json().token as string;
};
const titleOf = (body: { records: { data: Array<{ id: string; title: string }> } }, id: string) => body.records.data.find((r) => r.id === id)!.title;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'PT Owner');
  ws = (await own('POST', '/workspaces', { name: 'PT WS' })).json().id;
  const spaceA = (await own('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const spaceB = (await own('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  const customers = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'Customers' })).json().id;
  invoices = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Invoices' })).json().id;
  projects = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Projects' })).json().id;
  const email = (await own('POST', `/workspaces/${ws}/databases/${customers}/fields`, { display_name: 'Email', type: 'text' })).json();
  const rel = (await own('POST', `/workspaces/${ws}/relations`, { database_a_id: invoices, database_b_id: customers, cardinality: 'one_to_many', field_a_name: 'Customer', field_b_name: 'Invoices' })).json();
  const lookup = await own('POST', `/workspaces/${ws}/databases/${invoices}/fields`, { display_name: 'Cust Email', type: 'lookup', config: { relation_field_id: rel.field_a.id, target_field_api_name: email.apiName } });
  expect(lookup.statusCode, lookup.body).toBe(201);
  lookupApi = lookup.json().apiName;
  memoApi = (await own('POST', `/workspaces/${ws}/databases/${invoices}/fields`, { display_name: 'Memo', type: 'text' })).json().apiName;
  ownerEmailApi = (await own('POST', `/workspaces/${ws}/databases/${invoices}/fields`, { display_name: 'Owner Email', type: 'email' })).json().apiName;
  const titleField = (await own('GET', `/workspaces/${ws}/databases/${invoices}`)).json().fields.find((f: { type: string }) => f.type === 'title');
  expect((await own('PATCH', `/workspaces/${ws}/databases/${invoices}/fields/${titleField.id}`, { config: { name_mode: 'computed', source: 'concat("Invoice to ", {Cust Email})' } })).statusCode).toBe(200);
  const customerId = (await own('POST', `/workspaces/${ws}/databases/${customers}/records`, { values: { name: 'Zanzibar', [email.apiName]: SECRET } })).json().id;
  invoiceId = (await own('POST', `/workspaces/${ws}/databases/${invoices}/records`, { values: { [memoApi]: 'net 30', [ownerEmailApi]: 'client@portal.test' } })).json().id;
  expect((await own('PUT', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}/links/${rel.field_a.id}`, { record_ids: [customerId] })).statusCode).toBeLessThan(300);
  for (let i = 0; i < 60; i++) {
    if ((await own('GET', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}`)).json().title === `Invoice to ${SECRET}`) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  // Projects: computed title over an OWN-RECORD text field
  codeApi = (await own('POST', `/workspaces/${ws}/databases/${projects}/fields`, { display_name: 'Code', type: 'text' })).json().apiName;
  await own('POST', `/workspaces/${ws}/databases/${projects}/fields`, { display_name: 'Status', type: 'text' });
  const pTitle = (await own('GET', `/workspaces/${ws}/databases/${projects}`)).json().fields.find((f: { type: string }) => f.type === 'title');
  expect((await own('PATCH', `/workspaces/${ws}/databases/${projects}/fields/${pTitle.id}`, { config: { name_mode: 'computed', source: 'concat("Project ", {Code})' } })).statusCode).toBe(200);
  projectId = (await own('POST', `/workspaces/${ws}/databases/${projects}/records`, { values: { [codeApi]: CODE } })).json().id;
  // Orders -> Invoices: an Orders share that publishes the relation column carries a CHIP titled with the invoice
  orders = (await own('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Orders' })).json().id;
  const orel = (await own('POST', `/workspaces/${ws}/relations`, { database_a_id: orders, database_b_id: invoices, cardinality: 'one_to_many', field_a_name: 'Invoice', field_b_name: 'Orders' })).json();
  ordersInvoiceApi = (await own('GET', `/workspaces/${ws}/databases/${orders}`)).json().fields.find((f: { id: string }) => f.id === orel.field_a.id).apiName;
  orderId = (await own('POST', `/workspaces/${ws}/databases/${orders}/records`, { values: { name: 'Order 1' } })).json().id;
  expect((await own('PUT', `/workspaces/${ws}/databases/${orders}/records/${orderId}/links/${orel.field_a.id}`, { record_ids: [invoiceId] })).statusCode).toBeLessThan(300);
  ordersView = (await own('GET', `/workspaces/${ws}/databases/${orders}`)).json().views[0].id;
  invoicesView = (await own('GET', `/workspaces/${ws}/databases/${invoices}`)).json().views[0].id;
  projectsView = (await own('GET', `/workspaces/${ws}/databases/${projects}`)).json().views[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#909 public view: the title is computed from what the share publishes', () => {
  it('REPRODUCED: share publishing only `memo` — the lookup input is redacted ("Invoice to —"), not served in full', async () => {
    const token = await share(invoices, invoicesView, { visible_field_api_names: [memoApi] });
    const res = await pub(`/public/views/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(titleOf(body, invoiceId)).toBe('Invoice to —');
    for (const needle of [SECRET, 'zanzibar', 'secret.example']) expect(res.body, `body must not contain ${needle}`).not.toContain(needle);
  });

  it('an OWN-record input the share does not publish is redacted the same way', async () => {
    const token = await share(projects, projectsView, { visible_field_api_names: [] });
    const res = await pub(`/public/views/${token}`);
    expect(titleOf(res.json(), projectId)).toBe('Project —');
    expect(res.body).not.toContain(CODE);
  });

  it('MUST KEEP WORKING: a share that publishes every input shows the full title', async () => {
    const lookupShare = await share(invoices, invoicesView, { visible_field_api_names: [memoApi, lookupApi] });
    expect(titleOf((await pub(`/public/views/${lookupShare}`)).json(), invoiceId)).toBe(`Invoice to ${SECRET}`);
    const codeShare = await share(projects, projectsView, { visible_field_api_names: [codeApi] });
    expect(titleOf((await pub(`/public/views/${codeShare}`)).json(), projectId)).toBe(`Project ${CODE}`);
  });

  it('MUST KEEP WORKING: the owner still sees the full title everywhere (#884: per-caller, never rewritten)', async () => {
    expect((await own('GET', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}`)).json().title).toBe(`Invoice to ${SECRET}`);
  });

  it('the viewer cannot steer the output: search/filter/sort query params are ignored, so the redacted text is no oracle', async () => {
    const token = await share(invoices, invoicesView, { visible_field_api_names: [memoApi] });
    const plain = (await pub(`/public/views/${token}`)).json();
    for (const qs of ['q=zanzibar', 'search=zanzibar', 'filter=title~zanzibar', 'sort=title']) {
      const res = await pub(`/public/views/${token}?${qs}`);
      expect(res.statusCode).toBe(200);
      expect(res.json().records.data.map((r: { id: string }) => r.id), qs).toEqual(plain.records.data.map((r: { id: string }) => r.id));
      expect(res.body, qs).not.toContain('zanzibar');
    }
  });
});

describe('#909 relation chips on a share carry the target record\'s title — narrowed the same way', () => {
  it('a published relation column to a computed-title record shows the local title ("Invoice to —"), not the full one', async () => {
    const token = await share(orders, ordersView, { visible_field_api_names: [], include_relation_api_names: [ordersInvoiceApi] });
    const res = await pub(`/public/views/${token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body, 'the chip must still be there').toContain(invoiceId);
    for (const needle of [SECRET, 'zanzibar']) expect(res.body, `chip title must not contain ${needle}`).not.toContain(needle);
  });
});

describe('#909 portal view (recipient-scoped): no lookup is exposed, so a lookup input is always redacted', () => {
  it('a recipient sees "Invoice to —" for their own invoice, even if the allowlist names the lookup', async () => {
    const recipient = (await own('POST', `/workspaces/${ws}/portal-recipients`, { label: 'Client', email: 'client@portal.test' })).json();
    const token = await share(invoices, invoicesView, { recipient_scope_field_api_name: ownerEmailApi, visible_field_api_names: [memoApi, lookupApi] });
    const res = await pub(`/public/views/${token}?recipient=${recipient.token}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(titleOf(res.json(), invoiceId)).toBe('Invoice to —');
    expect(res.body).not.toContain('zanzibar');
  });
});
