import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inferStateCategory, isFinishedStateCategory, linearStateCategory, STATE_CATEGORIES } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { selectOptions } from '../src/db/schema';
import { LinearService } from '../src/integrations/linear.service';

/**
 * ticket #1014 — a workflow option carries a CATEGORY (backlog / unstarted / started / completed / canceled), so "finished" is data and
 * not a guess from the label. The migration backfills what the web used to guess at read time (`isCompletedState`), and every write path
 * keeps it: a new workflow, an added option, a converted field, the Linear import.
 */
const { db: raw } = connectTestDb();
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string, space: string;
const as = (method: string, url: string, payload?: unknown) => call(app, owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'State Categories');
  ws = (await as('POST', '/workspaces', { name: 'Categories WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 240_000);
afterAll(async () => { await app.close(); });

/** The rule the WEB applied at read time before this ticket (`isCompletedState` in my-work-model.ts), kept here as the reference the backfill must match. */
const OLD_COMPLETED = /^(done|complete|completed|closed|shipped|resolved|cancell?ed|archived)$/i;
const oldIsCompleted = (type: string, labels: string[], i: number) =>
  OLD_COMPLETED.test(labels[i]!.trim()) || (type === 'workflow' && labels.length > 1 && i === labels.length - 1);

async function database(name: string) {
  return (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id as string;
}
async function field(db: string, display_name: string, type: string, labels: string[], extra: Array<Record<string, unknown>> = []) {
  const res = await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name, type, options: labels.map((label, i) => ({ label, ...(extra[i] ?? {}) })) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; options: Array<{ id: string; label: string; category: string | null; position: number }> };
}
const opts = async (fieldId: string) => (await raw.select().from(selectOptions).where(eq(selectOptions.fieldId, fieldId)).orderBy(selectOptions.position)).map((o) => ({ id: o.id, label: o.label, category: o.category }));

describe('#1014 the rule, written once', () => {
  it('infers a category from the label, then the terminal position, then the vocabulary, else unstarted', () => {
    const cases: Array<[string, boolean, string]> = [
      ['Done', false, 'completed'], ['closed', false, 'completed'], ['Shipped', false, 'completed'], ['Resolved', false, 'completed'], ['Archived', false, 'completed'],
      ['Canceled', false, 'canceled'], ['cancelled', false, 'canceled'], ['CANCELED', true, 'canceled'],
      ['Backlog', false, 'backlog'], ['Triage', false, 'backlog'], ['Icebox', false, 'backlog'], ['Someday', false, 'backlog'],
      ['In Progress', false, 'started'], ['In Review', false, 'started'], ['Doing', false, 'started'], ['WIP', false, 'started'], ['Active', false, 'started'],
      ['To Do', false, 'unstarted'], ['Planned', false, 'unstarted'], ['Whatever', false, 'unstarted'],
      ['Published', true, 'completed'], ['Whatever', true, 'completed'], ['Backlog', true, 'completed'],
    ];
    for (const [label, isLast, want] of cases) expect(inferStateCategory(label, { isLast }), `${label}${isLast ? ' (last)' : ''}`).toBe(want);
    expect(STATE_CATEGORIES).toEqual(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
    expect(isFinishedStateCategory('completed')).toBe(true);
    expect(isFinishedStateCategory('canceled')).toBe(true);
    for (const c of ['backlog', 'unstarted', 'started', null, undefined]) expect(isFinishedStateCategory(c)).toBe(false);
    expect(linearStateCategory('triage')).toBe('backlog');
    expect(linearStateCategory('canceled')).toBe('canceled');
    expect(linearStateCategory('mystery')).toBeNull();
  });
});

describe('#1014 the backfill', () => {
  // the backfill is the LAST statement of the migration file (after the column and the constraint)
  const migration = readFileSync(join(__dirname, '../drizzle/0117_tricky_scream.sql'), 'utf8').split('--> statement-breakpoint').pop()!.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('gives every workflow option the category the old read-time rule implied, leaves selects alone, reports counts, and a second run writes nothing', async () => {
    const db = await database('Backfill');
    const FLOWS: Record<string, string[]> = {
      'Std flow': ['Triage', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'],
      'Idea flow': ['Idea', 'Draft', 'Published'],
      'Two': ['Open', 'Closed'],
      'Archived last': ['Planned', 'Active', 'Done', 'Archived'],
      'One only': ['Only'],
      'Mixed': ['wip', 'Shipped', 'Cancelled', 'Later'],
    };
    const ids: Record<string, string> = {};
    // a database allows ONE workflow field, so each flow lives in its own database
    const seeded: Array<{ name: string; fieldId: string; labels: string[] }> = [];
    for (const [name, labels] of Object.entries(FLOWS)) {
      const d = await database(`Backfill ${name}`);
      const f = await field(d, 'State', 'workflow', labels);
      seeded.push({ name, fieldId: f.id, labels });
      ids[name] = f.id;
    }
    const sel = await field(db, 'Status', 'select', ['Done', 'Open', 'Blocked']);
    // the state of a database BEFORE the migration: no categories anywhere
    await raw.update(selectOptions).set({ category: null }).where(inArray(selectOptions.fieldId, [...seeded.map((s) => s.fieldId), sel.id]));
    const nullCount = async () => Number(((await raw.execute(sql`SELECT count(*)::int AS n FROM select_options WHERE category IS NULL AND field_id = ANY(${sql.raw(`ARRAY[${[...seeded.map((s) => `'${s.fieldId}'`), `'${sel.id}'`].join(',')}]::uuid[]`)})`)) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);
    expect(await nullCount()).toBe(Object.values(FLOWS).flat().length + 3);

    await raw.execute(sql.raw(migration));

    const counts: Record<string, number> = {};
    for (const s of seeded) {
      const rows = await opts(s.fieldId);
      expect(rows.map((r) => r.label), s.name).toEqual(s.labels);
      rows.forEach((r, i) => {
        const want = inferStateCategory(r.label, { isLast: s.labels.length > 1 && i === s.labels.length - 1 });
        expect(r.category, `${s.name}: ${r.label}`).toBe(want);
        // the equivalence that matters: "finished" by category is exactly "completed" by the old read-time rule
        expect(isFinishedStateCategory(r.category), `${s.name}: ${r.label} finished`).toBe(oldIsCompleted('workflow', s.labels, i));
        counts[r.category!] = (counts[r.category!] ?? 0) + 1;
      });
    }
    expect(counts, 'counts per category on the seeded copy').toEqual({ backlog: 2, unstarted: 6, started: 4, completed: 7, canceled: 2 });
    expect((await opts(sel.id)).map((o) => o.category), 'a select option is never inferred').toEqual([null, null, null]);
    const second = await raw.execute(sql.raw(migration));
    expect(second.rowCount, 'idempotent: nothing left without a category').toBe(0);
  });
});

describe('#1014 every write path keeps it', () => {
  it('a new workflow gets inferred categories, an explicit one wins, and the API shows them', async () => {
    const db = await database('Create');
    const f = await field(db, 'State', 'workflow', ['Backlog', 'In Progress', 'Review', 'Done'], [{}, {}, { category: 'unstarted' }, {}]);
    expect(f.options.map((o) => o.category)).toEqual(['backlog', 'started', 'unstarted', 'completed']);
    const detail = (await as('GET', `/workspaces/${ws}/databases/${db}`)).json();
    expect(detail.fields.find((x: { id: string }) => x.id === f.id).options.map((o: { category: string }) => o.category)).toEqual(['backlog', 'started', 'unstarted', 'completed']);
    const idea = await field(await database('Create idea'), 'State', 'workflow', ['Idea', 'Draft', 'Published']);
    expect(idea.options.map((o) => o.category), 'the last option of an ordered flow is its terminal state').toEqual(['unstarted', 'unstarted', 'completed']);
  });

  it('a select option has a category only when given; a multi-select option cannot have one', async () => {
    const db = await database('Select');
    const sel = await field(db, 'Status', 'select', ['Open', 'Shipped'], [{}, { category: 'completed' }]);
    expect(sel.options.map((o) => o.category)).toEqual([null, 'completed']);
    const bad = await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Tags', type: 'multi_select', options: [{ label: 'a', category: 'started' }] });
    expect(bad.statusCode, bad.body).toBe(422);
  });

  it('an ADDED workflow option is inferred from its label alone (appended is not "the terminal state"), and the caller can choose', async () => {
    const f = await field(await database('Add'), 'State', 'workflow', ['To Do', 'Done']);
    const add = (body: Record<string, unknown>) => as('POST', `/workspaces/${ws}/databases/${(f as never as { databaseId?: string }).databaseId ?? ''}`, body);
    void add;
    const dbId = (await raw.execute(sql`SELECT database_id FROM fields WHERE id = ${f.id}`) as unknown as { rows: Array<{ database_id: string }> }).rows[0]!.database_id;
    const post = (body: Record<string, unknown>) => as('POST', `/workspaces/${ws}/databases/${dbId}/fields/${f.id}/options`, body);
    expect((await post({ label: 'Blocked' })).json().category, 'appended after Done, still not completed').toBe('unstarted');
    expect((await post({ label: 'Released' , color: 'green'})).json().category).toBe('unstarted');
    expect((await post({ label: 'Closed' })).json().category).toBe('completed');
    expect((await post({ label: 'Parked', category: 'backlog' })).json().category, 'an explicit category wins').toBe('backlog');
    expect((await post({ label: 'Bad', category: 'finished' })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('a person can change a category; a workflow option cannot lose it; a select option can; multi-select refuses', async () => {
    const dbW = await database('Update W');
    const w = await field(dbW, 'State', 'workflow', ['To Do', 'Done']);
    const patch = (db: string, fieldId: string, optionId: string, body: Record<string, unknown>) => as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${fieldId}/options/${optionId}`, body);
    expect((await patch(dbW, w.id, w.options[0]!.id, { category: 'started' })).json().category).toBe('started');
    expect((await patch(dbW, w.id, w.options[0]!.id, { category: null })).statusCode, 'a workflow option always has one').toBe(422);
    expect((await opts(w.id))[0]!.category).toBe('started');
    const dbS = await database('Update S');
    const s = await field(dbS, 'Status', 'select', ['Open'], [{ category: 'started' }]);
    expect((await patch(dbS, s.id, s.options[0]!.id, { category: null })).json().category, 'clearing is fine on a select').toBeNull();
    const dbM = await database('Update M');
    const m = await field(dbM, 'Tags', 'multi_select', ['a']);
    expect((await patch(dbM, m.id, m.options[0]!.id, { category: 'started' })).statusCode).toBe(422);
  });

  it('converting a select TO workflow infers categories (terminal last), and to a multi-select clears them', async () => {
    const db = await database('Convert');
    const sel = await field(db, 'Status', 'select', ['Open', 'Working', 'Finished']);
    expect((await opts(sel.id)).map((o) => o.category)).toEqual([null, null, null]);
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${sel.id}/change-type`, { type: 'workflow' })).statusCode).toBe(201);
    expect((await opts(sel.id)).map((o) => o.category), 'inferred, the last option is the terminal state').toEqual(['unstarted', 'unstarted', 'completed']);
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${sel.id}/change-type`, { type: 'multi_select' })).statusCode).toBe(201);
    expect((await opts(sel.id)).map((o) => o.category), 'a multi-select option is not a state').toEqual([null, null, null]);
  });

  it('a text field converted to workflow creates options with inferred categories', async () => {
    const db = await database('Text to flow');
    const t = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Stage', type: 'text' })).json().id as string;
    for (const v of ['Backlog', 'In Progress', 'Done']) await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: v, stage: v } });
    expect((await as('POST', `/workspaces/${ws}/databases/${db}/fields/${t}/change-type`, { type: 'workflow' })).statusCode).toBe(201);
    const byLabel = Object.fromEntries((await opts(t)).map((o) => [o.label, o.category]));
    expect(byLabel).toEqual({ Backlog: 'backlog', 'In Progress': 'started', Done: 'completed' });
  });
});

describe('#1014 the Linear import sets it from Linear\'s state type', () => {
  const TEAM = { id: 'team-cat', key: 'CAT', name: 'Categories' };
  const STATES = [
    { id: 'c0', name: 'Triage', type: 'triage', position: 0 }, { id: 'c1', name: 'Backlog', type: 'backlog', position: 1 },
    { id: 'c2', name: 'Todo', type: 'unstarted', position: 2 }, { id: 'c3', name: 'In Progress', type: 'started', position: 3 },
    { id: 'c4', name: 'Deployed', type: 'completed', position: 4 }, { id: 'c5', name: 'Duplicate', type: 'canceled', position: 5 },
  ];
  it('a new import carries Linear\'s category on each State option (by TYPE, never by name), and a re-sync fills an older import', async () => {
    const linear = app.get(LinearService);
    const w = (await as('POST', '/workspaces', { name: 'Linear Categories' })).json().id as string;
    expect((await as('POST', `/workspaces/${w}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['CAT'] })).statusCode).toBe(201);
    const issue = { ...manyIssues(1)[0]!, id: 'i1', identifier: 'CAT-1', title: 'One', state: { name: 'Deployed', type: 'completed' } };
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { labels: { nodes: [] }, cycles: { nodes: [] }, projects: { nodes: [] }, issues: { nodes: [issue] }, states: STATES } }]).fetcher;
    expect((await as('POST', `/workspaces/${w}/integrations/linear/sync`)).statusCode).toBe(201);
    const dbs = (await as('GET', `/workspaces/${w}/databases`)).json() as Array<{ id: string; name: string }>;
    const stateOf = async (name: string, apiName: string) => {
      const detail = (await as('GET', `/workspaces/${w}/databases/${dbs.find((d) => d.name === name)!.id}`)).json();
      return detail.fields.find((f: { apiName: string }) => f.apiName === apiName) as { id: string; options: Array<{ id: string; label: string; category: string | null }> };
    };
    const state = await stateOf('Issues', 'state');
    const cat = (label: string) => state.options.find((o) => o.label === label)!.category;
    expect(['Triage', 'Backlog', 'Todo', 'In Progress', 'Deployed', 'Duplicate'].map(cat)).toEqual(['backlog', 'backlog', 'unstarted', 'started', 'completed', 'canceled']);
    // the NAME says nothing here: "Deployed" and "Duplicate" are finished because Linear's TYPE says so
    // an earlier import: categories absent. A re-sync fills them from Linear's types.
    await raw.update(selectOptions).set({ category: null }).where(eq(selectOptions.fieldId, state.id));
    expect((await as('POST', `/workspaces/${w}/integrations/linear/sync`)).statusCode).toBe(201);
    expect((await stateOf('Issues', 'state')).options.map((o) => o.category)).toEqual(expect.arrayContaining(['backlog', 'unstarted', 'started', 'completed', 'canceled']));
    expect((await stateOf('Issues', 'state')).options.every((o) => o.category !== null)).toBe(true);
    const project = await stateOf('Projects', 'state');
    expect(Object.fromEntries(project.options.map((o) => [o.label, o.category]))).toEqual({ backlog: 'backlog', planned: 'unstarted', started: 'started', paused: 'started', completed: 'completed', canceled: 'canceled' });
  });
});
