import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';
import { PACK_REGISTRY } from '../src/packs/registry';

/**
 * ticket #1333 — "New" on a filtered view lands the record INSIDE the view.
 *
 * `POST .../records` takes an optional `view_id`. The values that view's filter requires go UNDER what the request supplied, and the
 * response carries `view_match` (did the record land inside, and which conditions are unmet) from the same evaluator every view uses.
 *
 * The case that shipped the bug is the REAL Dev Tracker pack: Active filters State to To Do / In Progress / In Review, and a new issue
 * started in Triage and was gone. It is installed through the real install path, not rebuilt from a fixture.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: Person;
let guest: Person;
let ws: string;
let space: string;

const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const cfg = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };

interface F { id: string; apiName: string; type: string; options?: Array<{ id: string; label: string }> }
const fieldsOf = async (db: string) => ((await fx(admin.token, 'GET', `/workspaces/${ws}/databases/${db}`)).fields as F[]);
const optionId = (f: F, label: string) => f.options!.find((o) => o.label === label)!.id;
const labelOf = (f: F, id: unknown) => (id == null ? null : (f.options!.find((o) => o.id === id)?.label ?? `?${String(id)}`));

interface Fixture { db: string; state: F; priority: F; ids: (label: string) => string }
async function newDb(name: string): Promise<Fixture> {
  const db = (await fx(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name })).id as string;
  await fx(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, {
    display_name: 'State', type: 'workflow', config: {}, options: ['Triage', 'Backlog', 'To do', 'In progress', 'Done'].map((label) => ({ label })),
  });
  await fx(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Priority', type: 'select', config: {}, options: [{ label: 'Low' }, { label: 'High' }] });
  await fx(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Notes', type: 'text', config: {} });
  await fx(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Assignee', type: 'user', config: {} });
  const f = await fieldsOf(db);
  const state = f.find((x) => x.apiName === 'state')!;
  return { db, state, priority: f.find((x) => x.apiName === 'priority')!, ids: (label) => optionId(state, label) };
}
const makeView = async (db: string, filters: unknown, personal = false, token = admin.token) =>
  (await fx(token, 'POST', `/workspaces/${ws}/databases/${db}/views${personal ? '/personal' : ''}`, { name: `v${Math.random().toString(36).slice(2, 7)}`, type: 'table', config: { ...cfg, filters } })).id as string;
const createIn = (token: string, db: string, body: Record<string, unknown>) => call(app, token, 'POST', `/workspaces/${ws}/databases/${db}/records`, body);
type Created = { id: string; values: Record<string, unknown>; view_match?: { matches: boolean; unmet: string[] } };
const made = async (token: string, db: string, body: Record<string, unknown>) => {
  const r = await createIn(token, db, body);
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as Created;
};

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'View Create Admin');
  ws = (await fx(admin.token, 'POST', '/workspaces', { name: 'View Create WS' })).id;
  space = (await fx(admin.token, 'GET', `/workspaces/${ws}/spaces`))[0].id;
  member = await joinAs(app, admin.token, ws, 'View Create Member', 'member');
}, 120_000);
afterAll(async () => { await app.close(); });

describe('the real Dev Tracker pack: New on Active creates the issue in To Do, and it stays visible', () => {
  let issues: string;
  let activeView: string;
  let triageView: string;
  let state: F;
  beforeAll(async () => {
    const entry = PACK_REGISTRY.find((p) => p.slug === 'dev-tracker')!;
    const w = (await fx(admin.token, 'POST', '/workspaces', { name: 'Dev Tracker WS' })).id as string;
    const installed = await fx(admin.token, 'POST', `/workspaces/${w}/packs/install`, { manifest: entry.manifest, required_packs: {} });
    expect(installed).toBeTruthy();
    // this describe runs in its own workspace
    const dbs = (await fx(admin.token, 'GET', `/workspaces/${w}/databases`)) as Array<{ id: string; name: string }>;
    issues = dbs.find((d) => d.name === 'Issues')!.id;
    const detail = await fx(admin.token, 'GET', `/workspaces/${w}/databases/${issues}`);
    state = (detail.fields as F[]).find((f) => f.apiName === 'state')!;
    activeView = (detail.views as Array<{ id: string; name: string }>).find((v) => v.name === 'Active')!.id;
    triageView = (detail.views as Array<{ id: string; name: string }>).find((v) => v.name === 'Triage')!.id;
    realWs = w;
  }, 60_000);
  let realWs: string;
  const make = async (body: Record<string, unknown>) => {
    const r = await call(app, admin.token, 'POST', `/workspaces/${realWs}/databases/${issues}/records`, body);
    expect(r.statusCode, r.body).toBe(201);
    return r.json() as Created;
  };

  it('with the Active view: To Do, matches', async () => {
    const r = await make({ values: { name: 'From Active' }, view_id: activeView });
    expect(labelOf(state, r.values['state'])).toBe('To Do');
    expect(r.view_match).toEqual({ matches: true, unmet: [] });
    // and it really is in the view, asked of the query path itself
    const view = ((await fx(admin.token, 'GET', `/workspaces/${realWs}/databases/${issues}`)).views as Array<{ id: string; config: { filters: unknown } }>).find((v) => v.id === activeView)!;
    const q = await fx(admin.token, 'POST', `/workspaces/${realWs}/databases/${issues}/records/query`, { filter: view.config.filters, limit: 200 });
    expect((q.data as Array<{ id: string }>).some((x) => x.id === r.id)).toBe(true);
  });

  it('KEPT: without a view context a new issue still starts in Triage, and there is no view_match key', async () => {
    const r = await make({ values: { name: 'Plain New' } });
    expect(labelOf(state, r.values['state'])).toBe('Triage');
    expect('view_match' in r).toBe(false);
  });

  it('the Triage view (the first state is allowed there): Triage, matches', async () => {
    const r = await make({ values: { name: 'From Triage' }, view_id: triageView });
    expect(labelOf(state, r.values['state'])).toBe('Triage');
    expect(r.view_match?.matches).toBe(true);
  });

  it('an explicit state wins over the view, and the response says it does not match', async () => {
    const r = await make({ values: { name: 'Explicit', state: optionIdOf(state, 'Done') }, view_id: activeView });
    expect(labelOf(state, r.values['state'])).toBe('Done');
    expect(r.view_match).toEqual({ matches: false, unmet: ['state'] });
  });
});
const optionIdOf = (f: F, label: string) => f.options!.find((o) => o.label === label)!.id;

describe('what a filter requires, and what it cannot', () => {
  it('state in (several): the first allowed state in WORKFLOW order, not the order the filter lists them', async () => {
    const t = await newDb('In list');
    const v = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('In progress'), t.ids('To do')] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('To do');
    expect(r.view_match).toEqual({ matches: true, unmet: [] });
  });

  it('an AND of two filters sets both fields', async () => {
    const t = await newDb('AND');
    const v = await makeView(t.db, { and: [{ field: 'state', op: 'has', value: [t.ids('In progress')] }, { field: 'priority', op: 'has', value: [optionId(t.priority, 'High')] }] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('In progress');
    expect(labelOf(t.priority, r.values['priority'])).toBe('High');
    expect(r.view_match).toEqual({ matches: true, unmet: [] });
  });

  it('an exclusion on a state takes the first state that is left (is not Triage or Backlog: To do)', async () => {
    const t = await newDb('Exclusion');
    const v = await makeView(t.db, { field: 'state', op: 'has_none', value: [t.ids('Triage'), t.ids('Backlog')] });
    expect(labelOf(t.state, (await made(admin.token, t.db, { values: { name: 'a' }, view_id: v })).values['state'])).toBe('To do');
  });

  it('an exclusion on a PLAIN select with two options left is ambiguous: nothing is set, and it still matches', async () => {
    const t = await newDb('Exclusion plain');
    await fx(admin.token, 'POST', `/workspaces/${ws}/databases/${t.db}/fields`, { display_name: 'Size', type: 'select', config: {}, options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }] });
    const size = (await fieldsOf(t.db)).find((f) => f.apiName === 'size')!;
    const v = await makeView(t.db, { field: 'size', op: 'has_none', value: [optionId(size, 'S')] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(r.values['size'] ?? null).toBeNull();
    // matches (an empty Size is "not S"), and nothing was guessed
    expect(r.view_match).toEqual({ matches: true, unmet: [] });
  });

  it('a state category filter (started) takes the first option of that category', async () => {
    const t = await newDb('Category');
    const v = await makeView(t.db, { field: 'state', op: 'category_is', value: ['started'] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    const stateNow = (await fieldsOf(t.db)).find((f) => f.apiName === 'state')!;
    expect(r.view_match?.matches, JSON.stringify({ state: labelOf(stateNow, r.values['state']) })).toBe(true);
  });

  it('an OR on one field uses the union; an OR across DIFFERENT fields is ambiguous: nothing derived, flagged', async () => {
    const t = await newDb('OR');
    const same = await makeView(t.db, { or: [{ field: 'state', op: 'has', value: [t.ids('Done')] }, { field: 'state', op: 'has', value: [t.ids('In progress')] }] });
    expect(labelOf(t.state, (await made(admin.token, t.db, { values: { name: 'a' }, view_id: same })).values['state'])).toBe('In progress');

    const mixed = await makeView(t.db, { or: [{ field: 'state', op: 'has', value: [t.ids('Done')] }, { field: 'priority', op: 'has', value: [optionId(t.priority, 'High')] }] });
    const r = await made(admin.token, t.db, { values: { name: 'b' }, view_id: mixed });
    expect(labelOf(t.state, r.values['state']), 'the usual first-state default, not a guess between the branches').toBe('Triage');
    expect(r.values['priority'] ?? null).toBeNull();
    expect(r.view_match?.matches).toBe(false);
    expect(r.view_match?.unmet.sort()).toEqual(['priority', 'state']);
  });

  it('contradictory filters leave the field to its usual default and report it unmet', async () => {
    const t = await newDb('Contradiction');
    const v = await makeView(t.db, { and: [{ field: 'state', op: 'has', value: [t.ids('Done')] }, { field: 'state', op: 'has_none', value: [t.ids('Done')] }] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('Triage');
    expect(r.view_match?.matches).toBe(false);
    expect(r.view_match?.unmet).toContain('state');
  });

  it('a text "contains" cannot be satisfied: the field stays empty and is reported unmet', async () => {
    const t = await newDb('Contains');
    const v = await makeView(t.db, { and: [{ field: 'state', op: 'has', value: [t.ids('To do')] }, { field: 'notes', op: 'contains', value: 'urgent' }] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('To do'); // the derivable half still lands
    expect(r.values['notes'] ?? null).toBeNull();
    expect(r.view_match).toEqual({ matches: false, unmet: ['notes'] });
  });

  it('a text equals sets the text; a user filter "me" sets the caller', async () => {
    const t = await newDb('Eq and me');
    const v = await makeView(t.db, { and: [{ field: 'notes', op: 'eq', value: 'standup' }, { field: 'assignee', op: 'has', value: ['me'] }] });
    const r = await made(member.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(r.values['notes']).toBe('standup');
    expect(r.values['assignee']).toBe(member.id);
    expect(r.view_match).toEqual({ matches: true, unmet: [] });
  });

  it('is_empty asks for an explicit empty, which also stops the first-state default', async () => {
    const t = await newDb('Is empty');
    const v = await makeView(t.db, { field: 'state', op: 'is_empty' });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(r.values['state'] ?? null).toBeNull();
    expect(r.view_match?.matches).toBe(true);
  });

  it('half-written and disabled conditions constrain nothing (unconfigured is not invalid)', async () => {
    const t = await newDb('Unconfigured');
    const v = await makeView(t.db, { and: [{ field: 'state', op: 'has', value: [] }, { field: 'priority', op: 'has', value: [optionId(t.priority, 'High')], disabled: true }] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('Triage');
    expect(r.values['priority'] ?? null).toBeNull();
    expect(r.view_match?.matches).toBe(true);
  });

  it('a value the create could not accept (a member who left) is dropped: the create still succeeds, the field is reported unmet', async () => {
    const t = await newDb('Dangling user');
    const v = await makeView(t.db, { field: 'assignee', op: 'has', value: ['not-a-member-any-more'] });
    const r = await made(admin.token, t.db, { values: { name: 'a' }, view_id: v });
    expect(r.values['assignee'] ?? null).toBeNull();
    expect(r.view_match).toEqual({ matches: false, unmet: ['assignee'] });
  });
});

describe('explicit values always win', () => {
  it('a supplied value beats the view, and so does an explicit null', async () => {
    const t = await newDb('Explicit');
    const v = await makeView(t.db, { and: [{ field: 'state', op: 'has', value: [t.ids('To do')] }, { field: 'priority', op: 'has', value: [optionId(t.priority, 'High')] }] });
    const r = await made(admin.token, t.db, { values: { name: 'a', state: t.ids('Backlog'), priority: null }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('Backlog');
    expect(r.values['priority'] ?? null).toBeNull();
    expect(r.view_match).toEqual({ matches: false, unmet: ['state', 'priority'] });
  });
});

describe('a view the caller cannot read adds nothing and says nothing', () => {
  it("another member's PERSONAL view: no defaults, no view_match, and the same answer as an id that does not exist", async () => {
    const t = await newDb('Personal');
    const mine = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('Done')] }, true, member.token);
    const ghost = '00000000-0000-4000-8000-000000000001';
    for (const [who, viewId] of [[admin.token, mine], [admin.token, ghost]] as const) {
      const r = await made(who, t.db, { values: { name: 'a' }, view_id: viewId });
      expect(labelOf(t.state, r.values['state']), 'the usual default, nothing from the view').toBe('Triage');
      expect('view_match' in r).toBe(false);
    }
    // the owner still gets their own personal view
    const own = await made(member.token, t.db, { values: { name: 'b' }, view_id: mine });
    expect(labelOf(t.state, own.values['state'])).toBe('Done');
    expect(own.view_match?.matches).toBe(true);
  });

  it('a view of a DIFFERENT database, and a trashed view, are no context', async () => {
    const a = await newDb('Other A');
    const b = await newDb('Other B');
    const inA = await makeView(a.db, { field: 'state', op: 'has', value: [a.ids('Done')] });
    const r = await made(admin.token, b.db, { values: { name: 'x' }, view_id: inA });
    expect(labelOf(b.state, r.values['state'])).toBe('Triage');
    expect('view_match' in r).toBe(false);

    await fx(admin.token, 'DELETE', `/workspaces/${ws}/databases/${a.db}/views/${inA}`);
    const gone = await made(admin.token, a.db, { values: { name: 'y' }, view_id: inA });
    expect(labelOf(a.state, gone.values['state'])).toBe('Triage');
    expect('view_match' in gone).toBe(false);
  });

  it('a GUEST with contributor on the database gets the same as everyone for a shared view, and nothing from a personal one of someone else', async () => {
    const t = await newDb('Guest');
    guest = await joinAs(app, admin.token, ws, 'View Create Guest', 'guest', [{ database_id: t.db, role: 'contributor' }]);
    const shared = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('In progress')] });
    const r = await made(guest.token, t.db, { values: { name: 'g' }, view_id: shared });
    expect(labelOf(t.state, r.values['state'])).toBe('In progress');
    expect(r.view_match?.matches).toBe(true);

    const private_ = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('Done')] }, true, member.token);
    const n = await made(guest.token, t.db, { values: { name: 'g2' }, view_id: private_ });
    expect(labelOf(t.state, n.values['state'])).toBe('Triage');
    expect('view_match' in n).toBe(false);
  });
});

describe('the caller\'s own personal filter on a view counts: it is what they see', () => {
  it('shared (In progress or Done) AND my override (Done) gives Done', async () => {
    const t = await newDb('Override');
    const v = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('In progress'), t.ids('Done')] });
    expect(labelOf(t.state, (await made(member.token, t.db, { values: { name: 'a' }, view_id: v })).values['state'])).toBe('In progress');
    await fx(member.token, 'PUT', `/workspaces/${ws}/databases/${t.db}/views/${v}/personal-filter`, { filter: { field: 'state', op: 'has', value: [t.ids('Done')] } });
    const r = await made(member.token, t.db, { values: { name: 'b' }, view_id: v });
    expect(labelOf(t.state, r.values['state'])).toBe('Done');
    expect(r.view_match?.matches).toBe(true);
    // somebody else's override is not mine
    expect(labelOf(t.state, (await made(admin.token, t.db, { values: { name: 'c' }, view_id: v })).values['state'])).toBe('In progress');
  });
});

describe('other create paths are unchanged', () => {
  it('batch create ignores a view context and keeps the first-state default (only the single create is a "New on a view")', async () => {
    const t = await newDb('Batch');
    const v = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('Done')] });
    const res = await call(app, admin.token, 'POST', `/workspaces/${ws}/databases/${t.db}/records/batch`, { view_id: v, records: [{ values: { name: 'a' } }] });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json().data[0] as Created;
    expect(labelOf(t.state, row.values['state'])).toBe('Triage');
    expect('view_match' in row).toBe(false);
  });

  it('duplicate copies the record: a view context is not read', async () => {
    const t = await newDb('Duplicate');
    const orig = await made(admin.token, t.db, { values: { name: 'orig', state: t.ids('Backlog') } });
    const v = await makeView(t.db, { field: 'state', op: 'has', value: [t.ids('Done')] });
    const res = await call(app, admin.token, 'POST', `/workspaces/${ws}/databases/${t.db}/records/${orig.id}/duplicate`, { view_id: v });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(labelOf(t.state, res.json().values['state'])).toBe('Backlog');
  });
});
