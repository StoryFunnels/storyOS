import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #674 — comments + references across a whole relation tree (Epic→Story→Task),
 * permission-checked. THIS IS A SECURITY BOUNDARY (a walked record set can
 * span multiple databases with different access), so — per this session's
 * own recurring lesson — a test without a GUEST fixture proves nothing about
 * it. Every access assertion here uses a real guest with a real grant.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let epicsDb: string;
let storiesDb: string;
let tasksDb: string;
let storiesFieldOnEpic: string; // relation field on Epics -> Stories (side b, multi)
let tasksFieldOnStory: string; // relation field on Stories -> Tasks (side b, multi)

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function comment(token: string, dbId: string, recordId: string, text: string) {
  return as(token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}/comments`, {
    body: [{ type: 'text', text }],
  });
}

async function hierarchy(token: string, rootDb: string, rootRecord: string, fieldIds: string[]) {
  return as(
    token,
    'GET',
    `/workspaces/${wsId}/databases/${rootDb}/records/${rootRecord}/activity/hierarchy?relation_field_ids=${fieldIds.join(',')}`,
  );
}

let epic1: string;
let story1: string;
let story2: string;
let task1: string;
let task2: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'HierarchyOwner');
  guest = await signUpUser(app, 'HierarchyGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '674 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  epicsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Epics' })).json().id;
  storiesDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Stories' })).json().id;
  tasksDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  // Side a (many real records) gets the single-valued field; side b (one) gets
  // the multi-valued reverse field — same convention this session's other
  // relation tests already establish.
  await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: storiesDb, database_b_id: epicsDb, cardinality: 'one_to_many', field_a_name: 'Epic', field_b_name: 'Stories',
  });
  await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: storiesDb, cardinality: 'one_to_many', field_a_name: 'Story', field_b_name: 'Tasks',
  });
  const epicFields = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${epicsDb}`)).json().fields;
  storiesFieldOnEpic = epicFields.find((f: { apiName: string }) => f.apiName === 'stories').id;
  const storyFields = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${storiesDb}`)).json().fields;
  tasksFieldOnStory = storyFields.find((f: { apiName: string }) => f.apiName === 'tasks').id;

  epic1 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${epicsDb}/records`, { values: { name: 'Epic 1' } })).json().id;
  story1 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${storiesDb}/records`, { values: { name: 'Story 1' } })).json().id;
  story2 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${storiesDb}/records`, { values: { name: 'Story 2' } })).json().id;
  task1 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Task 1' } })).json().id;
  task2 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Task 2' } })).json().id;

  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${epicsDb}/records/${epic1}/links/${storiesFieldOnEpic}`, {
    record_ids: [story1, story2],
  });
  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${storiesDb}/records/${story1}/links/${tasksFieldOnStory}`, {
    record_ids: [task1],
  });
  await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${storiesDb}/records/${story2}/links/${tasksFieldOnStory}`, {
    record_ids: [task2],
  });

  await comment(admin.token, epicsDb, epic1, 'on the epic');
  await comment(admin.token, storiesDb, story1, 'on story 1');
  await comment(admin.token, storiesDb, story2, 'on story 2');
  await comment(admin.token, tasksDb, task1, 'on task 1');
  await comment(admin.token, tasksDb, task2, 'on task 2');

  // Guest: viewer on Epics + Stories, NOTHING on Tasks — the fixture #674's
  // own AC demands: a real access boundary somewhere inside the walked tree.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [
      { database_id: epicsDb, role: 'viewer' },
      { database_id: storiesDb, role: 'viewer' },
    ],
  });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token: inviteToken });
  void guestId;
});

afterAll(async () => {
  await app.close();
});

describe('#674 hierarchy activity aggregation', () => {
  it('admin: aggregates comments across the WHOLE tree — epic, both stories, both tasks', async () => {
    const res = await hierarchy(admin.token, epicsDb, epic1, [storiesFieldOnEpic, tasksFieldOnStory]);
    expect(res.statusCode, res.body).toBe(200);
    const snippets = (res.json().data as Array<{ comment: { snippet: string } }>).map((e) => e.comment.snippet);
    expect(snippets.sort()).toEqual(
      ['on the epic', 'on story 1', 'on story 2', 'on task 1', 'on task 2'].sort(),
    );
  });

  it('ADVERSARIAL: a guest with no access to Tasks sees the epic + stories, but the tasks are EXCLUDED, not a 403/404 for the whole tree', async () => {
    const res = await hierarchy(guest.token, epicsDb, epic1, [storiesFieldOnEpic, tasksFieldOnStory]);
    expect(res.statusCode, res.body).toBe(200);
    const snippets = (res.json().data as Array<{ comment: { snippet: string } }>).map((e) => e.comment.snippet);
    expect(snippets.sort()).toEqual(['on the epic', 'on story 1', 'on story 2'].sort());
    expect(snippets).not.toContain('on task 1');
    expect(snippets).not.toContain('on task 2');
  });

  it('ADVERSARIAL: the root itself invisible to the caller 404s the whole request', async () => {
    const outsider = await signUpUser(app, 'HierarchyOutsider');
    const res = await hierarchy(outsider.token, epicsDb, epic1, [storiesFieldOnEpic, tasksFieldOnStory]);
    expect(res.statusCode).toBe(404);
  });

  it('a chain longer than the bound (5) is rejected', async () => {
    const tooLong = Array(6).fill(storiesFieldOnEpic);
    const res = await hierarchy(admin.token, epicsDb, epic1, tooLong);
    expect(res.statusCode).toBe(422);
  });

  it('a bad/dangling field at the first level degrades to just the root, not an error', async () => {
    const res = await hierarchy(admin.token, epicsDb, epic1, ['00000000-0000-0000-0000-000000000000']);
    expect(res.statusCode, res.body).toBe(200);
    const snippets = (res.json().data as Array<{ comment: { snippet: string } }>).map((e) => e.comment.snippet);
    expect(snippets).toEqual(['on the epic']);
  });

  it('a diamond (two stories reaching a shared task via re-linking) is not double-counted', async () => {
    // Link task1 to story2 as well — task1 is now reachable via BOTH stories.
    await as(admin.token, 'PUT', `/workspaces/${wsId}/databases/${storiesDb}/records/${story2}/links/${tasksFieldOnStory}`, {
      record_ids: [task2, task1],
    });
    const res = await hierarchy(admin.token, epicsDb, epic1, [storiesFieldOnEpic, tasksFieldOnStory]);
    const snippets = (res.json().data as Array<{ comment: { snippet: string } }>).map((e) => e.comment.snippet);
    expect(snippets.filter((s) => s === 'on task 1')).toHaveLength(1);
  });
});
