import { beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { activeFilter } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #1154 — `category_is` / `category_is_not` on a workflow or select field: a filter that names a state CATEGORY, so "open"
 * means "not in a finished category" and a done-like state added LATER is counted correctly with no edit to the filter.
 * One compiler serves views, POST /records/query and rollups, so the same op is asserted on all three.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ws: string;
let tasks: string;
let projects: string;
let statusId: string;
let priorityId: string;
let opt: Record<string, string>; // Status option label -> id
let prio: Record<string, string>; // Priority option label -> id
let proj: string;
let openTasksApi: string;

const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const query = (filter: unknown) => inject('POST', `/workspaces/${ws}/databases/${tasks}/records/query`, { filter, limit: 200 });
const titles = async (filter: unknown) => {
  const res = await query(filter);
  expect(res.statusCode, res.body).toBe(201);
  return (res.json().data as Array<{ title: string }>).map((r) => r.title).sort();
};
const mk = async (name: string, values: Record<string, unknown>) => {
  const res = await inject('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: { name, project: [proj], ...values } });
  expect(res.statusCode, res.body).toBe(201);
};
const storedFilter = async (viewId: string) => {
  const d = (await inject('GET', `/workspaces/${ws}/databases/${tasks}`)).json() as { views: Array<{ id: string; config: { filters: unknown } }> };
  return d.views.find((v) => v.id === viewId)!.config.filters;
};
const openTasks = async (): Promise<unknown> => {
  for (let i = 0; i < 60; i++) {
    const v = (await inject('GET', `/workspaces/${ws}/databases/${projects}/records/${proj}`)).json().values?.[openTasksApi];
    if (v !== undefined && v !== null) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
};
async function waitForOpenTasks(expected: number) {
  let v: unknown;
  for (let i = 0; i < 60; i++) {
    v = (await inject('GET', `/workspaces/${ws}/databases/${projects}/records/${proj}`)).json().values?.[openTasksApi];
    if (v === expected) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return v;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Category Filterer');
  ws = (await inject('POST', '/workspaces', { name: 'Category WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  projects = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Projects' })).json().id;

  const status = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
    display_name: 'Status',
    type: 'workflow',
    options: [
      { label: 'To Do', category: 'unstarted' },
      { label: 'Doing', category: 'started' },
      { label: 'Done', category: 'completed' },
      { label: 'Dropped', category: 'canceled' },
    ],
  });
  expect(status.statusCode, status.body).toBe(201);
  statusId = status.json().id;
  opt = Object.fromEntries((status.json().options as Array<{ label: string; id: string }>).map((o) => [o.label, o.id]));

  // A select whose options carry NO category (the ordinary case), except one that does.
  const priority = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
    display_name: 'Priority',
    type: 'select',
    options: [{ label: 'Low' }, { label: 'High', category: 'started' }],
  });
  expect(priority.statusCode, priority.body).toBe(201);
  priorityId = priority.json().id;
  prio = Object.fromEntries((priority.json().options as Array<{ label: string; id: string }>).map((o) => [o.label, o.id]));

  await inject('POST', `/workspaces/${ws}/relations`, {
    database_a_id: tasks, database_b_id: projects, cardinality: 'one_to_many', field_a_name: 'Project', field_b_name: 'Tasks',
  });
  proj = (await inject('POST', `/workspaces/${ws}/databases/${projects}/records`, { values: { name: 'P1' } })).json().id;
  const projectFields = (await inject('GET', `/workspaces/${ws}/databases/${projects}`)).json().fields as Array<{ apiName: string; id: string }>;
  const tasksLink = projectFields.find((f) => f.apiName === 'tasks')!.id;
  const rollup = await inject('POST', `/workspaces/${ws}/databases/${projects}/fields`, {
    display_name: 'Open tasks',
    type: 'rollup',
    config: { relation_field_id: tasksLink, op: 'count', filter: { field: 'status', op: 'category_is_not', value: ['completed', 'canceled'] } },
  });
  expect(rollup.statusCode, rollup.body).toBe(201);
  openTasksApi = rollup.json().apiName;

  await mk('t-todo', { status: opt['To Do'] });
  await mk('t-doing', { status: opt['Doing'], priority: prio['High'] });
  await mk('t-done', { status: opt['Done'], priority: prio['Low'] });
  await mk('t-dropped', { status: opt['Dropped'] });
  await mk('t-empty', {});
});

describe('category_is / category_is_not on a workflow field', () => {
  it('category_is returns exactly the rows in that category', async () => {
    expect(await titles({ field: 'status', op: 'category_is', value: ['completed'] })).toEqual(['t-done']);
    expect(await titles({ field: 'status', op: 'category_is', value: ['completed', 'canceled'] })).toEqual(['t-done', 't-dropped']);
    expect(await titles({ field: 'status', op: 'category_is', value: 'started' })).toEqual(['t-doing']); // a bare string is a one-element list
  });

  it('category_is_not is the exact complement of category_is (a workflow gives an unset status its first option, To Do)', async () => {
    expect(await titles({ field: 'status', op: 'category_is_not', value: ['completed', 'canceled'] })).toEqual(['t-doing', 't-empty', 't-todo']);
  });

  it('works inside and/or groups beside option filters', async () => {
    expect(
      await titles({ and: [{ field: 'status', op: 'category_is_not', value: ['completed', 'canceled'] }, { field: 'status', op: 'has_none', value: [opt['To Do']] }] }),
    ).toEqual(['t-doing']);
  });

  it('a category no option has yet is not an error: is matches nothing, is_not matches everything', async () => {
    expect(await titles({ field: 'status', op: 'category_is', value: ['backlog'] })).toEqual([]);
    expect(await titles({ field: 'status', op: 'category_is_not', value: ['backlog'] })).toEqual(['t-doing', 't-done', 't-dropped', 't-empty', 't-todo']);
  });
});

describe('on a select field', () => {
  it('matches only the options that carry the category; an option with none is in no category', async () => {
    expect(await titles({ field: 'priority', op: 'category_is', value: ['started'] })).toEqual(['t-doing']);
    expect(await titles({ field: 'priority', op: 'category_is_not', value: ['started'] })).toEqual(['t-done', 't-dropped', 't-empty', 't-todo']);
  });
});

describe('rejections (422, same family as other filter errors)', () => {
  it('an unknown category names the valid ones', async () => {
    const res = await query({ field: 'status', op: 'category_is', value: ['finished'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/unknown state category "finished".*backlog, unstarted, started, completed, canceled/);
  });

  it('a non-string or non-category value is refused rather than matching nothing', async () => {
    expect((await query({ field: 'status', op: 'category_is', value: [1] })).statusCode).toBe(422);
    expect((await query({ field: 'status', op: 'category_is', value: { a: 1 } })).statusCode).toBe(422);
  });

  it('a field type with no categories refuses the op', async () => {
    const tags = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Tags', type: 'multi_select', options: [{ label: 'x' }] });
    expect(tags.statusCode, tags.body).toBe(201);
    expect((await query({ field: 'tags', op: 'category_is', value: ['completed'] })).statusCode).toBe(422);
    expect((await query({ field: 'name', op: 'category_is', value: ['completed'] })).statusCode).toBe(422);
    const bad = await inject('POST', `/workspaces/${ws}/databases/${tasks}/records/query`, { filter: { field: 'status', op: 'category_isnt', value: ['completed'] } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('an empty category list is refused on the query exactly as an empty has list is', async () => {
    expect((await query({ field: 'status', op: 'category_is', value: [] })).statusCode).toBe(422);
    expect((await query({ field: 'status', op: 'has', value: [] })).statusCode).toBe(422);
  });

  it('a view whose builder left a category row unfinished still runs: the persisted filter prunes it (activeFilter) like any unfinished row', () => {
    expect(activeFilter({ and: [{ field: 'status', op: 'category_is', value: [] }, { field: 'status', op: 'category_is', value: ['completed'] }] })).toEqual({ field: 'status', op: 'category_is', value: ['completed'] });
  });
});

describe('what must keep working', () => {
  it('option-based filters are unchanged', async () => {
    expect(await titles({ field: 'status', op: 'has', value: [opt['Done']] })).toEqual(['t-done']);
    expect(await titles({ field: 'status', op: 'has_none', value: [opt['Done']] })).toEqual(['t-doing', 't-dropped', 't-empty', 't-todo']);
    expect(await titles({ field: 'status', op: 'eq', value: opt['Doing'] })).toEqual(['t-doing']);
    expect(await titles({ field: 'status', op: 'neq', value: opt['Doing'] })).toEqual(['t-done', 't-dropped', 't-empty', 't-todo']);
    expect((await query({ field: 'status', op: 'has', value: ['no-such-option'] })).statusCode).toBe(422);
  });

  it('a saved view that stores an option filter still loads and filters the same', async () => {
    const view = await inject('POST', `/workspaces/${ws}/databases/${tasks}/views`, {
      name: 'Not Done (option)', type: 'table', config: { filters: { field: 'status', op: 'has_none', value: [opt['Done']] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    const stored = await storedFilter(view.json().id);
    expect(stored).toEqual({ field: 'status', op: 'has_none', value: [opt['Done']] });
    expect(await titles(stored)).toEqual(['t-doing', 't-dropped', 't-empty', 't-todo']);
  });

  it('a saved view can store and run a category filter', async () => {
    const view = await inject('POST', `/workspaces/${ws}/databases/${tasks}/views`, {
      name: 'Open (category)', type: 'table', config: { filters: { field: 'status', op: 'category_is_not', value: ['completed', 'canceled'] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    const stored = await storedFilter(view.json().id);
    expect(stored).toEqual({ field: 'status', op: 'category_is_not', value: ['completed', 'canceled'] });
    expect(await titles(stored)).toEqual(['t-doing', 't-empty', 't-todo']);
  });
});

describe('the rollup (Team Board "Open tasks" shape) follows the meaning, not the label', () => {
  it('counts the not-finished tasks, and a completed state added LATER is counted correctly', async () => {
    expect(await waitForOpenTasks(3)).toBe(3); // t-todo, t-doing, t-empty

    // someone adds a brand-new done-like state, "Shipped", AFTER the rollup was written
    const added = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields/${statusId}/options`, { label: 'Shipped', color: 'green', category: 'completed' });
    expect(added.statusCode, added.body).toBe(201);
    const shipped = added.json().id as string;
    await mk('t-shipped', { status: shipped });
    // the rollup filter was never edited; the new completed task is not open. (An option-list filter naming only Done would say 4.)
    expect(await waitForOpenTasks(3)).toBe(3);
    // and the query path agrees
    expect(await titles({ field: 'status', op: 'category_is', value: ['completed'] })).toEqual(['t-done', 't-shipped']);

    // an open task moves into the new state: it stops being open
    const todo = (await inject('POST', `/workspaces/${ws}/databases/${tasks}/records/query`, { filter: { field: 'name', op: 'eq', value: 't-todo' } })).json().data[0].id as string;
    expect((await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/records/${todo}`, { values: { status: shipped } })).statusCode).toBe(200);
    expect(await waitForOpenTasks(2)).toBe(2);
  });

  it('re-categorising an option recomputes the rollup (the meaning changed with no record write)', async () => {
    // "Doing" becomes a finished state
    const res = await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/fields/${statusId}/options/${opt['Doing']}`, { category: 'completed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await waitForOpenTasks(1)).toBe(1); // read-time value: only t-empty remains open
    // A GET resolves a rollup fresh, but sorting / filtering BY the rollup reads its materialized value, which only a recompute refreshes.
    let hit: string[] = [];
    for (let i = 0; i < 60 && hit.length === 0; i++) {
      const res = await inject('POST', `/workspaces/${ws}/databases/${projects}/records/query`, { filter: { field: openTasksApi, op: 'eq', value: 1 } });
      hit = (res.json().data as Array<{ title: string }>).map((r) => r.title);
      if (hit.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(hit).toEqual(['P1']);
  });
});

describe('access is unchanged: the category filter is no way around a grant', () => {
  const asUser = (token: string, filter: unknown, db = tasks) =>
    app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws}/databases/${db}/records/query`, headers: authed(token), payload: { filter } as never });
  const invite = async (name: string, grants: Array<Record<string, unknown>>) => {
    const u = await signUpUser(app, name);
    const inv = await inject('POST', `/workspaces/${ws}/invites`, { email: u.email, role: 'guest', grants });
    expect(inv.statusCode, inv.body).toBeLessThan(300);
    await app.inject({ method: 'POST', url: '/api/v1/invites/accept', headers: authed(u.token), payload: { token: new URL(inv.json().accept_url).searchParams.get('token')! } });
    return u;
  };

  it('a guest with a grant on Tasks gets the same rows; a guest with a grant elsewhere gets the answer a missing database gets', async () => {
    const reader = await invite('Cat Reader', [{ database_id: tasks, role: 'viewer' }]);
    const outsider = await invite('Cat Outsider', [{ database_id: projects, role: 'viewer' }]);
    const filter = { field: 'status', op: 'category_is', value: ['completed'] };
    const ok = await asUser(reader.token, filter);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((ok.json().data as Array<{ title: string }>).map((r) => r.title).sort()).toEqual(await titles(filter));
    expect((await asUser(outsider.token, filter)).statusCode).toBe(404);
    expect((await asUser(outsider.token, filter, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});
