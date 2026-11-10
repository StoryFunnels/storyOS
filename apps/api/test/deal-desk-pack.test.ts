import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { createTestApp } from './helpers/app';
import { call } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1201 (PR 1 of 2) - Deal Desk: the 8 databases, the 11 links, the 8 views and the 28 sample records.
 * The automations and the 3 agents are PR 2, so this file also pins that they are NOT here yet.
 *
 * Every database below is checked against the COMPLETE field list Dara's spec gives it, not a sample of it.
 */
const entry = PACK_REGISTRY.find((p) => p.slug === 'deal-desk')!;

let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const newWs = async (n: string) => (await as('POST', '/workspaces', { name: `${n} ${Date.now()}` })).json().id as string;

interface Opt { id: string; label: string; color?: string; category?: string | null }
interface Fld { id: string; displayName: string; apiName: string; type: string; options?: Opt[]; config?: Record<string, unknown> }
interface View { id: string; name: string; type: string; isDefault: boolean; config: Record<string, unknown> }
type Detail = { id: string; fields: Fld[]; views: View[] };
const dbsOf = async (ws: string) =>
  ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name !== 'Members');
const detailById = async (ws: string, id: string) => (await as('GET', `/workspaces/${ws}/databases/${id}`)).json() as Detail;
const detail = async (ws: string, name: string, space?: string) => {
  const list = (await dbsOf(ws)).filter((d) => d.name === name);
  const db = space ? list.find((d) => d.spaceId === space) : list[0];
  return detailById(ws, db!.id);
};
const rows = async (ws: string, dbId: string) =>
  ((await as('POST', `/workspaces/${ws}/databases/${dbId}/records/query`, { limit: 200 })).json().data ?? []) as Array<{ id: string; title: string; values: Record<string, unknown> }>;
const install = (ws: string, body: Record<string, unknown> = {}) => as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest, ...body });
const agencyOs = () => PACK_REGISTRY.find((p) => p.slug === 'agency-os')!.manifest;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Deal Desk Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

/** Every field of every database Dara's spec lists. `Name` is the title and is not listed. */
const SPEC_FIELDS: Record<string, Record<string, string>> = {
  Accounts: { Status: 'select', Owner: 'user', Industry: 'select', Website: 'url', Contacts: 'relation', Deals: 'relation', Client: 'relation' },
  Contacts: { Role: 'text', Email: 'email', Phone: 'text', 'Buying role': 'select', Account: 'relation', Deals: 'relation', Activities: 'relation' },
  Deals: {
    Stage: 'select', Amount: 'number', 'Close date': 'date', Owner: 'user', 'Next step': 'text', 'Next step date': 'date', Source: 'select', 'Lost reason': 'select',
    'Last activity': 'rollup', Account: 'relation', Contacts: 'relation', Competitors: 'relation', Activities: 'relation', Quotes: 'relation', Projects: 'relation',
  },
  Activities: { Status: 'select', Type: 'select', Date: 'date', Notes: 'text', Deal: 'relation', Contact: 'relation' },
  Quotes: { Status: 'select', 'Valid until': 'date', Total: 'rollup', Deal: 'relation', Lines: 'relation' },
  'Quote Lines': { Qty: 'number', 'Unit price': 'number', 'Discount %': 'number', 'Line total': 'formula', 'List price': 'lookup', Quote: 'relation', Product: 'relation' },
  Products: { Price: 'number', Billing: 'select', Active: 'checkbox', 'Quote lines': 'relation' },
  Competitors: { Website: 'url', 'Where they beat us': 'text', 'Deals lost to them': 'rollup', Deals: 'relation' },
};

describe('#1201 the manifest', () => {
  it('is registered, valid, and the data half of Dara\'s spec: 8 + 2 databases, 11 links, 8 views, 28 samples, no automation or agent yet', () => {
    expect(entry, 'deal-desk is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(entry.manifest).success).toBe(true);
    const m = entry.manifest;
    expect(m.databases.map((d) => d.name)).toEqual(['Accounts', 'Contacts', 'Deals', 'Activities', 'Quotes', 'Quote Lines', 'Products', 'Competitors', 'Clients', 'Projects']);
    expect(m.relations).toHaveLength(11);
    expect(m.views.map((v) => v.name)).toEqual(['Pipeline', 'My open deals', 'Closing this month', 'Why we lose', 'Quote board', 'Price list', 'Accounts', 'This week']);
    expect(m.sample_records).toHaveLength(28);
    expect(m.sample_records.every((r) => String(r.values.name).includes('(sample'))).toBe(true);
    expect([m.automations.length, m.agents.length, m.triggers.length], 'PR 2 adds these').toEqual([0, 0, 0]);
    expect(m.requires.packs).toEqual([expect.objectContaining({ pack: 'agency-os', databases: ['Clients', 'Projects'] })]);
  });
});

describe('#1201 installs on a fresh workspace', () => {
  let ws: string;
  let result: { unmet: unknown[]; databases: Array<{ name: string; action: string }>; views: unknown[]; sample_records: unknown[]; required_packs: Array<{ outcome: string }> };

  beforeAll(async () => {
    ws = await newWs('Fresh');
    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    result = res.json();
  });

  it('creates every database, nothing is unmet, and Clients/Projects are made here (Agency OS is not installed)', async () => {
    expect(result.unmet).toEqual([]);
    expect(result.required_packs[0]!.outcome).toBe('created_here');
    expect((await dbsOf(ws)).map((d) => d.name).sort()).toEqual(entry.manifest.databases.map((d) => d.name).sort());
  });

  for (const [db, fields] of Object.entries(SPEC_FIELDS)) {
    it(`${db}: every field the spec lists exists, with its type`, async () => {
      const d = await detail(ws, db);
      const got = Object.fromEntries(d.fields.map((f) => [f.displayName, f.type]));
      for (const [name, type] of Object.entries(fields)) {
        // a state is stored as a select (ADR-0010); the type a person sees for Stage / Status is select
        expect(got[name], `${db}.${name}`).toBe(type);
      }
    });
  }

  it('the 11 links exist, each with both ends named as the spec says', async () => {
    const ends: Array<[string, string, string, string]> = [
      ['Contacts', 'Account', 'Accounts', 'Contacts'], ['Deals', 'Account', 'Accounts', 'Deals'], ['Activities', 'Deal', 'Deals', 'Activities'],
      ['Deals', 'Contacts', 'Contacts', 'Deals'], ['Quotes', 'Deal', 'Deals', 'Quotes'], ['Quote Lines', 'Quote', 'Quotes', 'Lines'],
      ['Quote Lines', 'Product', 'Products', 'Quote lines'], ['Deals', 'Competitors', 'Competitors', 'Deals'], ['Activities', 'Contact', 'Contacts', 'Activities'],
      ['Accounts', 'Client', 'Clients', 'Sales accounts'], ['Projects', 'Source deal', 'Deals', 'Projects'],
    ];
    expect(ends).toHaveLength(11);
    for (const [from, fromField, to, toField] of ends) {
      const a = await detail(ws, from);
      const b = await detail(ws, to);
      expect(a.fields.map((f) => f.displayName), `${from}.${fromField}`).toContain(fromField);
      expect(b.fields.map((f) => f.displayName), `${to}.${toField}`).toContain(toField);
    }
  });

  it('Stage / Status carry the spec\'s labels, colours and categories', async () => {
    const stage = (await detail(ws, 'Deals')).fields.find((f) => f.displayName === 'Stage')!;
    expect((stage.options ?? []).map((o) => [o.label, o.color, o.category])).toEqual([
      ['Lead', 'gray', 'backlog'], ['Qualified', 'blue', 'unstarted'], ['Discovery', 'purple', 'started'], ['Proposal', 'purple', 'started'],
      ['Negotiation', 'orange', 'started'], ['Won', 'green', 'completed'], ['Lost', 'red', 'canceled'],
    ]);
    const q = (await detail(ws, 'Quotes')).fields.find((f) => f.displayName === 'Status')!;
    expect((q.options ?? []).map((o) => [o.label, o.category])).toEqual([['Draft', 'unstarted'], ['Sent', 'started'], ['Accepted', 'completed'], ['Declined', 'canceled'], ['Expired', 'canceled']]);
    const a = (await detail(ws, 'Activities')).fields.find((f) => f.displayName === 'Status')!;
    expect((a.options ?? []).map((o) => [o.label, o.category])).toEqual([['Planned', 'unstarted'], ['Logged', 'completed']]);
    const acct = (await detail(ws, 'Accounts')).fields.find((f) => f.displayName === 'Status')!;
    expect((acct.options ?? []).map((o) => [o.label, o.color])).toEqual([['Prospect', 'gray'], ['Working', 'blue'], ['Customer', 'green'], ['Disqualified', 'red']]);
    const role = (await detail(ws, 'Contacts')).fields.find((f) => f.displayName === 'Buying role')!;
    expect((role.options ?? []).map((o) => [o.label, o.color])).toEqual([['Decision maker', 'green'], ['Champion', 'blue'], ['Influencer', 'purple'], ['Blocker', 'red']]);
  });

  it('money: Amount is USD with no decimals; Unit price and Price are USD with 2; Line total is a USD currency formula', async () => {
    const deals = await detail(ws, 'Deals');
    expect(deals.fields.find((f) => f.displayName === 'Amount')!.config).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 0 });
    const lines = await detail(ws, 'Quote Lines');
    expect(lines.fields.find((f) => f.displayName === 'Unit price')!.config).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 2 });
    expect(lines.fields.find((f) => f.displayName === 'Line total')!.config).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 2, result_type: 'number' });
    expect((await detail(ws, 'Products')).fields.find((f) => f.displayName === 'Price')!.config).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 2 });
    // the formula is declared after its inputs
    const order = lines.fields.map((f) => f.displayName);
    for (const input of ['Qty', 'Unit price', 'Discount %']) expect(order.indexOf('Line total')).toBeGreaterThan(order.indexOf(input));
  });

  it('views: 8 exist, Pipeline hides Won and Lost, the defaults are the spec\'s, This week is a calendar on Date', async () => {
    expect(result.views).toHaveLength(8);
    const deals = await detail(ws, 'Deals');
    const stage = deals.fields.find((f) => f.displayName === 'Stage')!;
    const optId = (l: string) => stage.options!.find((o) => o.label === l)!.id;
    const pipeline = deals.views.find((v) => v.name === 'Pipeline')!;
    expect(pipeline.type).toBe('board');
    expect(pipeline.isDefault).toBe(true);
    expect(pipeline.config.group_by_field_id).toBe(stage.id);
    expect([...(pipeline.config.hidden_option_ids as string[])].sort()).toEqual([optId('Won'), optId('Lost')].sort());
    expect(pipeline.config.card_field_ids).toEqual(['Amount', 'Owner', 'Close date'].map((n) => deals.fields.find((f) => f.displayName === n)!.id));
    expect(deals.views.find((v) => v.name === 'My open deals')!.config.filters).toEqual({ and: [{ field: 'owner', op: 'has', value: ['me'] }, { field: 'stage', op: 'category_is_not', value: ['completed', 'canceled'] }] });
    const closing = deals.views.find((v) => v.name === 'Closing this month')!;
    expect(closing.config.sorts).toEqual([{ field: 'close_date', direction: 'asc' }]);
    expect(JSON.stringify(closing.config.filters)).toContain('this_month');
    const why = deals.views.find((v) => v.name === 'Why we lose')!;
    expect(why.type).toBe('board');
    expect(why.config.group_by_field_id).toBe(deals.fields.find((f) => f.displayName === 'Lost reason')!.id);
    expect(why.config.filters).toEqual({ field: 'stage', op: 'category_is', value: ['canceled'] });
    expect(deals.views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['Pipeline']);

    const quotes = await detail(ws, 'Quotes');
    expect(quotes.views.find((v) => v.name === 'Quote board')).toMatchObject({ type: 'board', isDefault: true });
    const products = await detail(ws, 'Products');
    expect(products.views.find((v) => v.name === 'Price list')).toMatchObject({ type: 'table', isDefault: true });
    expect(products.views.find((v) => v.name === 'Price list')!.config.filters).toEqual({ field: 'active', op: 'eq', value: true });
    const accounts = await detail(ws, 'Accounts');
    const av = accounts.views.find((v) => v.name === 'Accounts')!;
    expect(av.isDefault).toBe(true);
    expect(av.config.group_by_field_id).toBe(accounts.fields.find((f) => f.displayName === 'Status')!.id);
    const acts = await detail(ws, 'Activities');
    const week = acts.views.find((v) => v.name === 'This week')!;
    expect(week).toMatchObject({ type: 'calendar', isDefault: true });
    expect(week.config.date_field_id).toBe(acts.fields.find((f) => f.displayName === 'Date')!.id);
  });

  it('installs no automation and no agent (PR 2)', async () => {
    for (const name of ['Deals', 'Quotes']) {
      const d = await detail(ws, name);
      const body = (await as('GET', `/workspaces/${ws}/databases/${d.id}/automations`)).json();
      expect((Array.isArray(body) ? body : body.data) as unknown[]).toHaveLength(0);
    }
  });

  it('sample data: 28 records, every title says (sample), and the teaching deals are in the stages their titles say', async () => {
    expect(result.sample_records).toHaveLength(28);
    const counts: Record<string, number> = {};
    for (const db of ['Products', 'Competitors', 'Accounts', 'Contacts', 'Deals', 'Quotes', 'Quote Lines', 'Activities']) {
      const d = await detail(ws, db);
      const r = await rows(ws, d.id);
      counts[db] = r.length;
      for (const x of r) expect(x.title, `${db} sample title`).toContain('(sample');
    }
    expect(counts).toEqual({ Products: 4, Competitors: 2, Accounts: 3, Contacts: 4, Deals: 5, Quotes: 2, 'Quote Lines': 4, Activities: 4 });
    const deals = await detail(ws, 'Deals');
    const stage = deals.fields.find((f) => f.displayName === 'Stage')!;
    const stageOf = async (title: string) => {
      const r = (await rows(ws, deals.id)).find((x) => x.title === title)!;
      return stage.options!.find((o) => o.id === r.values.stage)!.label;
    };
    expect(await stageOf('Drag me to Qualified (sample)')).toBe('Lead');
    expect(await stageOf('My next step is overdue: set a new one (sample)')).toBe('Discovery');
    expect(await stageOf('Open my quote and mark it Accepted (sample)')).toBe('Proposal');
    expect(await stageOf('A won deal (sample)')).toBe('Won');
    const lost = (await rows(ws, deals.id)).find((x) => x.title === 'A lost deal, with its reason (sample)')!;
    expect(lost.values.lost_reason, 'the lost sample carries its reason').toBeTruthy();
    const overdue = (await rows(ws, deals.id)).find((x) => x.title === 'My next step is overdue: set a new one (sample)')!;
    expect(String(overdue.values.next_step_date) < new Date().toISOString().slice(0, 10)).toBe(true);
    // one contact per buying role, owner is the installer
    const contacts = await rows(ws, (await detail(ws, 'Contacts')).id);
    expect(new Set(contacts.map((c) => c.values.buying_role)).size).toBe(4);
    for (const a of await rows(ws, (await detail(ws, 'Accounts')).id)) expect(a.values.owner).toBeTruthy();
    const acts = await detail(ws, 'Activities');
    const actRows = await rows(ws, acts.id);
    const status = acts.fields.find((f) => f.displayName === 'Status')!;
    const label = (r: (typeof actRows)[number]) => status.options!.find((o) => o.id === r.values.status)!.label;
    expect(actRows.filter((r) => label(r) === 'Planned')).toHaveLength(2);
    expect(actRows.filter((r) => label(r) === 'Logged')).toHaveLength(2);
    expect(actRows.filter((r) => r.values.notes)).toHaveLength(1);
    expect((await rows(ws, (await detail(ws, 'Quote Lines')).id)).filter((r) => r.values.discount)).toHaveLength(1);
  });

  it('the formula and the rollups compute: a discounted line, a quote total, a last activity, a count of lost deals', async () => {
    const lines = await detail(ws, 'Quote Lines');
    const lineRows = await rows(ws, lines.id);
    const lt = lines.fields.find((f) => f.displayName === 'Line total')!;
    const byTitle = Object.fromEntries(lineRows.map((r) => [r.title, Number(r.values[lt.apiName])]));
    expect(byTitle['Monthly retainer (sample line)']).toBe(3240); // 3 x 1200, 10% off
    expect(byTitle['Strategy workshop (sample line)']).toBe(2500); // no discount: coalesce -> 0
    const quotes = await detail(ws, 'Quotes');
    const qrows = await rows(ws, quotes.id);
    const total = quotes.fields.find((f) => f.displayName === 'Total')!;
    const sent = qrows.find((r) => r.title === 'Brightside rollout quote (sample)')!;
    expect(Number(sent.values[total.apiName])).toBe(5740);
    const deals = await detail(ws, 'Deals');
    const dealRows = await rows(ws, deals.id);
    const last = deals.fields.find((f) => f.displayName === 'Last activity')!;
    const proposal = dealRows.find((r) => r.title === 'Open my quote and mark it Accepted (sample)')!;
    expect(proposal.values[last.apiName], 'a logged activity exists, so Last activity is set').toBeTruthy();
    const comps = await detail(ws, 'Competitors');
    const lostTo = comps.fields.find((f) => f.displayName === 'Deals lost to them')!;
    const cr = await rows(ws, comps.id);
    expect(Number(cr.find((r) => r.title === 'Bluepeak Studio (sample)')!.values[lostTo.apiName])).toBe(1);
    expect(Number(cr.find((r) => r.title === 'Northwind Agency (sample)')!.values[lostTo.apiName])).toBe(0);
  });
});

describe('#1201 installs on a workspace that already has Agency OS', () => {
  it('the Agency OS link works both ways: Clients gains Sales accounts, Projects gains Source deal, Deals gains Projects, Accounts gains Client; no second Clients or Projects', async () => {
    const ws = await newWs('With Agency OS');
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: agencyOs() })).statusCode).toBe(201);
    const clientsBefore = (await dbsOf(ws)).filter((d) => d.name === 'Clients');
    const projectsBefore = (await dbsOf(ws)).filter((d) => d.name === 'Projects');
    expect([clientsBefore.length, projectsBefore.length]).toEqual([1, 1]);

    const res = await install(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().unmet).toEqual([]);
    expect(res.json().required_packs).toEqual([{ pack: 'agency-os', outcome: 'linked', databases: ['Clients', 'Projects'] }]);
    const dbs = await dbsOf(ws);
    expect(dbs.filter((d) => d.name === 'Clients').map((d) => d.id), 'still the one Agency OS Clients').toEqual([clientsBefore[0]!.id]);
    expect(dbs.filter((d) => d.name === 'Projects').map((d) => d.id)).toEqual([projectsBefore[0]!.id]);

    const clients = await detailById(ws, clientsBefore[0]!.id);
    expect(clients.fields.map((f) => f.displayName)).toEqual(expect.arrayContaining(['Industry', 'Health', 'Sales accounts']));
    const projects = await detailById(ws, projectsBefore[0]!.id);
    expect(projects.fields.map((f) => f.displayName)).toContain('Source deal');
    const accountsDb = dbs.find((d) => d.name === 'Accounts')!;
    expect((await detailById(ws, accountsDb.id)).fields.map((f) => f.displayName)).toContain('Client');
    const dealsDb = dbs.find((d) => d.name === 'Deals')!;
    expect((await detailById(ws, dealsDb.id)).fields.map((f) => f.displayName)).toContain('Projects');
    // Deal Desk's own databases all exist alongside
    for (const n of ['Accounts', 'Deals', 'Activities', 'Quotes', 'Quote Lines', 'Products', 'Competitors']) expect(dbs.map((d) => d.name)).toContain(n);
  });

  it('also_install on a fresh workspace installs Agency OS first and links to it', async () => {
    const ws = await newWs('Also install');
    const res = await install(ws, { required_packs: { 'agency-os': 'also_install' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().required_packs).toEqual([{ pack: 'agency-os', outcome: 'installed_and_linked', databases: ['Clients', 'Projects'] }]);
    const dbs = await dbsOf(ws);
    expect(dbs.filter((d) => d.name === 'Clients')).toHaveLength(1);
    expect(dbs.filter((d) => d.name === 'Projects')).toHaveLength(1);
  });
});
