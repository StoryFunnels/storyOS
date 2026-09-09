import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #657 — a relation field becomes sortable by the LINKED record's title, but
 * only when the relation field is SINGLE-valued: side 'a' of a one_to_many
 * relation (relations.service.ts's own "side A is the many side: each
 * record has at most one parent"). A multi-valued relation (many_to_many
 * either side, or one_to_many's side b) is refused, matching the exact
 * shape `user`'s own multi-valued refusal already had — this ticket adds a
 * SECOND case to that rule, not a new rule.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let tasksDb: string;
let projectsDb: string;
let projectFieldApi: string; // Tasks -> Projects, one_to_many, side a (single) — sortable
let tagsFieldApi: string; // Tasks <-> Tags, many_to_many — NOT sortable

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

async function apiNameOf(fieldId: string, dbId: string): Promise<string> {
  const db = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  return db.fields.find((f: { id: string }) => f.id === fieldId).apiName;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RelationSorter');
  wsId = (await inject('POST', '/workspaces', { name: 'Relation Sort WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  const tagsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tags' })).json().id;

  const rel = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: projectsDb,
    cardinality: 'one_to_many',
    name_a: 'Project',
    name_b: 'Tasks',
  });
  const projectFieldId: string = rel.json().field_a?.id ?? rel.json().fieldA?.id;
  projectFieldApi = await apiNameOf(projectFieldId, tasksDb);

  const m2m = await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb,
    database_b_id: tagsDb,
    cardinality: 'many_to_many',
    name_a: 'Tags',
    name_b: 'Tasks',
  });
  const tagsFieldId: string = m2m.json().field_a?.id ?? m2m.json().fieldA?.id;
  tagsFieldApi = await apiNameOf(tagsFieldId, tasksDb);
});

afterAll(async () => {
  await app.close();
});

const queryUrl = () => `/workspaces/${wsId}/databases/${tasksDb}/records/query`;
async function sortTitles(direction: 'asc' | 'desc'): Promise<string[]> {
  const res = await inject('POST', queryUrl(), { sorts: [{ field: projectFieldApi, direction }] });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data.map((r: { title: string }) => r.title);
}

describe('#657 sorting a relation field orders by the linked record\'s title', () => {
  let zephyrTask: string;
  let apolloTask: string;
  let unlinkedTask: string;

  beforeAll(async () => {
    const apollo = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, {
      values: { name: 'Apollo' },
    });
    const zephyr = await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, {
      values: { name: 'Zephyr' },
    });

    const zTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Task on Zephyr', [projectFieldApi]: [zephyr.json().id] },
    })).json();
    zephyrTask = zTask.title;

    const aTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Task on Apollo', [projectFieldApi]: [apollo.json().id] },
    })).json();
    apolloTask = aTask.title;

    const uTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, {
      values: { name: 'Unlinked task' },
    })).json();
    unlinkedTask = uTask.title;
  });

  it('accepts a sort by the single-valued relation field — no more 422', async () => {
    const res = await inject('POST', queryUrl(), { sorts: [{ field: projectFieldApi, direction: 'asc' }] });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('orders ascending by the linked project\'s title, not creation order or id', async () => {
    const titles = await sortTitles('asc');
    const aIdx = titles.indexOf(apolloTask);
    const zIdx = titles.indexOf(zephyrTask);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(zIdx).toBeGreaterThan(aIdx); // "Apollo" < "Zephyr"
  });

  it('reverses on desc', async () => {
    const titles = await sortTitles('desc');
    const aIdx = titles.indexOf(apolloTask);
    const zIdx = titles.indexOf(zephyrTask);
    expect(zIdx).toBeLessThan(aIdx);
  });

  it('an unlinked (empty-relation) record sorts to a consistent, stated position — NULLS LAST, same as every other sortable field type', async () => {
    const asc = await sortTitles('asc');
    const desc = await sortTitles('desc');
    // NULLS LAST is this API's stated default (records.service.ts's nullsClause) —
    // the empty-relation row trails in BOTH directions, never leading either way.
    expect(asc.indexOf(unlinkedTask)).toBe(asc.length - 1);
    expect(desc.indexOf(unlinkedTask)).toBe(desc.length - 1);
  });
});

describe('#657 a multi-valued relation is refused, same shape as a multi-valued user field', () => {
  it('422s naming the field, rather than silently ordering by something arbitrary', async () => {
    const res = await inject('POST', queryUrl(), { sorts: [{ field: tagsFieldApi, direction: 'asc' }] });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain(tagsFieldApi);
  });
});
