import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { creatableFieldTypeSchema, packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY, toPublicPreview } from '../src/packs/registry';
import { boardGroupError } from '../src/views/views.service';
import { AutomationsService } from '../src/automations/automations.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { call, joinAs } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1322 - the Shop OS pack: four databases, three links, four views, one automation, one agent with two status triggers, and 27 sample
 * records. Checked against the COMPLETE field lists, not a sample of them, and the money is checked on the sample orders.
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'shop-os')!;
const AGENT = 'Order Update Drafter';
const STATUSES = ['New', 'Packing', 'Shipped', 'Delivered', 'Cancelled'];

const { pool } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown, token?: string) => call(app, token ?? owner.token, method, url, payload);
const newWs = async (n: string) => (await as('POST', '/workspaces', { name: `${n} ${Date.now()}` })).json().id as string;

interface Opt { id: string; label: string; color?: string; category?: string | null }
interface Fld { id: string; displayName: string; apiName: string; type: string; options?: Opt[]; config?: Record<string, unknown> }
interface View { id: string; name: string; type: string; isDefault: boolean; config: Record<string, unknown> }
type Detail = { id: string; fields: Fld[]; views: View[] };
type Row = { id: string; title: string; values: Record<string, unknown> };
const dbsOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>).filter((d) => d.name !== 'Members');
const detail = async (ws: string, name: string) => {
  const db = (await dbsOf(ws)).find((d) => d.name === name)!;
  return (await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json() as Detail;
};
const rows = async (ws: string, dbId: string, body: unknown = { limit: 200 }) =>
  ((await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, body)).json().data ?? []) as Row[];
const field = (d: Detail, name: string) => d.fields.find((f) => f.displayName === name)!;
const optId = (d: Detail, f: string, label: string) => field(d, f).options!.find((o) => o.label === label)!.id;
const optLabel = (d: Detail, f: string, id: unknown) => field(d, f).options!.find((o) => o.id === id)?.label;
const install = (ws: string, body: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest, ...body });
const triggerLabel = (status: string) => `${AGENT} ← Orders.Status = ${status}`;
const dayStr = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const titleOf = (name: string) => `${name} (sample)`;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Shop OS Owner');
}, 240_000);
afterAll(async () => {
  await app.close();
  await pool.end();
});

/** Every field of every database the pack declares. The title ("Name") is not listed. */
const SPEC_FIELDS: Record<string, Record<string, string>> = {
  Customers: { Email: 'email', Phone: 'text', City: 'text', 'Customer Since': 'date', Notes: 'text', Orders: 'relation', 'Orders Placed': 'rollup' },
  Products: { SKU: 'text', Price: 'number', 'In Stock': 'number', Category: 'select', Active: 'checkbox', 'Order Lines': 'relation' },
  Orders: {
    Customer: 'relation', Status: 'select', 'Payment Status': 'select', 'Payment Method': 'select', 'Ordered On': 'date', 'Paid On': 'date', Owner: 'user',
    'Delivery Notes': 'text', Lines: 'relation', Total: 'rollup',
  },
  'Order Lines': { Order: 'relation', Product: 'relation', Quantity: 'number', 'Unit Price': 'number', 'Line Amount': 'formula' },
};
/** What the sample orders add up to, worked out by hand from the manifest's lines (the tests below compare the INSTALLED rollups to these). */
const TOTALS: Record<string, number> = {
  'Order 1001': 2 * 24 + 18,
  'Order 1002': 85,
  'Order 1003': 3 * 16 + 2 * 9,
  'Order 1004': 2 * 12 + 16,
  'Order 1005': 4 * 18 + 2 * 24,
  'Order 1006': 5 * 9,
};

describe('#1322 the manifest', () => {
  const m = entry?.manifest;

  it('is registered and valid, and the registry entry has the packs.json shape', () => {
    expect(entry, 'shop-os is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(m).success).toBe(true);
    expect(entry.slug).toBe('shop-os');
    expect(entry.name).toBe('Shop OS');
    expect(entry.summary).toBe('Customers, products and orders for a small shop: an order board by status, the orders still unpaid, and a drafter for shipping and delivery messages.');
    expect(entry.highlights).toEqual([
      'Customers, Products, Orders and Order Lines, fully linked',
      'An order board: New → Packing → Shipped → Delivered, with Cancelled',
      'Order totals that add up from the line items, and an Unpaid Orders view',
      'An "Order Update Drafter" agent drafts shipping and delivery messages for you to send: gated, your call to run it',
      'Notifies you when an order’s status changes',
    ]);
    expect(m.requires).toEqual({ connections: [], ai: 'byo' });
    expect(toPublicPreview(entry).contents).toEqual({
      databases: ['Customers', 'Products', 'Orders', 'Order Lines'],
      views: ['Order Board', 'Unpaid Orders', 'Customers', 'Catalog'],
      automations: ['Notify on order status change'],
      agents: [AGENT],
      skills: [],
    });
  });

  it('is a pack of its own: it needs no other pack, and it does not reuse Agency OS\'s or Deal Desk\'s database names', () => {
    expect(m.requires.packs ?? []).toEqual([]);
    const names = m.databases.map((d) => d.name);
    for (const taken of ['Clients', 'Contacts', 'Projects', 'Tasks', 'Invoices', 'Accounts', 'Deals', 'Quotes', 'Quote Lines', 'Activities', 'Leads']) {
      expect(names, taken).not.toContain(taken);
    }
  });

  it('uses only field types that exist (the creatable enum), and a text Phone', () => {
    const allowed = new Set<string>(creatableFieldTypeSchema.options);
    const types = m.databases.flatMap((d) => d.fields.map((f) => [`${d.name}.${f.name}`, f.type] as const));
    expect(types.length).toBeGreaterThan(15);
    for (const [name, type] of types) expect(allowed.has(type), `${name}: ${type}`).toBe(true);
    for (const d of m.derived_fields) expect(['rollup', 'lookup', 'button'], d.name).toContain(d.type);
    expect(m.databases.find((d) => d.name === 'Customers')!.fields.find((f) => f.name === 'Phone')!.type).toBe('text');
  });

  it('the agent: own AI, every record write held, drafts only, one trigger per status it writes for (the instructions carry every guardrail)', () => {
    const a = m.agents[0]!;
    expect(m.agents).toHaveLength(1);
    expect(a.name).toBe(AGENT);
    expect(a.ai_mode).toBe('your_own_ai');
    expect(a.scopes).toEqual(['read', 'write']);
    expect(a.approval_policy).toEqual(['email', 'outward']);
    expect(m.triggers.map((t) => `${t.database}.${t.state_field}=${t.state_option}`)).toEqual(['Orders.Status=Shipped', 'Orders.Status=Delivered']);
    expect(m.triggers.every((t) => t.agent === AGENT && t.human_gate === false)).toBe(true);
    // no `database` on the gate: EVERY create and update the agent attempts waits for a person, so "never changes the order" is StoryOS's word too
    expect(a.write_gates).toEqual([{ operations: ['create', 'update'] }]);
    const ins = a.instructions!;
    expect(ins.length).toBeLessThanOrEqual(5000);
    for (const must of [
      'You never send anything', 'never send, schedule or queue', 'never change the order', 'Never invent a tracking number', '⟦TRACKING⟧', '⟦AMOUNT DUE⟧',
      'no "final reminder"', 'no late fee', 'One payment line, once', 'If the order is Cancelled or Payment Status is Refunded, write nothing',
    ]) {
      expect(ins, must).toContain(must);
    }
    // the message is a COMMENT, not a field write
    expect(ins).toContain('One comment on the order, and nothing else, anywhere');
    for (const s of ['Shipped', 'Delivered']) expect(ins, s).toMatch(new RegExp(`- ${s}: `));
  });

  it('fake-data audit: every email is on the reserved .example domain, every sample says (sample), and no sample uses a real-looking URL', () => {
    const json = JSON.stringify(m);
    const emails = json.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
    expect(emails.length, 'the audit would be vacuous without emails').toBeGreaterThanOrEqual(5);
    for (const e of emails) expect(e, e).toMatch(/\.example$/);
    expect(json).not.toMatch(/https?:\/\//);
    expect(m.sample_records.length).toBeGreaterThan(20);
    for (const r of m.sample_records) expect(String(r.values.name), `${r.database}`).toContain('(sample)');
    // phone numbers use the reserved fictional 555-01xx range
    const phones = json.match(/\+\d\d \d{3} \d{4}/g) ?? [];
    expect(phones.length).toBeGreaterThanOrEqual(5);
    for (const p of phones) expect(p, p).toMatch(/ 555 01\d\d$/);
  });

  it('27 sample records: 5 customers, 6 products, 6 orders, 10 lines; every order sets BOTH its states explicitly (no first-state default)', () => {
    const count = (db: string) => m.sample_records.filter((r) => r.database === db).length;
    expect([count('Customers'), count('Products'), count('Orders'), count('Order Lines')]).toEqual([5, 6, 6, 10]);
    for (const r of m.sample_records.filter((x) => x.database === 'Orders')) {
      expect(r.values.status, String(r.values.name)).toBeTruthy();
      expect(r.values.payment_status, String(r.values.name)).toBeTruthy();
    }
  });
});

describe('#1322 installs on a fresh workspace', () => {
  let ws: string;
  let out: {
    databases: Array<{ name: string; action: string }>;
    views: unknown[];
    agents: Array<{ name: string; action: string }>;
    automations: Array<{ name: string; action: string; enabled?: boolean }>;
    triggers: Array<{ name: string; action: string; enabled?: boolean; switched_off_because?: string; human_gate?: boolean }>;
    sample_records: Array<{ action: string }>;
    unmet: unknown[];
  };

  beforeAll(async () => {
    ws = await newWs('Fresh');
    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    out = res.json();
  }, 120_000);

  it('creates exactly the declared databases, views, automation and agent, nothing unmet', async () => {
    expect(out.unmet).toEqual([]);
    expect(out.databases.map((d) => [d.name, d.action])).toEqual([['Customers', 'created'], ['Products', 'created'], ['Orders', 'created'], ['Order Lines', 'created']]);
    expect(out.views).toHaveLength(4);
    expect(out.automations).toHaveLength(1);
    expect(out.automations[0]!.name.endsWith('Notify on order status change')).toBe(true);
    expect(out.automations[0]).toMatchObject({ action: 'created', enabled: true });
    expect(out.agents.map((a) => [a.name, a.action])).toEqual([[AGENT, 'created']]);
    expect(out.sample_records).toHaveLength(27);
    const names = (await dbsOf(ws)).map((d) => d.name);
    for (const n of ['Customers', 'Products', 'Orders', 'Order Lines']) expect(names.filter((x) => x === n), n).toHaveLength(1);
  });

  for (const [db, fields] of Object.entries(SPEC_FIELDS)) {
    it(`${db}: every field the pack declares exists, with its type, and nothing else`, async () => {
      const d = await detail(ws, db);
      const got = Object.fromEntries(d.fields.map((f) => [f.displayName, f.type]));
      for (const [name, type] of Object.entries(fields)) expect(got[name], `${db}.${name}`).toBe(type);
      // besides the title and the system columns, nothing a person did not ask for
      expect(Object.keys(got).filter((n) => !(n in fields) && !['Name', 'Title', 'ID', 'Created at', 'Updated at', 'Created by'].includes(n))).toEqual([]);
      const allowed = new Set<string>([...creatableFieldTypeSchema.options, 'relation', 'rollup', 'lookup']);
      for (const f of d.fields.filter((x) => x.displayName in fields)) expect(allowed.has(f.type), `${db}.${f.displayName}: ${f.type}`).toBe(true);
    });
  }

  it('the two states carry their labels and categories, in order', async () => {
    const o = await detail(ws, 'Orders');
    expect(field(o, 'Status').options!.map((x) => [x.label, x.category])).toEqual([
      ['New', 'backlog'], ['Packing', 'started'], ['Shipped', 'started'], ['Delivered', 'completed'], ['Cancelled', 'canceled'],
    ]);
    expect(field(o, 'Payment Status').options!.map((x) => [x.label, x.category])).toEqual([
      ['Unpaid', 'unstarted'], ['Part paid', 'started'], ['Paid', 'completed'], ['Refunded', 'canceled'],
    ]);
    expect(field(o, 'Payment Method').options!.map((x) => x.label)).toEqual(['Card', 'Bank transfer', 'Cash', 'Other']);
    expect(field(await detail(ws, 'Products'), 'Category').options!.map((x) => x.label)).toEqual(['Kitchen', 'Home', 'Bath', 'Gifts']);
    // the formula is declared after the two numbers it reads
    const lines = (await detail(ws, 'Order Lines')).fields.map((f) => f.displayName);
    expect(lines.indexOf('Line Amount')).toBeGreaterThan(lines.indexOf('Quantity'));
    expect(lines.indexOf('Line Amount')).toBeGreaterThan(lines.indexOf('Unit Price'));
  });

  it('the links: an order has a customer and lines, a line has a product, with both ends named', async () => {
    const names = async (db: string) => (await detail(ws, db)).fields.map((f) => f.displayName);
    expect(await names('Orders')).toEqual(expect.arrayContaining(['Customer', 'Lines']));
    expect(await names('Customers')).toContain('Orders');
    expect(await names('Order Lines')).toEqual(expect.arrayContaining(['Order', 'Product']));
    expect(await names('Products')).toContain('Order Lines');
  });

  it('views: the board groups on Status (a groupable field the server accepts), Unpaid is on Payment Status, Customers and Catalog are the defaults of theirs', async () => {
    const o = await detail(ws, 'Orders');
    const board = o.views.find((v) => v.name === 'Order Board')!;
    expect(board).toMatchObject({ type: 'board', isDefault: true });
    expect(board.config.group_by_field_id).toBe(field(o, 'Status').id);
    // the board's grouping field is a select, and the server's own rule (the one the web mirrors in groupable-fields.ts) accepts it
    expect(field(o, 'Status').type).toBe('select');
    expect(boardGroupError({ type: 'select', config: {} }, null)).toBeNull();
    expect(board.config.card_field_ids).toEqual([field(o, 'Customer').id, field(o, 'Total').id, field(o, 'Payment Status').id]);
    const unpaid = o.views.find((v) => v.name === 'Unpaid Orders')!;
    expect(unpaid.type).toBe('table');
    expect(unpaid.config.filters).toEqual({
      and: [{ field: 'payment_status', op: 'category_is', value: ['unstarted', 'started'] }, { field: 'status', op: 'category_is_not', value: ['canceled'] }],
    });
    expect(unpaid.config.sorts).toEqual([{ field: 'ordered_on', direction: 'asc' }]);
    expect((await detail(ws, 'Customers')).views.find((v) => v.name === 'Customers')).toMatchObject({ type: 'table', isDefault: true });
    expect((await detail(ws, 'Products')).views.find((v) => v.name === 'Catalog')).toMatchObject({ type: 'table', isDefault: true });
  });

  it('sample data: 6 orders with the status and payment the pack names, 5 customers, 6 products, every one flagged "(sample)"', async () => {
    const o = await detail(ws, 'Orders');
    const or = await rows(ws, o.id);
    expect(or).toHaveLength(6);
    expect(Object.fromEntries(or.map((r) => [r.title, [optLabel(o, 'Status', r.values.status), optLabel(o, 'Payment Status', r.values.payment_status)]]))).toEqual({
      [titleOf('Order 1001')]: ['Delivered', 'Paid'],
      [titleOf('Order 1002')]: ['Shipped', 'Paid'],
      [titleOf('Order 1003')]: ['Packing', 'Unpaid'],
      [titleOf('Order 1004')]: ['New', 'Unpaid'],
      [titleOf('Order 1005')]: ['Delivered', 'Part paid'],
      [titleOf('Order 1006')]: ['Cancelled', 'Refunded'],
    });
    expect(or.every((r) => Array.isArray(r.values.customer) && (r.values.customer as unknown[]).length === 1)).toBe(true);
    expect(or.every((r) => typeof r.values.ordered_on === 'string')).toBe(true);
    expect(or.find((r) => r.title === titleOf('Order 1004'))!.values.paid_on ?? null).toBeNull();
    expect(or.find((r) => r.title === titleOf('Order 1001'))!.values.ordered_on).toBe(dayStr(-14));
    const cr = await rows(ws, (await detail(ws, 'Customers')).id);
    expect(cr).toHaveLength(5);
    const pr = await rows(ws, (await detail(ws, 'Products')).id);
    expect(pr).toHaveLength(6);
    for (const r of [...or, ...cr, ...pr, ...(await rows(ws, (await detail(ws, 'Order Lines')).id))]) expect(r.title, r.title).toContain('(sample)');
    expect(cr.every((r) => String(r.values.email).endsWith('.example'))).toBe(true);
  });

  it('order totals are computed: the line amounts are quantity x unit price, and each order\'s Total is the sum of its lines', async () => {
    const l = await detail(ws, 'Order Lines');
    const lr = await rows(ws, l.id);
    expect(lr).toHaveLength(10);
    const amount = field(l, 'Line Amount').apiName;
    for (const r of lr) expect(r.values[amount], r.title).toBe((r.values.quantity as number) * (r.values.unit_price as number));
    const o = await detail(ws, 'Orders');
    const total = field(o, 'Total').apiName;
    const got = Object.fromEntries((await rows(ws, o.id)).map((r) => [r.title.replace(' (sample)', ''), Number(r.values[total])]));
    expect(got).toEqual(TOTALS);
  });

  it('a customer\'s Orders Placed counts their orders and leaves a cancelled one out', async () => {
    const c = await detail(ws, 'Customers');
    const placed = field(c, 'Orders Placed').apiName;
    const got = Object.fromEntries((await rows(ws, c.id)).map((r) => [r.title.replace(' (sample)', ''), Number(r.values[placed] ?? 0)]));
    // Anna has Order 1001 and the cancelled Order 1006: only the live one counts
    expect(got).toEqual({ 'Anna Lindqvist': 1, 'Marcus Webb': 1, 'Priya Raman': 1, 'Tomas Novak': 1, 'Hannah Okafor': 1 });
    // she is linked to BOTH orders, so the 1 is the filter's doing and not a missing link
    const o = await detail(ws, 'Orders');
    const anna = (await rows(ws, c.id)).find((r) => r.title.startsWith('Anna'))!;
    const hers = (await rows(ws, o.id)).filter((r) => JSON.stringify(r.values.customer).includes(anna.id));
    expect(hers.map((r) => r.title).sort()).toEqual([titleOf('Order 1001'), titleOf('Order 1006')]);
  });

  it('Unpaid Orders returns exactly the open orders still owed, oldest first: it excludes paid and cancelled/refunded ones', async () => {
    const o = await detail(ws, 'Orders');
    const unpaid = o.views.find((v) => v.name === 'Unpaid Orders')!;
    const q = async () => (await rows(ws, o.id, { filter: unpaid.config.filters, sorts: unpaid.config.sorts, limit: 200 })).map((r) => r.title.replace(' (sample)', ''));
    // 1005 is Delivered but only part paid: still owed. 1001/1002 are Paid; 1006 is cancelled and refunded.
    expect(await q()).toEqual(['Order 1005', 'Order 1003', 'Order 1004']);
    const byTitle = async (n: string) => (await rows(ws, o.id)).find((r) => r.title === titleOf(n))!;
    // paying an order drops it
    await as('PATCH', `/workspaces/${ws}/databases/${o.id}/records/${(await byTitle('Order 1003')).id}`, { values: { payment_status: optId(o, 'Payment Status', 'Paid') } });
    expect(await q()).toEqual(['Order 1005', 'Order 1004']);
    // a cancelled order is never chased, even while it still reads Unpaid
    await as('PATCH', `/workspaces/${ws}/databases/${o.id}/records/${(await byTitle('Order 1004')).id}`, { values: { status: optId(o, 'Status', 'Cancelled') } });
    expect(await q()).toEqual(['Order 1005']);
    // and an order that gets unpaid again comes back
    await as('PATCH', `/workspaces/${ws}/databases/${o.id}/records/${(await byTitle('Order 1002')).id}`, { values: { payment_status: optId(o, 'Payment Status', 'Unpaid') } });
    expect(await q()).toEqual(['Order 1005', 'Order 1002']);
  });

  it('a NEW order made without saying a status or a payment still gets a sensible one, or none; it is never silently Paid or Delivered', async () => {
    const o = await detail(ws, 'Orders');
    const r = await as('POST', `/workspaces/${ws}/databases/${o.id}/records`, { values: { name: 'Order 2000' } });
    expect(r.statusCode, r.body).toBe(201);
    const v = r.json().values as Record<string, unknown>;
    // either no value (today) or the first state (after #1325): never a later one
    expect([undefined, null, optId(o, 'Status', 'New')]).toContain(v.status);
    expect([undefined, null, optId(o, 'Payment Status', 'Unpaid')]).toContain(v.payment_status);
  });

  it('the agent is installed SWITCHED OFF: both status wakes are off, and nothing wakes until a person turns one on', async () => {
    expect(out.triggers).toHaveLength(2);
    for (const t of out.triggers) {
      expect(t.action, t.name).toBe('created');
      expect(t.enabled, t.name).toBe(false);
      expect(t.switched_off_because, t.name).toBe('wakes_agent');
      expect(t.human_gate, t.name).not.toBe(true);
    }
    const ensured = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json();
    const bindings = (await as('GET', `/workspaces/${ws}/databases/${ensured.triggersDb.id}/records?limit=200`)).json().data as Row[];
    expect(bindings).toHaveLength(2);
    expect(bindings.every((b) => b.values['enabled'] !== true)).toBe(true);
    const { rows: wakes } = await pool.query(
      `select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`,
      [ws, AGENT],
    );
    expect(wakes[0].n, 'the sample Shipped and Delivered orders woke nothing').toBe(0);
    const agents = (await as('GET', `/workspaces/${ws}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[];
    expect(agents.map((a) => a.title)).toContain(AGENT);
  });

  it('"Remove sample data" takes the 27 sample records, and a second removal takes none', async () => {
    const ws2 = await newWs('Remove');
    expect((await install(ws2)).statusCode).toBe(201);
    const removed = await as('DELETE', `/workspaces/${ws2}/templates/sample-data`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().removed).toBe(27);
    for (const db of ['Customers', 'Products', 'Orders', 'Order Lines']) expect(await rows(ws2, (await detail(ws2, db)).id), db).toHaveLength(0);
    expect((await as('DELETE', `/workspaces/${ws2}/templates/sample-data`)).json().removed).toBe(0);
  });

  it('a re-install is idempotent (#1157): the same databases, views, rule, agent and triggers; no second copy of anything; the sample data is not doubled', async () => {
    const ws3 = await newWs('Reinstall');
    expect((await install(ws3)).statusCode).toBe(201);
    const snapshot = async () => {
      const dbs = await dbsOf(ws3);
      const names = ['Customers', 'Products', 'Orders', 'Order Lines'];
      const details = await Promise.all(names.map((n) => detail(ws3, n)));
      const ensured = (await as('POST', `/workspaces/${ws3}/agents/ensure`)).json();
      const bindings = (await as('GET', `/workspaces/${ws3}/databases/${ensured.triggersDb.id}/records?limit=200`)).json().data as Row[];
      const agents = (await as('GET', `/workspaces/${ws3}/databases/${ensured.agentsDb.id}/records?limit=200`)).json().data as Row[];
      const orders = details[2]!;
      const rules = (await as('GET', `/workspaces/${ws3}/databases/${orders.id}/automations`)).json().data as Array<{ name: string }>;
      return {
        dbIds: dbs.map((d) => d.id).sort(),
        fields: details.map((d) => d.fields.length),
        views: details.map((d) => d.views.length),
        counts: await Promise.all(details.map(async (d) => (await rows(ws3, d.id)).length)),
        bindings: bindings.length,
        agents: agents.filter((a) => a.title === AGENT).length,
        rules: rules.length,
      };
    };
    const first = await snapshot();
    expect(first.counts).toEqual([5, 6, 6, 10]);
    const again = await install(ws3);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().databases.map((d: { action: string }) => d.action)).toEqual(['reused', 'reused', 'reused', 'reused']);
    expect(await snapshot()).toEqual(first);
  }, 120_000);
});

describe('#1322 the automation and the agent triggers DO their job', () => {
  it('changing an order\'s status notifies its owner, once, and a change to something else does not', async () => {
    const ws = await newWs('Notify');
    expect((await install(ws)).statusCode).toBe(201);
    const member = await joinAs(app, owner.token, ws, 'Order Owner Member', 'member');
    const orders = await detail(ws, 'Orders');
    const engine = app.get(AutomationsService);
    const MSG = 'Order status changed: Order 3000. Tell the customer, or run the drafter.';
    const told = async () => ((await as('GET', `/workspaces/${ws}/notifications`, undefined, member.token)).json().data ?? []).filter((n: { snippet?: string }) => n.snippet === MSG).length as number;
    const mk = await as('POST', `/workspaces/${ws}/databases/${orders.id}/records`, {
      values: { name: 'Order 3000', status: optId(orders, 'Status', 'New'), payment_status: optId(orders, 'Payment Status', 'Unpaid'), owner: member.id },
    });
    expect(mk.statusCode, mk.body).toBe(201);
    const id = mk.json().id as string;
    await engine.settle(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await told(), 'a new order is not a status CHANGE').toBe(0);

    await as('PATCH', `/workspaces/${ws}/databases/${orders.id}/records/${id}`, { values: { payment_status: optId(orders, 'Payment Status', 'Paid') } });
    await engine.settle(id);
    await new Promise((r) => setTimeout(r, 300));
    expect(await told(), 'a payment change is not a fulfilment status change').toBe(0);

    expect((await as('PATCH', `/workspaces/${ws}/databases/${orders.id}/records/${id}`, { values: { status: optId(orders, 'Status', 'Shipped') } })).statusCode).toBe(200);
    await engine.settle(id);
    for (let i = 0; i < 40 && (await told()) < 1; i++) await new Promise((r) => setTimeout(r, 250));
    expect(await told(), 'the owner was told').toBe(1);
    const rule = ((await as('GET', `/workspaces/${ws}/databases/${orders.id}/automations`)).json().data as Array<{ id: string; name: string }>).find((r) => r.name.endsWith('Notify on order status change'))!;
    const runs = (await as('GET', `/workspaces/${ws}/databases/${orders.id}/automations/${rule.id}/runs`)).json().data as Array<{ status: string }>;
    expect(runs.filter((r) => r.status === 'ok'), 'one run for the one status change').toHaveLength(1);
  }, 120_000);

  it('switched on, an order ENTERING Shipped or Delivered wakes the drafter (created there, or moved there), and no other status or edit does', async () => {
    const ws = await newWs('Wakes');
    const subscriber = app.get(AgentTriggerSubscriber);
    const res = await install(ws, { enable_agent_triggers: ['Shipped', 'Delivered'].map(triggerLabel) });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json().triggers as Array<{ enabled?: boolean }>).every((t) => t.enabled === true)).toBe(true);
    const orders = await detail(ws, 'Orders');
    const wakes = async () => {
      for (const r of await rows(ws, orders.id)) await subscriber.settle(r.id);
      const { rows: w } = await pool.query(
        `select count(*)::int as n from agent_wakes w join records r on r.id = w.agent_id where w.workspace_id = $1 and r.title = $2`,
        [ws, AGENT],
      );
      return w[0].n as number;
    };
    // the sample orders: 1002 Shipped, 1001 and 1005 Delivered, each woke it once on install
    expect(await wakes()).toBe(3);
    let n = 3;
    for (const status of ['New', 'Packing', 'Cancelled']) {
      const r = await as('POST', `/workspaces/${ws}/databases/${orders.id}/records`, { values: { name: `Created ${status}`, status: optId(orders, 'Status', status) } });
      expect(r.statusCode, r.body).toBe(201);
      expect(await wakes(), `created in ${status}`).toBe(n);
    }
    const mk = await as('POST', `/workspaces/${ws}/databases/${orders.id}/records`, { values: { name: 'Created Packing 2', status: optId(orders, 'Status', 'Packing') } });
    const id = mk.json().id as string;
    await as('PATCH', `/workspaces/${ws}/databases/${orders.id}/records/${id}`, { values: { delivery_notes: 'Ring twice' } });
    expect(await wakes(), 'editing Delivery Notes wakes nothing').toBe(n);
    await as('PATCH', `/workspaces/${ws}/databases/${orders.id}/records/${id}`, { values: { status: optId(orders, 'Status', 'Shipped') } });
    n += 1;
    expect(await wakes(), 'moved to Shipped').toBe(n);
    const r2 = await as('POST', `/workspaces/${ws}/databases/${orders.id}/records`, { values: { name: 'Created Delivered', status: optId(orders, 'Status', 'Delivered') } });
    expect(r2.statusCode, r2.body).toBe(201);
    n += 1;
    expect(await wakes(), 'created in Delivered').toBe(n);
  }, 180_000);
});
