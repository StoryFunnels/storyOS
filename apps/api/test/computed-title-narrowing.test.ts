import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { sql } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { RecordsService } from '../src/records/records.service';
import { authed, signUpUser } from './helpers/users';

/**
 * #884 — a COMPUTED record title is computed from what the caller may read, on every surface that carries it.
 *
 * Fixture (Vera's repro): Invoices' title is `concat("Invoice to ", {Cust Email})`, where Cust Email is a LOOKUP into
 * Customers, a database the reader has no access to. The lookup itself is correctly hidden; the title used to reprint
 * the hidden email in plaintext on the record, query rows, relation chips, search, recent, favourites, and history.
 *
 * Every assertion is on the response BODY (a status code cannot tell you whether a value leaked), for a GUEST and for a
 * token BOUND to the same two databases. The OWNER and a guest who CAN read Customers are the controls: they must still
 * see the full title everywhere (two callers seeing different titles for one record is deliberate).
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let guest: { token: string; email: string };
let insider: { token: string; email: string };
let boundToken: string;
let ws: string;
let customers: string;
let invoices: string;
let orders: string;
let invoiceId: string;
let invoiceNumber: number;
let orderId: string;
let customerId: string;
let linkFieldId: string; // Invoices' relation field to Customers
let orderInvoiceField: string; // api name of Orders' relation to Invoices

const SECRET = 'ceo@zanzibar-secret.example';
const LATER = 'cfo@renamed-secret.example';

const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const owned = (method: string, url: string, payload?: unknown) => inject(owner.token, method, url, payload);

async function pollOwnerTitle(expected: string) {
  let title = '';
  for (let i = 0; i < 60; i++) {
    title = (await owned('GET', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}`)).json().title;
    if (title === expected) return title;
    await new Promise((r) => setTimeout(r, 50));
  }
  return title;
}

async function join(user: { token: string; email: string }, grants: unknown[]) {
  const inv = await owned('POST', `/workspaces/${ws}/invites`, { email: user.email, role: 'guest', grants });
  expect(inv.statusCode, inv.body).toBe(201);
  const ok = await inject(user.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  expect(ok.statusCode, ok.body).toBe(201);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'CT Owner');
  guest = await signUpUser(app, 'CT Guest');
  insider = await signUpUser(app, 'CT Insider');
  ws = (await owned('POST', '/workspaces', { name: 'CT WS' })).json().id;
  const spaceA = (await owned('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  const spaceB = (await owned('POST', `/workspaces/${ws}/spaces`, { name: 'Back office' })).json().id;
  customers = (await owned('POST', `/workspaces/${ws}/databases`, { space_id: spaceB, name: 'Customers' })).json().id;
  invoices = (await owned('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Invoices' })).json().id;
  orders = (await owned('POST', `/workspaces/${ws}/databases`, { space_id: spaceA, name: 'Orders' })).json().id;
  const email = (await owned('POST', `/workspaces/${ws}/databases/${customers}/fields`, { display_name: 'Email', type: 'text' })).json();
  const rel = (await owned('POST', `/workspaces/${ws}/relations`, {
    database_a_id: invoices, database_b_id: customers, cardinality: 'one_to_many', field_a_name: 'Customer', field_b_name: 'Invoices',
  })).json();
  const custFieldId = rel.field_a.id as string;
  linkFieldId = custFieldId;
  const lookup = await owned('POST', `/workspaces/${ws}/databases/${invoices}/fields`, {
    display_name: 'Cust Email', type: 'lookup', config: { relation_field_id: custFieldId, target_field_api_name: email.apiName },
  });
  expect(lookup.statusCode, lookup.body).toBe(201);
  const titleField = (await owned('GET', `/workspaces/${ws}/databases/${invoices}`)).json().fields.find((f: { type: string }) => f.type === 'title');
  const computed = await owned('PATCH', `/workspaces/${ws}/databases/${invoices}/fields/${titleField.id}`, {
    config: { name_mode: 'computed', source: 'concat("Invoice to ", {Cust Email})' },
  });
  expect(computed.statusCode, computed.body).toBe(200);
  await owned('POST', `/workspaces/${ws}/databases/${invoices}/fields`, { display_name: 'Notes', type: 'text' });
  // Orders -> Invoices, so an Orders record carries a relation CHIP showing the invoice's title
  const orel = (await owned('POST', `/workspaces/${ws}/relations`, {
    database_a_id: orders, database_b_id: invoices, cardinality: 'one_to_many', field_a_name: 'Invoice', field_b_name: 'Orders',
  })).json();
  orderInvoiceField = 'invoice';

  customerId = (await owned('POST', `/workspaces/${ws}/databases/${customers}/records`, { values: { name: 'Zanzibar Holdings', [email.apiName]: SECRET } })).json().id;
  const inv = (await owned('POST', `/workspaces/${ws}/databases/${invoices}/records`, { values: {} })).json();
  invoiceId = inv.id;
  invoiceNumber = inv.number;
  const link = await owned('PUT', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}/links/${custFieldId}`, { record_ids: [customerId] });
  expect(link.statusCode, link.body).toBeLessThan(300);
  expect(await pollOwnerTitle(`Invoice to ${SECRET}`), 'the owner sees the full computed title').toBe(`Invoice to ${SECRET}`);
  orderId = (await owned('POST', `/workspaces/${ws}/databases/${orders}/records`, { values: { name: 'Order 1' } })).json().id;
  const olink = await owned('PUT', `/workspaces/${ws}/databases/${orders}/records/${orderId}/links/${orel.field_a.id}`, { record_ids: [invoiceId] });
  expect(olink.statusCode, olink.body).toBeLessThan(300);
  // the invoice MENTIONS the order in a rich_text field, so the order's backlinks list the invoice (title and all)
  const memo = (await owned('POST', `/workspaces/${ws}/databases/${invoices}/fields`, { display_name: 'Memo', type: 'rich_text' })).json();
  const mention = await owned('PATCH', `/workspaces/${ws}/databases/${invoices}/records/${invoiceId}`, {
    values: { [memo.apiName]: [{ type: 'paragraph', content: [{ type: 'mention', props: { kind: 'record', id: orderId, label: 'Order 1' } }] }] },
  });
  expect(mention.statusCode, mention.body).toBe(200);
  for (let i = 0; i < 60; i++) {
    const bl = (await owned('GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/backlinks`)).json();
    if ((bl.data as Array<{ id: string }>).some((b) => b.id === invoiceId)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  await join(guest, [{ database_id: invoices, role: 'editor' }, { database_id: orders, role: 'editor' }]);
  await join(insider, [{ database_id: invoices, role: 'editor' }, { database_id: orders, role: 'editor' }, { database_id: customers, role: 'viewer' }]);
  boundToken = (await owned('POST', '/me/tokens', { name: 'bound', workspace_id: ws, resource_scope: { database_ids: [invoices, orders] } })).json().token;
}, 240_000);

afterAll(async () => { await app.close(); });

const readers = () => [
  ['a guest', () => guest.token],
  ['a token bound to the same databases', () => boundToken],
] as const;
const iUrl = () => `/workspaces/${ws}/databases/${invoices}`;
const noSecret = (body: string, label: string) => {
  for (const needle of [SECRET, 'zanzibar', 'secret.example', LATER, 'renamed-secret']) expect(body, `${label} must not contain "${needle}"`).not.toContain(needle);
};

describe.each(readers())('#884 %s', (_name, tokenOf) => {
  it('record GET and query rows: the title is computed from what the reader may read ("Invoice to —"), NOT blanked', async () => {
    const one = await inject(tokenOf(), 'GET', `${iUrl()}/records/${invoiceId}`);
    expect(one.statusCode, one.body).toBe(200);
    expect(one.json().title).toBe('Invoice to —');
    noSecret(one.body, 'record GET');
    const q = await inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { limit: 50 });
    expect(q.json().data.find((r: { id: string }) => r.id === invoiceId).title).toBe('Invoice to —');
    noSecret(q.body, 'query rows');
    const list = await inject(tokenOf(), 'GET', `${iUrl()}/records?limit=50`);
    noSecret(list.body, 'list');
  });

  it('the relation CHIP on another readable record carries the narrowed title', async () => {
    const order = await inject(tokenOf(), 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}`);
    expect(order.statusCode, order.body).toBe(200);
    const chips = order.json().values[orderInvoiceField] as Array<{ id: string; title: string }>;
    expect(chips.find((c) => c.id === invoiceId)?.title).toBe('Invoice to —');
    noSecret(order.body, 'order GET (chip)');
    noSecret((await inject(tokenOf(), 'POST', `/workspaces/${ws}/databases/${orders}/records/query`, { limit: 50 })).body, 'order query chips');
  });

  it('`q` and a title FILTER cannot match text the reader cannot see: a search for the hidden substring answers exactly what a random string answers', async () => {
    const asked = (q: string) => inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { q, limit: 50 });
    const byteSame = (a: { statusCode: number; body: string }, b: { statusCode: number; body: string }) =>
      expect(`${a.statusCode} ${a.body.replace(/"request_id":"[^"]*"/g, '')}`).toBe(`${b.statusCode} ${b.body.replace(/"request_id":"[^"]*"/g, '')}`);
    byteSame(await asked('zanzibar'), await asked('qwxzvbkp'));
    byteSame(await asked('ceo@zanzibar'), await asked('qwxzvbkp'));
    byteSame(await asked('secret.example'), await asked('qwxzvbkp'));
    expect((await asked('Invoice')).json().data.map((r: { id: string }) => r.id)).toContain(invoiceId); // the visible part still matches
    const filtered = (v: string) => inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { filter: { field: 'name', op: 'contains', value: v }, limit: 50 });
    byteSame(await filtered('zanzibar'), await filtered('qwxzvbkp'));
    const listQ = (v: string) => inject(tokenOf(), 'GET', `${iUrl()}/records?q=${encodeURIComponent(v)}&limit=50`);
    byteSame(await listQ('zanzibar'), await listQ('qwxzvbkp'));
    const count = (v: string) => inject(tokenOf(), 'POST', `${iUrl()}/records/aggregate`, { op: 'count', q: v });
    byteSame(await count('zanzibar'), await count('qwxzvbkp'));
  });

  it('a sort by title does not order by, or put into its cursor, the hidden text', async () => {
    const page = await inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { sorts: [{ field: 'name', direction: 'asc' }], limit: 1 });
    noSecret(page.body, 'sorted page');
    const extra = (await owned('POST', `/workspaces/${ws}/databases/${invoices}/records`, { values: {} })).json();
    const again = await inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { sorts: [{ field: 'name', direction: 'asc' }], limit: 1 });
    const cursor = again.json().next_cursor as string | null;
    if (cursor) {
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
      noSecret(decoded, 'the cursor, decoded');
    }
    await owned('DELETE', `${iUrl()}/records/${extra.id}`);
  });

  it('global search: the hidden substring finds nothing, the visible part finds the record under its narrowed title', async () => {
    const hit = async (q: string) => inject(tokenOf(), 'GET', `/workspaces/${ws}/search?q=${encodeURIComponent(q)}`);
    for (const q of ['zanzibar', 'secret.example']) {
      const res = await hit(q);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().records, q).toEqual([]);
      noSecret(res.body, `search "${q}"`);
    }
    const ok = await hit('Invoice to');
    const row = (ok.json().records as Array<{ id: string; title: string }>).find((r) => r.id === invoiceId);
    expect(row?.title).toBe('Invoice to —');
    noSecret(ok.body, 'search "Invoice to"');
  });

  it('recent and favourites carry the narrowed title', async () => {
    // the reader touches the record (a write by the reader is what puts it in their recent list), and stars it
    const touched = await inject(tokenOf(), 'POST', `/workspaces/${ws}/databases/${orders}/records/${orderId}/comments`, { body: [{ type: 'text', text: 'looking at it' }] });
    expect(touched.statusCode, touched.body).toBeLessThan(300);
    const star = await inject(tokenOf(), 'POST', `/workspaces/${ws}/favorites`, { target_type: 'record', target_id: invoiceId });
    if (tokenOf() === guest.token) expect(star.statusCode, star.body).toBeLessThan(300);
    const favs = await inject(tokenOf(), 'GET', `/workspaces/${ws}/favorites`);
    noSecret(favs.body, 'favourites');
    if (tokenOf() === guest.token) expect(JSON.stringify(favs.json())).toContain('Invoice to —');
    const recent = await inject(tokenOf(), 'GET', `/workspaces/${ws}/recent`);
    noSecret(recent.body, 'recent');
  });

  it('a write response gives the writer their own narrowed title, not the stored one', async () => {
    const res = await inject(tokenOf(), 'PATCH', `${iUrl()}/records/${invoiceId}`, { values: { notes: 'touched' } });
    expect(res.statusCode, res.body).toBeLessThan(300);
    noSecret(res.body, 'PATCH response');
    expect(res.json().title === 'Invoice to —' || res.json().title === 'Invoice to', `the writer is served a safe title, got "${res.json().title}"`).toBe(true);
  });

  it('LIVE: the owner changes the hidden input and the reader\'s next read does NOT show the new value', async () => {
    const emailField = (await owned('GET', `/workspaces/${ws}/databases/${customers}`)).json().fields.find((f: { displayName: string }) => f.displayName === 'Email');
    const changed = await owned('PATCH', `/workspaces/${ws}/databases/${customers}/records/${customerId}`, { values: { [emailField.apiName]: LATER } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(await pollOwnerTitle(`Invoice to ${LATER}`), 'the owner sees the new value').toBe(`Invoice to ${LATER}`);
    const read = await inject(tokenOf(), 'GET', `${iUrl()}/records/${invoiceId}`);
    expect(read.json().title).toBe('Invoice to —');
    noSecret(read.body, 'the live re-read');
    noSecret((await inject(tokenOf(), 'POST', `${iUrl()}/records/query`, { limit: 50 })).body, 'the live re-query');
    noSecret((await inject(tokenOf(), 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}`)).body, 'the live chip');
    // put it back for the next test
    await owned('PATCH', `/workspaces/${ws}/databases/${customers}/records/${customerId}`, { values: { [emailField.apiName]: SECRET } });
    await pollOwnerTitle(`Invoice to ${SECRET}`);
  });
});

describe('#884 history is narrowed at READ time; the stored trail is untouched', () => {
  it('a guest\'s versions, field changes and activity carry no past computed title; the OWNER still sees the real prior values', async () => {
    const emailField = (await owned('GET', `/workspaces/${ws}/databases/${customers}`)).json().fields.find((f: { displayName: string }) => f.displayName === 'Email');
    // make the title change so history holds PAST computed titles, then edit the invoice so a version is captured
    await owned('PATCH', `/workspaces/${ws}/databases/${customers}/records/${customerId}`, { values: { [emailField.apiName]: LATER } });
    await pollOwnerTitle(`Invoice to ${LATER}`);
    await owned('PATCH', `${iUrl()}/records/${invoiceId}`, { values: { notes: 'edit one' } });
    await owned('PATCH', `${iUrl()}/records/${invoiceId}`, { values: { notes: 'edit two' } });
    const base = `${iUrl()}/records/${invoiceId}`;
    for (const path of ['/versions', '/versions/changes', '/activity']) {
      const res = await inject(guest.token, 'GET', `${base}${path}`);
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      noSecret(res.body, `guest ${path}`);
    }
    // the stored trail was NOT rewritten: the owner reads the real prior titles
    const ownerChanges = await owned('GET', `${base}/versions/changes`);
    expect(ownerChanges.body).toContain(SECRET);
    const ownerActivity = await owned('GET', `${base}/activity`);
    expect(ownerActivity.body).toContain(SECRET);
    // and the guest's version preview does not echo a past title either
    const versions = (await inject(guest.token, 'GET', `${base}/versions`)).json().data as Array<{ id: string; title: string }>;
    expect(versions.length).toBeGreaterThanOrEqual(1);
    for (const v of versions) {
      expect(v.title).toBe('—');
      noSecret(JSON.stringify(await inject(guest.token, 'GET', `${base}/versions/${v.id}`).then((r) => r.json())), `guest version ${v.id}`);
    }
    await owned('PATCH', `/workspaces/${ws}/databases/${customers}/records/${customerId}`, { values: { [emailField.apiName]: SECRET } });
    await pollOwnerTitle(`Invoice to ${SECRET}`);
  });

  it('the activity feed of ANOTHER record that links to the invoice shows its narrowed title, not the frozen full one', async () => {
    const res = await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/activity`);
    expect(res.statusCode, res.body).toBe(200);
    noSecret(res.body, 'orders activity');
  });
});

describe('#884 MUST KEEP WORKING: anyone who CAN read the inputs still sees the full computed title, everywhere', () => {
  it('the owner, and a guest with access to Customers, see "Invoice to <email>" on the record, the chip, search and query', async () => {
    for (const token of [owner.token, insider.token]) {
      const one = await inject(token, 'GET', `${iUrl()}/records/${invoiceId}`);
      expect(one.json().title, 'record').toBe(`Invoice to ${SECRET}`);
      const q = await inject(token, 'POST', `${iUrl()}/records/query`, { q: 'zanzibar', limit: 50 });
      expect(q.json().data.map((r: { id: string }) => r.id), 'q matches the full title for a reader of the inputs').toContain(invoiceId);
      const chip = (await inject(token, 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}`)).json().values[orderInvoiceField];
      expect(chip.find((c: { id: string }) => c.id === invoiceId).title, 'chip').toBe(`Invoice to ${SECRET}`);
      const s = await inject(token, 'GET', `/workspaces/${ws}/search?q=zanzibar`);
      expect((s.json().records as Array<{ id: string }>).map((r) => r.id), 'search').toContain(invoiceId);
    }
  });
});

describe.each(readers())('#884 %s: the remaining title exits', (_name, tokenOf) => {
  it('backlinks ("Mentioned in") list the mentioning invoice under its narrowed title', async () => {
    const res = await inject(tokenOf(), 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/backlinks`);
    // a database-bound token cannot reach this route at all (not ResourceScopable): refused, and the body leaks nothing
    if (_name.startsWith('a token')) { expect(res.statusCode, res.body).toBe(403); noSecret(res.body, 'bound backlinks'); return; }
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json().data as Array<{ id: string; title: string }>).find((b) => b.id === invoiceId);
    expect(row?.title, 'the mentioning record is listed, with the narrowed title').toBe('Invoice to —');
    noSecret(res.body, 'backlinks');
  });

  it('the links list of a relation field carries the narrowed title', async () => {
    const res = await inject(tokenOf(), 'GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/links/${orderInvoiceField}`);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json().data as Array<{ id: string; title: string }>).find((l) => l.id === invoiceId)?.title).toBe('Invoice to —');
    noSecret(res.body, 'links list');
  });

  it('the CSV export prints the narrowed title', async () => {
    const res = await inject(tokenOf(), 'GET', `${iUrl()}/export/csv`);
    if (_name.startsWith('a token')) { expect(res.statusCode, res.body).toBe(403); noSecret(res.body, 'bound CSV'); return; }
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Invoice to —');
    noSecret(res.body, 'CSV export');
  });
});

describe('#884 the owner still sees the full title on the same exits', () => {
  it('backlinks, links list and CSV export', async () => {
    const bl = await owned('GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/backlinks`);
    expect((bl.json().data as Array<{ id: string; title: string }>).find((b) => b.id === invoiceId)?.title).toBe(`Invoice to ${SECRET}`);
    const links = await owned('GET', `/workspaces/${ws}/databases/${orders}/records/${orderId}/links/${orderInvoiceField}`);
    expect((links.json().data as Array<{ id: string; title: string }>).find((l) => l.id === invoiceId)?.title).toBe(`Invoice to ${SECRET}`);
    expect((await owned('GET', `${iUrl()}/export/csv`)).body).toContain(SECRET);
  });
});

describe('#884 backfillLocalTitles repairs rows that predate title_local', () => {
  it('a NULL title_local reads as "#<number>" until the backfill runs, then as the computed local title', async () => {
    const db = app.get(DB) as Db;
    await db.execute(sql`update records set title_local = null where id = ${invoiceId}`);
    const before = await inject(guest.token, 'GET', `${iUrl()}/records/${invoiceId}`);
    expect(before.json().title, 'unbackfilled: falls back to the number, never to the full title').toBe(`#${invoiceNumber}`);
    noSecret(before.body, 'unbackfilled guest read');
    const result = await app.get(RecordsService).backfillLocalTitles();
    expect(result.records).toBeGreaterThanOrEqual(1);
    const after = await inject(guest.token, 'GET', `${iUrl()}/records/${invoiceId}`);
    expect(after.json().title).toBe('Invoice to —');
    expect((await owned('GET', `${iUrl()}/records/${invoiceId}`)).json().title, 'the stored full title was not rewritten').toBe(`Invoice to ${SECRET}`);
    expect((await app.get(RecordsService).backfillLocalTitles()).records, 'idempotent: nothing left to do').toBe(0);
  });
});

describe('#884 notifications name their record by title: narrowed for a guest, in full for a reader of the inputs', () => {
  it('assigned and commented notifications carry "Invoice to —" for the guest and the full title for the insider', async () => {
    const ownerField = (await owned('POST', `${iUrl()}/fields`, { display_name: 'Assignee', type: 'user' })).json();
    const guestId = (await inject(guest.token, 'GET', '/me')).json().id;
    const insiderId = (await inject(insider.token, 'GET', '/me')).json().id;
    // both are assigned (assignment notifies the added user) and both comment, so the owner's next comment notifies both
    for (const [id, token] of [[guestId, guest.token], [insiderId, insider.token]] as const) {
      const res = await owned('PATCH', `${iUrl()}/records/${invoiceId}`, { values: { [ownerField.apiName]: id } });
      expect(res.statusCode, res.body).toBe(200);
      const c = await inject(token, 'POST', `${iUrl()}/records/${invoiceId}/comments`, { body: [{ type: 'text', text: 'ping' }] });
      expect(c.statusCode, c.body).toBeLessThan(300);
    }
    await owned('POST', `${iUrl()}/records/${invoiceId}/comments`, { body: [{ type: 'text', text: 'pong' }] });
    const titles = async (token: string) => {
      const res = await inject(token, 'GET', `/workspaces/${ws}/notifications`);
      expect(res.statusCode, res.body).toBe(200);
      return { body: res.body, rows: (res.json().data as Array<{ type: string; record: { id: string; title: string } | null }>).filter((n) => n.record?.id === invoiceId) };
    };
    const g = await titles(guest.token);
    expect(g.rows.map((n) => n.type), 'the guest was notified (else this proves nothing)').toEqual(expect.arrayContaining(['assigned']));
    for (const n of g.rows) expect(n.record!.title).toBe('Invoice to —');
    noSecret(g.body, 'guest notifications');
    const i = await titles(insider.token);
    expect(i.rows.length).toBeGreaterThan(0);
    for (const n of i.rows) expect(n.record!.title).toBe(`Invoice to ${SECRET}`);
  });
});
