import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { blocksToMarkdown, packManifestSchema } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { packWorkflow } from '../src/packs/pack-workflow';
import { AutomationsService } from '../src/automations/automations.service';
import { automations } from '../src/db/schema';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { call, joinAs } from './helpers/members';
import { signUpUser } from './helpers/users';

/**
 * ticket #1147 — Team Wiki, a built-in pack, built from the prototype's Team Wiki and the four starter pages posted on the ticket.
 *
 * `fixtures/team-wiki-prototype.json` is a frozen transcription of EVERYTHING the prototype says about the pack. Each assertion below
 * walks that whole list (every field, state, view, page, line of body), never a sample of it: a fixture that is a prefix of reality
 * passes for exactly the cases it omits.
 */
const proto = JSON.parse(readFileSync(new URL('./fixtures/team-wiki-prototype.json', import.meta.url), 'utf8')) as {
  name: string; summary: string; space: string; why: string; can: string[];
  workflow: { database: string; field: string; stages: string[][] };
  databases: Record<string, { fields: string[] }>;
  states: Array<{ label: string; category: string }>;
  views: Array<{ name: string; grouped_by?: string; opens?: boolean; only_mine?: boolean; older_than_days?: number }>;
  automations: string[];
  teams: string[];
  pages: Array<{ title: string; parent: string | null; must_contain: string[]; must_not_contain?: string[] }>;
};

const entry = PACK_REGISTRY.find((p) => p.slug === 'team-wiki')!;

let app: NestFastifyApplication;
let owner: { token: string; id?: string };
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);
const newWs = async () => (await as('POST', '/workspaces', { name: `Team Wiki ${Date.now()}` })).json().id as string;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

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
const chips = (v: unknown) => ((v ?? []) as Array<{ id: string }>).map((c) => c.id);
const bodyOf = async (ws: string, dbId: string, recId: string) => {
  const doc = (await as('GET', `/workspaces/${ws}/databases/${dbId}/records/${recId}/document`)).json() as { content: unknown };
  return doc.content ? blocksToMarkdown(doc.content) : '';
};
const notesFor = async (token: string, ws: string, snippet: string) =>
  (((await call(app, token, 'GET', `/workspaces/${ws}/notifications`)).json() as { data?: Array<{ snippet?: string }> }).data ?? []).filter((n) => n.snippet === snippet);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Team Wiki Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1147 the manifest', () => {
  it('is registered, validates, and carries the prototype\'s name, summary, why and can', () => {
    expect(entry, 'team-wiki is not in PACK_REGISTRY').toBeTruthy();
    expect(packManifestSchema.safeParse(entry.manifest).success).toBe(true);
    expect(entry.name).toBe(proto.name);
    expect(entry.summary).toBe(proto.summary);
    expect(entry.manifest.why).toBe(proto.why);
    expect(entry.manifest.can).toEqual(proto.can);
  });

  it('the gallery workflow is Pages.Status Draft > Verified > Needs review', () => {
    expect(packWorkflow(entry)).toEqual(proto.workflow);
  });

  it('declares exactly the prototype\'s pieces: 2 databases, 3 views, 2 rules, the Everyone team and the 4 pages (each with a body)', () => {
    const m = entry.manifest;
    expect(m.databases.map((d) => d.name).sort()).toEqual(Object.keys(proto.databases).sort());
    expect(m.databases.every((d) => d.space === proto.space)).toBe(true);
    expect(m.views.map((v) => v.name)).toEqual(proto.views.map((v) => v.name));
    expect(m.automations.map((a) => a.name)).toEqual(proto.automations);
    expect(m.agents).toEqual([]);
    expect(m.sample_records.filter((r) => r.database === 'Teams').map((r) => r.values.name)).toEqual(proto.teams);
    expect(m.sample_records.filter((r) => r.database === 'Pages').map((r) => r.values.name)).toEqual(proto.pages.map((p) => p.title));
    for (const r of m.sample_records.filter((x) => x.database === 'Pages')) expect(r.description, String(r.values.name)).toBeTruthy();
  });

  it('no starter page is a placeholder', () => {
    for (const r of entry.manifest.sample_records) expect((r.description ?? '').toLowerCase()).not.toContain('placeholder');
  });
});

describe('#1147 a real install creates everything the prototype shows', () => {
  let ws: string;
  let installId: string;
  let result: { databases: Array<{ name: string; action: string }>; views: Array<{ name: string; action: string }>; automations: Array<{ name: string; action: string; enabled?: boolean }>; sample_records: Array<{ action: string }>; unmet: unknown[] };

  beforeAll(async () => {
    ws = await newWs();
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    result = res.json();
  });

  it('creates both databases in one space named Wiki, and nothing is unmet', async () => {
    expect(result.unmet).toEqual([]);
    expect(result.databases.map((d) => `${d.name}:${d.action}`).sort()).toEqual(['Pages:created', 'Teams:created']);
    const spaces = (await as('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    const wiki = spaces.filter((s) => s.name === proto.space);
    expect(wiki).toHaveLength(1);
    expect((await dbsOf(ws)).every((d) => d.spaceId === wiki[0]!.id)).toBe(true);
    installId = ((await as('GET', `/workspaces/${ws}/packs/installed`)).json() as Array<{ id: string; slug: string }>).find((i) => i.slug === 'team-wiki')!.id;
    expect(installId).toBeTruthy();
  });

  it('every field the prototype lists exists, with the right type (Teams.Pages and Pages.Sub-pages included)', async () => {
    for (const [db, spec] of Object.entries(proto.databases)) {
      const names = (await detail(ws, db)).fields.map((f) => f.displayName);
      for (const f of spec.fields) expect(names, `${db}.${f}`).toContain(f);
    }
    const pages = await detail(ws, 'Pages');
    const type = (n: string) => pages.fields.find((f) => f.displayName === n)!.type;
    expect(type('Owner')).toBe('user');
    expect(type('Last reviewed')).toBe('date');
    expect(type('Status')).toBe('select');
    expect(type('Team')).toBe('relation');
    expect(type('Parent page')).toBe('relation');
    expect(type('Sub-pages')).toBe('relation');
  });

  it('Status has exactly Draft, Verified, Needs review, in that order, each with its category stored', async () => {
    const status = (await detail(ws, 'Pages')).fields.find((f) => f.displayName === 'Status')!;
    expect((status.options ?? []).map((o) => [o.label, o.category])).toEqual(proto.states.map((s) => [s.label, s.category]));
  });

  it('creates the three views; All pages groups by Team and is the one the database opens on', async () => {
    expect(result.views.map((v) => `${v.name}:${v.action}`).sort()).toEqual(['Pages.All pages:created', 'Pages.Needs review:created', 'Pages.My pages:created'].sort());
    const d = await detail(ws, 'Pages');
    const team = d.fields.find((f) => f.displayName === 'Team')!;
    for (const pv of proto.views) {
      const v = d.views.find((x) => x.name === pv.name)!;
      expect(v, pv.name).toBeTruthy();
      expect(v.isDefault, `${pv.name} opens`).toBe(Boolean(pv.opens));
      if (pv.grouped_by) expect(v.config.group_by_field_id).toBe(team.id);
    }
    expect(d.views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['All pages']);
  });

  it('creates both automations switched on', () => {
    expect(result.automations.map((a) => `${a.name}:${a.action}:${a.enabled}`).sort()).toEqual(
      ['Pages.Move stale pages to Needs review:created:true', 'Pages.Review reminder:created:true'],
    );
  });

  it('Teams starts with Everyone, and all four pages are on it', async () => {
    const teams = await rows(ws, (await detail(ws, 'Teams')).id);
    expect(teams.map((t) => t.title)).toEqual(proto.teams);
    const pagesDb = await detail(ws, 'Pages');
    const recs = await rows(ws, pagesDb.id);
    expect(recs.map((r) => r.title).sort()).toEqual(proto.pages.map((p) => p.title).sort());
    for (const r of recs) expect(chips(r.values.team), String(r.title)).toEqual([teams[0]!.id]);
  });

  it('every page is a Draft, owned by whoever installed the pack, with Last reviewed empty, and has the parent the prototype gives it', async () => {
    const d = await detail(ws, 'Pages');
    const draft = d.fields.find((f) => f.displayName === 'Status')!.options!.find((o) => o.label === 'Draft')!.id;
    const recs = await rows(ws, d.id);
    const home = recs.find((r) => r.title === 'Home')!;
    for (const p of proto.pages) {
      const r = recs.find((x) => x.title === p.title)!;
      expect(r.values.status, p.title).toBe(draft);
      expect(r.values.owner, `${p.title} owner`).toBeTruthy();
      expect(r.values.last_reviewed ?? null, `${p.title} last reviewed`).toBeNull();
      expect(chips(r.values.parent_page), p.title).toEqual(p.parent ? [home.id] : []);
    }
    expect(new Set(recs.map((r) => r.values.owner)).size, 'one installer owns all four').toBe(1);
  });

  it('each page\'s body is the approved text: every line of the fixture is there, tables included, and Home does not promise body search', async () => {
    const d = await detail(ws, 'Pages');
    const recs = await rows(ws, d.id);
    for (const p of proto.pages) {
      const md = await bodyOf(ws, d.id, recs.find((r) => r.title === p.title)!.id);
      for (const line of p.must_contain) expect(md, `${p.title}: ${line}`).toContain(line);
      for (const line of p.must_not_contain ?? []) expect(md, `${p.title}: ${line}`).not.toContain(line);
    }
  });

  it('"My pages" shows a person only the pages they own', async () => {
    const d = await detail(ws, 'Pages');
    const view = d.views.find((v) => v.name === 'My pages')!;
    const filter = view.config.filters;
    expect((await rows(ws, d.id, owner.token, { filter, limit: 200 })).map((r) => r.title).sort()).toEqual(proto.pages.map((p) => p.title).sort());
    const member = await joinAs(app, owner.token, ws, 'Team Wiki Member', 'member');
    expect(await rows(ws, d.id, member.token, { filter, limit: 200 })).toEqual([]);
  });

  it('re-installing creates nothing new, and does not double a page body', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest });
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    const created = [...b.databases, ...b.fields, ...b.relations, ...b.states, ...b.views, ...b.automations, ...b.sample_records].filter((i: { action: string }) => i.action === 'created');
    expect(created, JSON.stringify(created)).toEqual([]);
    expect((await detail(ws, 'Pages')).views.filter((v) => v.isDefault).map((v) => v.name)).toEqual(['All pages']);
    expect(await rows(ws, (await detail(ws, 'Pages')).id)).toHaveLength(4);
  });

  it('uninstall removes the automations and deletes no data: databases, pages and their text survive', async () => {
    const res = await as('POST', `/workspaces/${ws}/packs/${installId}/uninstall`);
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json() as { removed: Array<{ kind: string; name: string }> };
    const removed = b.removed.map((i) => `${i.kind}:${i.name}`);
    expect(removed).toContain('automation:Pages.Move stale pages to Needs review');
    expect(removed).toContain('automation:Pages.Review reminder');
    expect((await dbsOf(ws)).map((d) => d.name).sort()).toEqual(['Pages', 'Teams']);
    const d = await detail(ws, 'Pages');
    const recs = await rows(ws, d.id);
    expect(recs).toHaveLength(4);
    expect(await bodyOf(ws, d.id, recs.find((r) => r.title === 'Home')!.id)).toContain('That\'s the whole system.');
  });
});

describe('#1147 "Needs review" is the pages not reviewed in 90 days, and the filter keeps ageing with the calendar', () => {
  it('a back-dated page shows; one reviewed 89 days ago, today, or never does not; the token is resolved at query time', async () => {
    const ws = await newWs();
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const d = await detail(ws, 'Pages');
    const view = d.views.find((v) => v.name === 'Needs review')!;
    const mk = async (name: string, reviewed: string | null) =>
      (await as('POST', `/workspaces/${ws}/databases/${d.id}/records`, { values: { name, ...(reviewed ? { last_reviewed: reviewed } : {}) } })).json().id as string;
    await mk('Reviewed 91 days ago', daysAgo(91));
    await mk('Reviewed 400 days ago', daysAgo(400));
    await mk('Reviewed 89 days ago', daysAgo(89));
    await mk('Reviewed today', daysAgo(0));
    await mk('Never reviewed', null);
    const shows = async () => (await rows(ws, d.id, owner.token, { filter: view.config.filters, limit: 200 })).map((r) => r.title).sort();
    expect(await shows()).toEqual(['Reviewed 400 days ago', 'Reviewed 91 days ago']);
    // the view's stored filter carries the token, not a date frozen at install
    expect(JSON.stringify(view.config.filters)).toContain('$date:-90d');
    expect(JSON.stringify(view.config.filters)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('a malformed relative date is refused, not silently matched to nothing', async () => {
    const ws = await newWs();
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const d = await detail(ws, 'Pages');
    const res = await call(app, owner.token, 'POST', `/workspaces/${ws}/databases/${d.id}/records/query`, { filter: { field: 'last_reviewed', op: 'before', value: '$date:-ninety' }, limit: 5 });
    expect(res.statusCode).toBe(422);
  });
});

describe('#1147 the rules: a Verified page older than 90 days becomes Needs review once, and its owner is told once', () => {
  it('the daily rule flips only Verified pages reviewed more than 90 days ago; the reminder tells the owner exactly once', async () => {
    const ws = await newWs();
    expect((await as('POST', `/workspaces/${ws}/packs/install`, { manifest: entry.manifest })).statusCode).toBe(201);
    const member = await joinAs(app, owner.token, ws, 'Page Owner', 'member');
    const d = await detail(ws, 'Pages');
    const opt = (label: string) => d.fields.find((f) => f.displayName === 'Status')!.options!.find((o) => o.label === label)!.id;
    const mk = async (name: string, status: string, reviewed: string | null) =>
      (await as('POST', `/workspaces/${ws}/databases/${d.id}/records`, { values: { name, status: opt(status), owner: member.id, ...(reviewed ? { last_reviewed: reviewed } : {}) } })).json().id as string;
    const stale = await mk('Stale verified', 'Verified', daysAgo(120));
    const fresh = await mk('Fresh verified', 'Verified', daysAgo(10));
    const draftOld = await mk('Old draft', 'Draft', daysAgo(300));
    const verifiedNever = await mk('Verified never reviewed', 'Verified', null);
    const already = await mk('Already needs review', 'Needs review', daysAgo(200));

    const engine = app.get(AutomationsService);
    const { db, pool } = connectTestDb();
    try {
      const status = async (id: string) => ((await as('GET', `/workspaces/${ws}/databases/${d.id}/records/${id}`)).json().values as Record<string, unknown>).status;
      const notified = async () => (await notesFor(member.token, ws, 'A page you own is 90 days old and needs another look.')).length;
      // Setting the pages up above already fires "Review reminder" for the one created as Needs review (a create, not an update: it must NOT).
      await new Promise((r) => setTimeout(r, 500));
      expect(await notified(), 'creating a page already in Needs review is not a status change').toBe(0);

      const makeDue = async () => {
        const rule = (await as('GET', `/workspaces/${ws}/databases/${d.id}/automations`)).json().data.find((r: { name: string }) => r.name === 'Move stale pages to Needs review') as { id: string };
        await db.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, rule.id));
      };
      await makeDue();
      await engine.tick();
      await engine.settle(stale);

      expect(await status(stale)).toBe(opt('Needs review'));
      expect(await status(fresh)).toBe(opt('Verified'));
      expect(await status(draftOld), 'a Draft is never promoted by the clock').toBe(opt('Draft'));
      expect(await status(verifiedNever), 'no review date is not "90 days old"').toBe(opt('Verified'));
      expect(await status(already)).toBe(opt('Needs review'));

      let told = 0;
      for (let i = 0; i < 40 && told < 1; i++) { told = await notified(); if (told < 1) await new Promise((r) => setTimeout(r, 250)); }
      expect(told, 'the owner was not told').toBe(1);

      // the next day's run finds nothing left to move, so nobody is told again
      await makeDue();
      await engine.tick();
      await engine.settle(stale);
      await new Promise((r) => setTimeout(r, 500));
      expect(await notified(), 'the reminder must fire once, not on every daily run').toBe(1);

      // ...and only for the move INTO Needs review: another status change, or an edit to some other field, tells no one
      const patch = (id: string, values: Record<string, unknown>) => as('PATCH', `/workspaces/${ws}/databases/${d.id}/records/${id}`, { values });
      expect((await patch(fresh, { status: opt('Draft') })).statusCode).toBe(200);
      expect((await patch(stale, { last_reviewed: daysAgo(130) })).statusCode).toBe(200);
      await engine.settle(fresh);
      await engine.settle(stale);
      await new Promise((r) => setTimeout(r, 500));
      expect(await notified(), 'a status change to something else, or an edit to another field, must not remind').toBe(1);
      // moving a page into Needs review by hand does remind its owner (someone thinks it is out of date)
      expect((await patch(fresh, { status: opt('Needs review') })).statusCode).toBe(200);
      let after = 1;
      for (let i = 0; i < 40 && after < 2; i++) { after = await notified(); if (after < 2) await new Promise((r) => setTimeout(r, 250)); }
      expect(after).toBe(2);
    } finally {
      await pool.end();
    }
  });
});
