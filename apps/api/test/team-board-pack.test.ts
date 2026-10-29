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
 * ticket #1146 — Team Board, a built-in pack, built from the prototype's Team Board.
 *
 * `fixtures/team-board-prototype.json` is a frozen transcription of EVERYTHING the prototype says about the pack. Each assertion below walks
 * that whole list (every field, state, view, card), never a sample of it: a fixture that is a prefix of reality passes for exactly the cases
 * it omits.
 */
const proto = JSON.parse(readFileSync(new URL('./fixtures/team-board-prototype.json', import.meta.url), 'utf8')) as {
  name: string; summary: string; space: string; samples: number; why: string; can: string[];
  workflow: { database: string; field: string; stages: string[][] };
  databases: Record<string, { fields: string[] }>;
  map: Array<{ from: string; to: string; to_field?: string }>;
  states: Array<{ label: string; category: string }>;
  views: Array<{ name: string; database: string; grouped_by?: string; opens?: boolean; only_mine?: boolean }>;
  automations: Array<{ name: string; database: string; notifies: string }>;
  sample_cards: Array<{ title: string; status: string }>;
};

const entry = PACK_REGISTRY.find((p) => p.slug === 'team-board')!;

let app: NestFastifyApplication;
let owner: { token: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const newWs = async () => (await as('POST', '/workspaces', { name: `Team Board ${Date.now()}` })).json().id as string;

interface Opt { id: string; label: string; category?: string | null }
interface Fld { id: string; displayName: string; apiName: string; type: string; options?: Opt[] }
interface View { id: string; name: string; type: string; isDefault: boolean; config: Record<string, unknown> }
const dbsOf = async (ws: string) => ((await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId: string }>).filter((d) => d.name !== 'Members');
const detail = async (ws: string, name: string) => {
  const db = (await dbsOf(ws)).find((d) => d.name === name)!;
  return (await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json() as { id: string; fields: Fld[]; views: View[] };
};
const rows = async (ws: string, dbId: string, token = owner.token, body: unknown = { limit: 200 }) =>
  ((await call(app, token, 'POST', `/workspaces/${ws}/databases/${dbId}/records/query`, body)).json().data ?? []) as Array<{ id: string; title: string; values: Record<string, unknown> }>;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Team Board Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1146 the manifest', () => {
  it('is registered, and validates against the manifest schema', () => {
    expect(entry, 'team-board is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(entry.manifest).success).toBe(true);
    expect(entry.name).toBe(proto.name);
    expect(entry.summary).toBe(proto.summary);
    expect(entry.manifest.why).toBe(proto.why);
    expect(entry.manifest.can).toEqual(proto.can);
  });

  it('the workflow the gallery card shows is the prototype\'s: Tasks.Status To Do > In Progress > Done', () => {
    expect(packWorkflow(entry)).toEqual(proto.workflow);
  });

  it('declares exactly the prototype\'s pieces: 2 databases, 2 views, 1 automation, no agent, 3 sample cards', () => {
    const m = entry.manifest;
    expect(m.databases.map((d) => d.name).sort()).toEqual(Object.keys(proto.databases).sort());
    expect(m.databases.every((d) => d.space === proto.space)).toBe(true);
    expect(m.views.map((v) => v.name)).toEqual(proto.views.map((v) => v.name));
    expect(m.automations.map((a) => a.name)).toEqual(proto.automations.map((a) => a.name));
    expect(m.agents).toEqual([]);
    expect(m.sample_records.map((r) => r.values.name)).toEqual(proto.sample_cards.map((c) => c.title));
    expect(m.sample_records).toHaveLength(proto.samples);
  });
});

describe('#1146 a real install creates everything the prototype shows', () => {
  let ws: string;
  let installId: string;
  let result: { databases: Array<{ name: string; action: string }>; views: Array<{ name: string; action: string }>; automations: Array<{ name: string; action: string; enabled?: boolean }>; sample_records: Array<{ action: string }>; unmet: unknown[] };

  beforeAll(async () => {
    ws = await newWs();
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    result = res.json();
  });

  it('creates both databases, in one space named Team, and nothing is unmet', async () => {
    expect(result.unmet).toEqual([]);
    expect(result.databases.map((d) => `${d.name}:${d.action}`).sort()).toEqual(['Projects:created', 'Tasks:created']);
    const spaces = (await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    const team = spaces.filter((s) => s.name === proto.space);
    expect(team).toHaveLength(1);
    const dbs = await dbsOf(ws);
    expect(dbs.map((d) => d.name).sort()).toEqual(Object.keys(proto.databases).sort());
    expect(dbs.every((d) => d.spaceId === team[0]!.id)).toBe(true);
    const list = (await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>;
    installId = list.find((i) => i.slug === 'team-board')!.id;
    expect(installId).toBeTruthy();
  });

  it('every field the prototype lists exists on its database (Project, Sub-tasks and the Projects-side Tasks link included)', async () => {
    for (const [db, spec] of Object.entries(proto.databases)) {
      const names = (await detail(ws, db)).fields.map((f) => f.displayName);
      for (const f of spec.fields) expect(names, `${db}.${f}`).toContain(f);
    }
  });

  it('field types: Assignee/Owner are people, Due date/Target date are dates, Labels is a multi-select, Status is a select (a state is a select, ADR-0010)', async () => {
    const tasks = await detail(ws, 'Tasks');
    const projects = await detail(ws, 'Projects');
    const type = (d: { fields: Fld[] }, n: string) => d.fields.find((f) => f.displayName === n)!.type;
    expect(type(tasks, 'Assignee')).toBe('user');
    expect(type(tasks, 'Due date')).toBe('date');
    expect(type(tasks, 'Labels')).toBe('multi_select');
    expect(type(tasks, 'Status')).toBe('select');
    expect(type(projects, 'Owner')).toBe('user');
    expect(type(projects, 'Target date')).toBe('date');
    expect(type(tasks, 'Project')).toBe('relation');
    expect(type(tasks, 'Sub-tasks')).toBe('relation');
    expect(type(projects, 'Tasks')).toBe('relation');
  });

  it('Status has exactly To Do, In Progress, Done, in that order, each with its category stored (#1105)', async () => {
    const status = (await detail(ws, 'Tasks')).fields.find((f) => f.displayName === 'Status')!;
    expect((status.options ?? []).map((o) => [o.label, o.category])).toEqual(proto.states.map((s) => [s.label, s.category]));
  });

  it('creates Board and Assigned to me; Board groups by Status and is the view the database opens on; Assigned to me is not', async () => {
    expect(result.views.map((v) => `${v.name}:${v.action}`).sort()).toEqual(['Tasks.Assigned to me:created', 'Tasks.Board:created']);
    const d = await detail(ws, 'Tasks');
    const status = d.fields.find((f) => f.displayName === 'Status')!;
    for (const pv of proto.views) {
      const v = d.views.find((x) => x.name === pv.name)!;
      expect(v, pv.name).toBeTruthy();
      expect(v.isDefault, `${pv.name} opens`).toBe(Boolean(pv.opens));
      if (pv.grouped_by) expect(v.config.group_by_field_id).toBe(status.id);
    }
    const defaults = d.views.filter((v) => v.isDefault);
    expect(defaults.map((v) => v.name)).toEqual(['Board']); // exactly one default per database
    // Projects was given no views by the pack: it keeps its own "All records" default.
    expect((await detail(ws, 'Projects')).views.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it('creates the automation switched on, aimed at Assignee', async () => {
    expect(result.automations.map((a) => `${a.name}:${a.action}`)).toEqual(['Tasks.Tell the assignee:created']);
    expect(result.automations[0]!.enabled).toBe(true);
  });

  it('creates all three teaching cards, each in To Do, and exactly those', async () => {
    expect(result.sample_records.map((r) => r.action)).toEqual(['created', 'created', 'created']);
    const d = await detail(ws, 'Tasks');
    const todo = d.fields.find((f) => f.displayName === 'Status')!.options!.find((o) => o.label === 'To Do')!.id;
    const recs = await rows(ws, d.id);
    expect(recs.map((r) => r.title).sort()).toEqual(proto.sample_cards.map((c) => c.title).sort());
    for (const r of recs) expect(r.values.status, String(r.title)).toBe(todo);
    const card = (t: string) => recs.find((r) => r.title === t)!;
    expect(card('Open me and set a due date').values.due_date ?? null, 'the due-date card must have none to set').toBeNull();
    expect(card('Assign me to someone').values.assignee ?? null, 'the assign card must be unassigned').toBeNull();
  });

  it('"Assigned to me" shows each person only their own cards (a member sees none of the owner\'s; the owner sees theirs)', async () => {
    const d = await detail(ws, 'Tasks');
    const view = d.views.find((v) => v.name === 'Assigned to me')!;
    const filter = view.config.filters;
    const mine = await rows(ws, d.id, owner.token, { filter, limit: 200 });
    expect(mine.map((r) => r.title)).toEqual(['Drag me to In Progress']);
    const member = await joinAs(app, owner.token, ws, 'Team Board Member', 'member');
    expect(await rows(ws, d.id, member.token, { filter, limit: 200 }), 'a teammate must not see the owner\'s card').toEqual([]);
    // assign another card to the member: it appears for them, still not for the owner
    const other = (await rows(ws, d.id)).find((r) => r.title === 'Assign me to someone')!;
    const upd = await as('PATCH', `/workspaces/${ws}/databases/${d.id}/records/${other.id}`, { values: { assignee: member.id } });
    expect(upd.statusCode, upd.body).toBe(200);
    expect((await rows(ws, d.id, member.token, { filter, limit: 200 })).map((r) => r.title)).toEqual(['Assign me to someone']);
    expect((await rows(ws, d.id, owner.token, { filter, limit: 200 })).map((r) => r.title)).toEqual(['Drag me to In Progress']);

    // "Tell the assignee": the person it was assigned to is told (the rule runs off the request, so allow it a moment)
    let told = false;
    for (let i = 0; i < 40 && !told; i++) {
      const notes = (await call(app, member.token, 'GET', `/workspaces/${ws}/notifications`)).json() as { data?: Array<{ snippet?: string }> };
      told = (notes.data ?? []).some((n) => n.snippet === 'A task was assigned to you.');
      if (!told) await new Promise((r) => setTimeout(r, 250));
    }
    expect(told, 'the assignee was not notified by "Tell the assignee"').toBe(true);
  });

  it('re-installing creates nothing new', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    const created = [...b.databases, ...b.fields, ...b.relations, ...b.states, ...b.views, ...b.automations, ...b.sample_records].filter((i: { action: string }) => i.action === 'created');
    expect(created, JSON.stringify(created)).toEqual([]);
    expect((await detail(ws, 'Tasks')).views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['Board']);
  });

  it('uninstall removes the automation and deletes no data: both databases, their cards and the default Board all survive', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/${installId}/uninstall`);
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json() as { removed: Array<{ kind: string; name: string }>; kept: Array<{ kind: string; name: string; reason?: string }> };
    expect(b.removed.map((i) => `${i.kind}:${i.name}`)).toContain('automation:Tasks.Tell the assignee');
    // a database's default view is never removed (so the Board stays); which list it is reported in is not part of this contract
    expect(b.removed.map((i) => i.name)).not.toContain('Tasks.Board');
    expect((await dbsOf(ws)).map((d) => d.name).sort()).toEqual(['Projects', 'Tasks']);
    const d = await detail(ws, 'Tasks');
    expect(d.views.some((v) => v.name === 'Board' && v.isDefault)).toBe(true);
    expect(await rows(ws, d.id)).toHaveLength(3);
  });
});

describe('#1146 the default view is the pack\'s to set only on a database the pack made', () => {
  it('installing into a database that already exists keeps that database\'s own default view', async () => {
    const ws = await newWs();
    const pre = await as('POST', `/workspaces/${ws}/databases`, { name: 'Tasks', space_id: ((await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; personal?: boolean }>).find((s) => !s.personal)!.id });
    expect(pre.statusCode, pre.body).toBe(201);
    const before = await detail(ws, 'Tasks');
    const defaultBefore = before.views.find((v) => v.isDefault)!.name;
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest, resolutions: { Tasks: { action: 'reuse' } } });
    expect(res.statusCode, res.body).toBe(201);
    const after = await detail(ws, 'Tasks');
    expect(after.views.some((v) => v.name === 'Board')).toBe(true);
    expect(after.views.filter((v) => v.isDefault).map((v) => v.name)).toEqual([defaultBefore]);
  });
});
