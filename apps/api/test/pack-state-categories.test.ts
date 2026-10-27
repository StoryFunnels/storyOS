import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { STATE_CATEGORIES } from '@storyos/schemas';
import { PACK_REGISTRY } from '../src/packs/registry';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #1105 — a pack manifest can declare a workflow CATEGORY per option.
 *
 * Before: the manifest option was `{label, color}`. A `workflow` field INFERRED a category from the label and position (so Won, Shipped,
 * Delivered, Declined and every "working" label came out wrong), and a `states[]` select kept NONE. Nothing a pack author said reached the
 * stored `select_options.category`, which "Assigned to me", progress and board grouping read.
 */
let app: NestFastifyApplication;
let token: string;
const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const newWs = async (name: string) => (await as('POST', '/workspaces', { name: `${name} ${Date.now()}` })).json().id as string;

interface Opt { label: string; color?: string; category?: string | null }
interface Fld { id: string; displayName: string; type: string; options?: Opt[] }
interface Manifest {
  slug: string;
  databases: Array<{ name: string; space: string; fields: Array<{ name: string; type: string; options?: Opt[] }> }>;
  states: Array<{ database: string; field: string; options: Opt[] }>;
  [k: string]: unknown;
}

const supportInbox = () => structuredClone(PACK_REGISTRY.find((p) => p.slug === 'support-inbox')!.manifest) as unknown as Manifest;

/** The support-inbox manifest (it has a state with a trigger, so EXPORT sees it as a state) plus a workflow field, declared or not. */
function manifestWith(declared: boolean): Manifest {
  const m = supportInbox();
  m.slug = declared ? 'cat-declared' : 'cat-omitted';
  const tickets = m.databases.find((d) => d.name === 'Tickets')!;
  const c = (category: string) => (declared ? { category } : {});
  tickets.fields.push({
    name: 'Deal',
    type: 'workflow',
    options: [
      { label: 'Open', color: 'gray', ...c('unstarted') },
      { label: 'Won', color: 'green', ...c('completed') },
      { label: 'Lost', color: 'red', ...c('canceled') },
    ],
  });
  if (declared) {
    const st = m.states.find((s) => s.field === 'Status')!;
    st.options.find((o) => o.label === 'Blocked')!.category = 'started';
    st.options.find((o) => o.label === 'Done')!.category = 'completed';
  } else {
    for (const o of m.states.find((s) => s.field === 'Status')!.options) delete o.category;
  }
  return m;
}

const fieldsOf = async (ws: string, dbName: string) => {
  const dbs = (await as('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
  const db = dbs.find((d) => d.name === dbName)!;
  return ((await as('GET', `/workspaces/${ws}/databases/${db.id}`)).json().fields as Fld[]);
};
const catsOf = (f: Fld) => Object.fromEntries((f.options ?? []).map((o) => [o.label, o.category ?? null]));
const install = (ws: string, manifest: unknown) => as('POST', `/workspaces/${ws}/packs/install`, { manifest });

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Pack Categories')).token;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1105 a declared category wins', () => {
  it('a workflow field option and a states[] option are stored with the category the manifest declares', async () => {
    const ws = await newWs('Declared');
    const res = await install(ws, manifestWith(true));
    expect(res.statusCode, res.body).toBe(201);
    const tickets = await fieldsOf(ws, 'Tickets');
    // Inference alone would say Won=unstarted (not a finished label, not last) and Lost=completed (last of three).
    expect(catsOf(tickets.find((f) => f.displayName === 'Deal')!)).toEqual({ Open: 'unstarted', Won: 'completed', Lost: 'canceled' });
    // states[] creates a plain select, which keeps NO category unless the manifest gives one.
    const status = catsOf(tickets.find((f) => f.displayName === 'Status')!);
    expect(status.Blocked).toBe('started');
    expect(status.Done).toBe('completed');
  }, 120_000);
});

describe('#1105 an omitted category behaves exactly as before', () => {
  it('a workflow field infers from label and position; a states[] select keeps none', async () => {
    const ws = await newWs('Omitted');
    const res = await install(ws, manifestWith(false));
    expect(res.statusCode, res.body).toBe(201);
    const tickets = await fieldsOf(ws, 'Tickets');
    expect(catsOf(tickets.find((f) => f.displayName === 'Deal')!)).toEqual({ Open: 'unstarted', Won: 'unstarted', Lost: 'completed' });
    expect(Object.values(catsOf(tickets.find((f) => f.displayName === 'Status')!)).every((c) => c === null)).toBe(true);
  }, 120_000);
});

describe('#1105 an unknown category is refused, naming where', () => {
  it('422 with the bad value and the option label', async () => {
    const m = manifestWith(true);
    (m.states.find((s) => s.field === 'Status')!.options.find((o) => o.label === 'Blocked') as Opt).category = 'finished';
    const res = await install(await newWs('Invalid'), m);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('Blocked');
    expect(res.body).toContain('category');
    for (const c of STATE_CATEGORIES) expect(res.body, 'lists the valid ones').toContain(c);
  }, 120_000);
});

describe('#1105 re-install never rewrites an option a person already has', () => {
  it('a category changed after install survives a second install, and the second install adds nothing', async () => {
    const ws = await newWs('Idempotent');
    const manifest = manifestWith(true);
    expect((await install(ws, manifest)).statusCode).toBe(201);
    const tickets = await fieldsOf(ws, 'Tickets');
    const status = tickets.find((f) => f.displayName === 'Status')!;
    const done = (status.options as Array<Opt & { id: string }>).find((o) => o.label === 'Done')!;
    const db = (await as('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Tickets').id as string;
    const patch = await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${status.id}/options/${done.id}`, { category: 'canceled' });
    expect(patch.statusCode, patch.body).toBe(200);
    await install(ws, manifest);
    const after = catsOf((await fieldsOf(ws, 'Tickets')).find((f) => f.displayName === 'Status')!);
    expect(after.Done, 'the person\'s choice, not the manifest\'s').toBe('canceled');
  }, 180_000);
});

describe('#1105 export round-trips the categories, and preview shows them', () => {
  it('export carries categories on workflow and state options; the exported manifest installs to the same categories', async () => {
    const ws = await newWs('Export source');
    expect((await install(ws, manifestWith(true))).statusCode).toBe(201);
    const exp = await as('POST', `/workspaces/${ws}/packs/export`, { slug: 'cat-export', name: 'Cat export', space: supportInbox().databases[0]!.space });
    expect(exp.statusCode, exp.body).toBe(201);
    const exported = exp.json() as Manifest;
    const fromStates = exported.states.find((s) => s.field === 'Status')!.options;
    expect(fromStates.find((o) => o.label === 'Blocked')!.category).toBe('started');
    const deal = exported.databases.find((d) => d.name === 'Tickets')!.fields.find((f) => f.name === 'Deal')!;
    expect(deal.options!.map((o) => o.category)).toEqual(['unstarted', 'completed', 'canceled']);

    const ws2 = await newWs('Export target');
    expect((await install(ws2, exported)).statusCode).toBe(201);
    const t2 = await fieldsOf(ws2, 'Tickets');
    expect(catsOf(t2.find((f) => f.displayName === 'Deal')!)).toEqual({ Open: 'unstarted', Won: 'completed', Lost: 'canceled' });
  }, 240_000);

  it('preview lists the declared category of an option it would add to an existing state', async () => {
    const ws = await newWs('Preview');
    // Schema only (no agents, triggers, views or automations), so the second install has just the database to decide about.
    const slim = (slug: string) => {
      const m = supportInbox();
      for (const st of m.states) for (const o of st.options) delete o.category;
      Object.assign(m, { slug, agents: [], triggers: [], views: [], automations: [], derived_fields: [] });
      return m;
    };
    const base = slim('cat-preview-base');
    expect((await install(ws, base)).statusCode).toBe(201);
    const next = slim('cat-preview-next');
    const nextStatus = next.states.find((s) => s.field === 'Status')!.options;
    nextStatus.push({ label: 'Won', color: 'green', category: 'completed' });
    nextStatus.find((o) => o.label === 'Done')!.category = 'canceled'; // already in the field with NO category: the pack must not rewrite it
    const res = await as('POST', `/workspaces/${ws}/packs/preview`, { manifest: next });
    expect(res.statusCode, res.body).toBe(201);
    const dbs = (res.json() as { databases: Array<{ name: string; gains?: { options: Array<{ field: string; labels: string[]; categories?: Record<string, string> }> } }> }).databases;
    const opt = dbs.flatMap((d) => d.gains?.options ?? []).find((o) => o.field === 'Status')!;
    expect(opt.labels).toEqual(['Won']);
    expect(opt.categories).toEqual({ Won: 'completed' });
    // ...and the install that follows stores it on the option it ADDS to the existing select (ensureOptions), leaving the rest alone.
    const second = await as('POST', `/workspaces/${ws}/packs/install`, { manifest: next, resolutions: { Tickets: { action: 'reuse' } } });
    expect(second.statusCode, second.body).toBe(201);
    const status = catsOf((await fieldsOf(ws, 'Tickets')).find((f) => f.displayName === 'Status')!);
    expect(status.Won).toBe('completed');
    expect(status.Done, 'an option that was already there keeps what it had, whatever the pack now declares').toBe(null);
  }, 180_000);
});

describe('#1105 every built-in pack declares its categories', () => {
  const choiceFields = (m: Manifest) => [
    ...m.databases.flatMap((d) => d.fields.filter((f) => f.type === 'workflow').map((f) => ({ where: `${d.name}.${f.name}`, options: f.options ?? [] }))),
    ...m.states.map((s) => ({ where: `${s.database}.${s.field}`, options: s.options })),
  ];

  it('every option of every workflow field and every state, in every pack, has an explicit valid category', () => {
    let checked = 0;
    for (const entry of PACK_REGISTRY) {
      for (const f of choiceFields(entry.manifest as unknown as Manifest)) {
        for (const o of f.options) {
          expect(STATE_CATEGORIES as readonly string[], `${entry.slug}: ${f.where} / ${o.label}`).toContain(o.category);
          checked++;
        }
      }
    }
    expect(checked, 'the walk found the options (a walk that found none proves nothing)').toBeGreaterThan(100);
  });

  it('the outcomes the ticket named are finished, not "not started"', () => {
    const cat = (slug: string, where: string, label: string) =>
      choiceFields(PACK_REGISTRY.find((p) => p.slug === slug)!.manifest as unknown as Manifest).find((f) => f.where === where)!.options.find((o) => o.label === label)!.category;
    expect(cat('consulting-os', 'Proposals.Stage', 'Won')).toBe('completed');
    expect(cat('consulting-os', 'Proposals.Stage', 'Lost')).toBe('canceled');
    expect(cat('content-engine', 'Articles.Stage', 'Published')).toBe('completed');
    expect(cat('agency-os', 'Projects.Status', 'Delivered')).toBe('completed');
    expect(cat('dev-project-os', 'Issues.State', 'Done')).toBe('completed');
    expect(cat('book-launch', 'Books.Status', 'Writing')).toBe('started');
  });

  it('installing Dev Project stores them on Issues.State', async () => {
    const ws = await newWs('Dev Project');
    const manifest = PACK_REGISTRY.find((p) => p.slug === 'dev-project-os')!.manifest;
    expect((await install(ws, manifest)).statusCode).toBe(201);
    const state = catsOf((await fieldsOf(ws, 'Issues')).find((f) => f.displayName === 'State')!);
    expect(state).toEqual({ Triage: 'backlog', Backlog: 'backlog', 'To Do': 'unstarted', 'In Progress': 'started', 'In Review': 'started', Done: 'completed', Canceled: 'canceled' });
  }, 180_000);
});
