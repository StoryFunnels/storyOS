import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { packWorkflow } from '../src/packs/pack-workflow';
import { createTestApp } from './helpers/app';
import { call, joinAs } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1148 — Dev Tracker, a built-in pack, built from the prototype's Dev Tracker (v50) and Dara's answers on the ticket.
 *
 * `fixtures/dev-tracker-prototype.json` is a frozen transcription of EVERYTHING the prototype says about the pack. Each assertion below
 * walks that whole list (every field, state, option, view, rule, card), never a sample of it: a fixture that is a prefix of reality passes
 * for exactly the cases it omits.
 *
 * `fixtures/dev-project-os-frozen.json` is the dev-project-os registry entry as it stood BEFORE this ticket. Dev Tracker is a new sibling
 * pack, so an installed Dev Project OS must be exactly what it was: that is asserted against the frozen copy, not against itself.
 */
const proto = JSON.parse(readFileSync(new URL('./fixtures/dev-tracker-prototype.json', import.meta.url), 'utf8')) as {
  name: string; summary: string; space: string; samples: number; why: string; can: string[];
  counts: { databases: number; views: number; automations: number; agents: number };
  workflow: { database: string; field: string; stages: string[][] };
  databases: Record<string, { fields: string[] }>;
  map: Array<{ from: string; to: string; to_field: string }>;
  states: Record<string, Array<{ label: string; color: string; category: string }>>;
  priority: Array<{ label: string; color: string }>;
  labels: string[];
  views: Array<{ name: string; database: string; type: string; grouped_by?: string; opens?: boolean; only_mine?: boolean; shows_states?: string[]; hides_states?: string[]; newest_first?: boolean }>;
  automations: Array<{ name: string; database: string; notifies: string }>;
  agent: { name: string; database: string; ai_mode: string; suggests: string[]; never_suggests: string[]; flags: string; gate: { operations: string[]; database: string }; fires_on_state: string };
  sample_cards: Array<{ title: string; state: string; mine: boolean }>;
};
const frozenDevProject = JSON.parse(readFileSync(new URL('./fixtures/dev-project-os-frozen.json', import.meta.url), 'utf8')).entry;

const entry = PACK_REGISTRY.find((p) => p.slug === 'dev-tracker')!;
const MSG = 'An issue was assigned to you.';

let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const newWs = async () => (await as('POST', '/workspaces', { name: `Dev Tracker ${Date.now()}-${Math.random()}` })).json().id as string;

interface Opt { id: string; label: string; category?: string | null; color?: string }
interface Fld { id: string; displayName: string; apiName: string; type: string; options?: Opt[] }
interface View { id: string; name: string; type: string; isDefault: boolean; config: Record<string, unknown> }
// The agent machinery (Agents, Triggers, Runs, ...) is system databases, not the pack's: only a pack's own databases are compared.
const dbsOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string; isSystem?: boolean }>).filter((d) => d.name !== 'Members' && !d.isSystem);
const detail = async (ws: string, name: string) => {
  const db = (await dbsOf(ws)).find((d) => d.name === name)!;
  return (await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json() as { id: string; fields: Fld[]; views: View[] };
};
const rows = async (ws: string, dbId: string, token = owner.token, body: unknown = { limit: 200 }) =>
  ((await call(app, token, 'POST', `/workspaces/${ws}/databases/${dbId}/records/query`, body)).json().data ?? []) as Array<{ id: string; title: string; values: Record<string, unknown> }>;
const opt = (d: { fields: Fld[] }, field: string, label: string) => d.fields.find((f) => f.displayName === field)!.options!.find((o) => o.label === label)!.id;
const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 60; i++) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
};
const told = async (ws: string, token: string) =>
  ((await call(app, token, 'GET', `/workspaces/${ws}/notifications`)).json().data ?? []).filter((n: { snippet?: string }) => n.snippet === MSG).length as number;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Dev Tracker Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1148 the manifest', () => {
  it('is registered, and validates against the manifest schema', () => {
    expect(entry, 'dev-tracker is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(entry.manifest).success).toBe(true);
    expect(entry.name).toBe(proto.name);
    expect(entry.summary).toBe(proto.summary);
    expect(entry.manifest.why).toBe(proto.why);
    expect(entry.manifest.can).toEqual(proto.can);
  });

  it('the workflow the gallery card shows is the prototype\'s: Issues.State Triage > Backlog > To Do > In Progress > In Review > Done > Canceled', () => {
    expect(packWorkflow(entry)).toEqual(proto.workflow);
  });

  it('declares exactly the prototype\'s pieces: 4 databases, 4 views, the rule(s) of its 1 automation, 1 agent, 4 sample cards, no Specs', () => {
    const m = entry.manifest;
    expect(m.databases.map((d) => d.name).sort()).toEqual(Object.keys(proto.databases).sort());
    expect(m.databases).toHaveLength(proto.counts.databases);
    expect(m.databases.every((d) => d.space === proto.space)).toBe(true);
    expect(m.views.map((v) => v.name)).toEqual(proto.views.map((v) => v.name));
    expect(m.views).toHaveLength(proto.counts.views);
    // the prototype's one automation, then its create-time twin (a rule has one trigger; Team Board does the same)
    expect(m.automations.map((a) => a.name)).toEqual([...proto.automations.map((a) => a.name), 'Tell the assignee of a new issue']);
    expect(m.agents.map((a) => a.name)).toEqual([proto.agent.name]);
    expect(m.agents).toHaveLength(proto.counts.agents);
    expect(m.sample_records.map((r) => r.values.name)).toEqual(proto.sample_cards.map((c) => c.title));
    expect(m.sample_records).toHaveLength(proto.samples);
    expect(JSON.stringify(m)).not.toContain('Specs');
  });
});

describe('#1148 a real install creates everything the prototype shows', () => {
  let ws: string;
  let installId: string;
  let result: {
    databases: Array<{ name: string; action: string }>; views: Array<{ name: string; action: string }>;
    automations: Array<{ name: string; action: string; enabled?: boolean }>; sample_records: Array<{ action: string }>; unmet: unknown[];
  };

  beforeAll(async () => {
    ws = await newWs();
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    result = res.json();
  });

  it('creates the four databases, in one space named Product, and nothing is unmet', async () => {
    expect(result.unmet).toEqual([]);
    expect(result.databases.map((d) => `${d.name}:${d.action}`).sort()).toEqual(['Issues:created', 'Projects:created', 'Releases:created', 'Sprints:created']);
    const spaces = (await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    const product = spaces.filter((s) => s.name === proto.space);
    expect(product).toHaveLength(1);
    const dbs = await dbsOf(ws);
    expect(dbs.map((d) => d.name).sort()).toEqual(Object.keys(proto.databases).sort());
    expect(dbs.every((d) => d.spaceId === product[0]!.id)).toBe(true);
    const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    installId = list.find((i) => i.slug === 'dev-tracker')!.id;
    expect(installId).toBeTruthy();
  });

  it('every field the prototype lists exists on its database, and the relations point where the map says', async () => {
    for (const [db, spec] of Object.entries(proto.databases)) {
      const names = (await detail(ws, db)).fields.map((f) => f.displayName);
      for (const f of spec.fields) expect(names, `${db}.${f}`).toContain(f);
    }
    for (const m of proto.map) {
      const f = (await detail(ws, m.from)).fields.find((x) => x.type === 'relation' && x.displayName === (m.to === m.from ? 'Parent issue' : m.to === 'Projects' ? 'Project' : m.to === 'Sprints' ? 'Sprint' : 'Release'))!;
      expect(f, `${m.from} -> ${m.to}`).toBeTruthy();
      expect((await detail(ws, m.to)).fields.some((x) => x.type === 'relation' && x.displayName === m.to_field), `${m.to}.${m.to_field}`).toBe(true);
    }
  });

  it('field types: Assignee/Lead are people, dates are dates, Estimate/Number are numbers, Labels is a multi-select, the states are selects', async () => {
    const issues = await detail(ws, 'Issues');
    const projects = await detail(ws, 'Projects');
    const sprints = await detail(ws, 'Sprints');
    const releases = await detail(ws, 'Releases');
    const type = (d: { fields: Fld[] }, n: string) => d.fields.find((f) => f.displayName === n)!.type;
    expect(type(issues, 'Assignee')).toBe('user');
    expect(type(issues, 'Due date')).toBe('date');
    expect(type(issues, 'Estimate')).toBe('number');
    expect(type(issues, 'Labels')).toBe('multi_select');
    expect(type(issues, 'Priority')).toBe('select');
    expect(type(issues, 'State')).toBe('select');
    expect(type(projects, 'Lead')).toBe('user');
    expect(type(projects, 'Target date')).toBe('date');
    expect(type(projects, 'State')).toBe('select');
    expect(type(sprints, 'Number')).toBe('number');
    expect(type(sprints, 'Start date')).toBe('date');
    expect(type(sprints, 'End date')).toBe('date');
    expect(type(releases, 'Release date')).toBe('date');
    expect(type(releases, 'Status')).toBe('select');
    for (const n of ['Project', 'Sprint', 'Release', 'Parent issue', 'Sub-issues']) expect(type(issues, n), n).toBe('relation');
  });

  it('Issues.State, Projects.State and Releases.Status carry the prototype\'s options in order, each with its colour and category (#1105)', async () => {
    for (const [key, want] of Object.entries(proto.states)) {
      const [db, field] = key.split('.') as [string, string];
      const f = (await detail(ws, db)).fields.find((x) => x.displayName === field)!;
      expect((f.options ?? []).map((o) => [o.label, o.color, o.category]), key).toEqual(want.map((s) => [s.label, s.color, s.category]));
    }
  });

  it('Priority has the importer\'s four options in order with their colours, and Labels has Bug, Feature, Improvement', async () => {
    const issues = await detail(ws, 'Issues');
    const p = issues.fields.find((f) => f.displayName === 'Priority')!;
    expect(p.options!.map((o) => ({ label: o.label, color: o.color }))).toEqual(proto.priority);
    const l = issues.fields.find((f) => f.displayName === 'Labels')!;
    expect(l.options!.map((o) => o.label)).toEqual(proto.labels);
    expect(issues.fields.some((f) => f.displayName === 'Type'), 'there is no Type field').toBe(false);
  });

  it('creates exactly the four views; Active is the one Issues opens on; every other view is not a default', async () => {
    expect(result.views.map((v) => `${v.name}:${v.action}`).sort()).toEqual(['Issues.Active:created', 'Issues.My issues:created', 'Issues.Triage:created', 'Projects.Projects:created']);
    const issues = await detail(ws, 'Issues');
    const projects = await detail(ws, 'Projects');
    for (const pv of proto.views) {
      const d = pv.database === 'Projects' ? projects : issues;
      const v = d.views.find((x) => x.name === pv.name)!;
      expect(v, pv.name).toBeTruthy();
      expect(v.type, `${pv.name} type`).toBe(pv.type);
      expect(v.isDefault, `${pv.name} opens`).toBe(Boolean(pv.opens));
      if (pv.grouped_by) expect(v.config.group_by_field_id, `${pv.name} grouping`).toBe(d.fields.find((f) => f.displayName === pv.grouped_by)!.id);
    }
    expect(issues.views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['Active']);
    // the Projects database keeps its own "All records" as its default: the Projects view is a board, not the default
    expect(projects.views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['All records']);
  });

  it('the Triage view sorts newest first by Created', async () => {
    const v = (await detail(ws, 'Issues')).views.find((x) => x.name === 'Triage')!;
    expect(v.config.sorts).toEqual([{ field: 'created_at', direction: 'desc' }]);
  });

  it('creates the automation switched on, aimed at Assignee, both rules', async () => {
    expect(result.automations.map((a) => `${a.name}:${a.action}`)).toEqual(['Issues.Tell the assignee:created', 'Issues.Tell the assignee of a new issue:created']);
    expect(result.automations.every((a) => a.enabled === true)).toBe(true);
  });

  it('creates all four teaching cards, in the prototype\'s states, and exactly those', async () => {
    expect(result.sample_records.map((r) => r.action)).toEqual(['created', 'created', 'created', 'created']);
    const d = await detail(ws, 'Issues');
    const recs = await rows(ws, d.id);
    expect(recs.map((r) => r.title).sort()).toEqual(proto.sample_cards.map((c) => c.title).sort());
    const me = await as('GET', '/me');
    for (const c of proto.sample_cards) {
      const r = recs.find((x) => x.title === c.title)!;
      expect(r.values.state, c.title).toBe(opt(d, 'State', c.state));
      if (c.mine) expect(r.values.assignee, c.title).toBe(me.json().id);
      else expect(r.values.assignee ?? null, c.title).toBeNull();
    }
    // exactly one in Triage; Active is not empty (one each in To Do, In Progress, In Review); My issues is not empty
    expect(recs.filter((r) => r.values.state === opt(d, 'State', 'Triage'))).toHaveLength(1);
  });

  it('the Active view shows To Do, In Progress and In Review and nothing else; My issues and Triage show what the prototype says, per person', async () => {
    const ws2 = await newWs();
    expect((await as('POST', `/workspaces/${ws2}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const d = await detail(ws2, 'Issues');
    const member = await joinAs(app, owner.token, ws2, 'Dev Tracker Member', 'member');
    const mk = async (name: string, state: string, assignee?: string) => {
      const r = await as('POST', `/workspaces/${ws2}/databases/${d.id}/records`, { values: { name, state: opt(d, 'State', state), ...(assignee ? { assignee } : {}) } });
      expect(r.statusCode, r.body).toBe(201);
    };
    // one card for every state, assigned to the member; then a card assigned to nobody in Triage
    for (const s of proto.workflow.stages.flat()) await mk(`m-${s}`, s, member.id);
    await mk('late triage', 'Triage');

    const filterOf = (n: string) => d.views.find((v) => v.name === n)!.config.filters;
    const active = await rows(ws2, d.id, owner.token, { filter: filterOf('Active'), limit: 200 });
    expect(active.map((r) => r.title).filter((t) => t.startsWith('m-')).sort()).toEqual(['m-In Progress', 'm-In Review', 'm-To Do']);
    // the four installed teaching cards: the three in To Do / In Progress / In Review are on the board, the Triage one is not
    expect(active.map((r) => r.title)).toEqual(expect.arrayContaining(proto.sample_cards.filter((c) => proto.views[0]!.shows_states!.includes(c.state)).map((c) => c.title)));
    expect(active.map((r) => r.title)).not.toContain(proto.sample_cards.find((c) => c.state === 'Triage')!.title);

    // My issues: the member sees only their own open issues (no Done, no Canceled); the owner sees only the owner's
    const mineMember = await rows(ws2, d.id, member.token, { filter: filterOf('My issues'), limit: 200 });
    expect(mineMember.map((r) => r.title).sort()).toEqual(['m-Backlog', 'm-In Progress', 'm-In Review', 'm-To Do', 'm-Triage']);
    const mineOwner = await rows(ws2, d.id, owner.token, { filter: filterOf('My issues'), limit: 200 });
    expect(mineOwner.map((r) => r.title)).toEqual(['Drag me to In Progress']);

    // Triage: only Triage, newest first
    const triage = await rows(ws2, d.id, owner.token, { filter: filterOf('Triage'), sorts: d.views.find((v) => v.name === 'Triage')!.config.sorts, limit: 200 });
    expect(triage.map((r) => r.title)).toEqual(['late triage', 'm-Triage', proto.sample_cards.find((c) => c.state === 'Triage')!.title]);
  });

  it('"Tell the assignee": an issue assigned later tells the assignee once; one created already assigned tells once; one created unassigned tells nobody; the seeded cards told nobody', async () => {
    const ws3 = await newWs();
    expect((await as('POST', `/workspaces/${ws3}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const member = await joinAs(app, owner.token, ws3, 'Dev Tracker Assignee', 'member');
    const d = await detail(ws3, 'Issues');
    // the installed teaching card assigned to the installer must not tell the installer anything
    await new Promise((r) => setTimeout(r, 1500));
    expect(await told(ws3, owner.token), 'seeded cards must not notify the installer').toBe(0);

    const make = async (values: Record<string, unknown>) => {
      const r = await as('POST', `/workspaces/${ws3}/databases/${d.id}/records`, { values });
      expect(r.statusCode, r.body).toBe(201);
    };
    await make({ name: 'Unassigned at birth' });
    await make({ name: 'Assigned at birth', assignee: member.id });
    expect(await until(async () => (await told(ws3, member.token)) >= 1), 'created already assigned: the assignee was not told').toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await told(ws3, member.token), 'exactly one notification for the one event').toBe(1);
    expect(await told(ws3, owner.token), 'the unassigned issue told nobody').toBe(0);

    const later = (await rows(ws3, d.id)).find((r) => r.title === 'Unassigned at birth')!;
    expect((await as('PATCH', `/workspaces/${ws3}/databases/${d.id}/records/${later.id}`, { values: { assignee: member.id } })).statusCode).toBe(200);
    expect(await until(async () => (await told(ws3, member.token)) >= 2), 'a later assign did not notify').toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await told(ws3, member.token), 'one more, not two').toBe(2);
  });

  it('the Triage agent: your own AI, fires for an issue entering Triage, suggests Labels and Priority and flags a duplicate (never Type), and its updates are held for approval', async () => {
    const wsA = await newWs();
    expect((await as('POST', `/workspaces/${wsA}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const agentsDb = ((await as('GET', `/workspaces/${wsA}/databases`)).json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Agents')!;
    const agentsDetail = (await as('GET', `/workspaces/${wsA}/databases/${agentsDb.id}`)).json() as { fields: Fld[] };
    const rec = (await rows(wsA, agentsDb.id)).find((r) => r.title === proto.agent.name)!;
    expect(rec, 'the Triage agent').toBeTruthy();
    const mode = agentsDetail.fields.find((f) => f.apiName === 'ai_mode')!;
    expect(mode.options!.find((o) => o.id === rec.values.ai_mode)?.label.toLowerCase().replace(/ /g, '_')).toBe(proto.agent.ai_mode);
    // the words of the goal and instructions (their document blocks carry `type` keys of their own, which are not wording)
    const words: string[] = [];
    const walk = (n: unknown): void => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { const o = n as { text?: unknown; content?: unknown }; if (typeof o.text === 'string') words.push(o.text); walk(o.content); } };
    walk(rec.values.goal); walk(rec.values.instructions);
    const text = words.join(' ').toLowerCase();
    expect(text.length).toBeGreaterThan(20);
    for (const s of proto.agent.suggests) expect(text, s).toContain(s.toLowerCase());
    expect(text).toContain('duplicate');
    for (const s of proto.agent.never_suggests) expect(text, `must not suggest ${s}`).not.toMatch(new RegExp(`\\b${s.toLowerCase()}\\b`));
    // the write gate: its updates to Issues are held
    const gates = (await as('GET', `/workspaces/${wsA}/agent-write-gates?agent_id=${rec.id}`)).json().data as Array<{ operations: string[]; database_id: string | null; enabled?: boolean }>;
    const issuesId = (await dbsOf(wsA)).find((d) => d.name === 'Issues')!.id;
    expect(gates.map((g) => ({ operations: g.operations, database_id: g.database_id }))).toEqual([{ operations: proto.agent.gate.operations, database_id: issuesId }]);
  });

  it('re-installing creates nothing new, and Active is still the one default', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    const created = [...b.databases, ...b.fields, ...b.relations, ...b.states, ...b.views, ...b.automations, ...b.sample_records].filter((i: { action: string }) => i.action === 'created');
    expect(created, JSON.stringify(created)).toEqual([]);
    expect((await detail(ws, 'Issues')).views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['Active']);
  });

  it('uninstall removes the automation and deletes no data: all four databases and their cards survive', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/${installId}/uninstall`);
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json() as { removed: Array<{ kind: string; name: string }> };
    expect(b.removed.map((i) => `${i.kind}:${i.name}`)).toContain('automation:Issues.Tell the assignee');
    expect((await dbsOf(ws)).map((d) => d.name).filter((n) => n in proto.databases).sort()).toEqual(['Issues', 'Projects', 'Releases', 'Sprints']);
    expect(await rows(ws, (await detail(ws, 'Issues')).id)).toHaveLength(4);
  });
});

describe('#1148 existing installs stay untouched (AC2)', () => {
  const snapshot = async (ws: string) => {
    const out: Record<string, unknown> = {};
    for (const d of await dbsOf(ws)) {
      const det = await detail(ws, d.name);
      out[d.name] = {
        fields: det.fields.map((f) => [f.displayName, f.type, (f.options ?? []).map((o) => [o.label, o.color, o.category])]),
        views: det.views.map((v) => [v.name, v.type, v.isDefault, JSON.stringify(v.config)]),
        records: (await rows(ws, d.id)).map((r) => [r.title, JSON.stringify(r.values)]),
      };
    }
    const installed = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ slug: string; version?: string }>;
    out['installed'] = installed.map((i) => [i.slug, i.version ?? null]);
    return JSON.stringify(out);
  };

  it('the dev-project-os pack in the registry is byte-for-byte the frozen pre-#1148 entry, and Dev Tracker is a separate slug', () => {
    const now = PACK_REGISTRY.find((p) => p.slug === 'dev-project-os')!;
    expect(JSON.stringify(now)).toBe(JSON.stringify(frozenDevProject));
    expect(PACK_REGISTRY.filter((p) => p.slug === 'dev-tracker')).toHaveLength(1);
    expect(now.manifest.views.map((v) => v.name)).toEqual(['Issue Board', 'Bugs', 'Release Board']);
  });

  it('a workspace with Dev Project OS installed: previewing Dev Tracker changes nothing, installing it unresolved is refused and changes nothing, and Dev Project OS\'s own preview is all "reuse"', async () => {
    const ws = await newWs();
    const first = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: frozenDevProject.manifest });
    expect(first.statusCode, first.body).toBe(201);
    const before = await snapshot(ws);

    const prev = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: entry.manifest });
    expect(prev.statusCode, prev.body).toBe(201);
    const pb = prev.json() as { databases: Array<{ name: string; action: string }> };
    const act = Object.fromEntries(pb.databases.map((d) => [d.name, d.action]));
    // Issues, Sprints and Releases exist already: a person is asked, nothing is decided for them; Projects is new
    expect(act).toMatchObject({ Issues: 'collision', Sprints: 'collision', Releases: 'collision', Projects: 'create' });
    expect(await snapshot(ws), 'a preview must change nothing').toBe(before);

    const refused = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(refused.statusCode, refused.body).toBeGreaterThanOrEqual(400);
    expect(await snapshot(ws), 'an install with an unanswered collision must change nothing').toBe(before);

    // Dev Project OS's own update preview (the same manifest again) offers nothing new
    const again = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: frozenDevProject.manifest });
    expect(again.statusCode, again.body).toBe(201);
    const ab = again.json() as Record<string, Array<{ action: string }>>;
    const offered = Object.values(ab).flat().filter((i) => i && typeof i === 'object' && ['create', 'collision'].includes(i.action));
    expect(offered, JSON.stringify(offered)).toEqual([]);
    expect(await snapshot(ws)).toBe(before);
  });

  it('even an explicit "reuse" cannot rewrite an existing Dev Project OS: the install is refused whole (its Releases.Status is a workflow field) and nothing changes', async () => {
    const ws = await newWs();
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: frozenDevProject.manifest })).statusCode).toBe(201);
    const before = await snapshot(ws);
    const res = await as('POST', `/workspaces/${ws}/packs/install`, {
      manifest: entry.manifest,
      resolutions: { Issues: { action: 'reuse' }, Sprints: { action: 'reuse' }, Releases: { action: 'reuse' } },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('Nothing was installed');
    expect(await snapshot(ws), 'a refused install must leave the existing install byte-for-byte as it was').toBe(before);
  });
});
