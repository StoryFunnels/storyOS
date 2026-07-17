import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let tasksDb: string;
let clientsDb: string;
let taskField: { id: string }; // Client relation on Tasks (single ref, side a)
let blocksField: { id: string }; // self many-to-many on Tasks

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

let acme: string;
let parentTask: string;
let childTask: string;
let blockerTask: string;
let source: string;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Dupe');
  wsId = (await inject('POST', '/workspaces', { name: 'Dup WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  clientsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  tasksDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/fields`, { display_name: 'Estimate', type: 'number' });

  // single reference: Task -> Client (one_to_many, task is side a)
  taskField = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: clientsDb, cardinality: 'one_to_many', field_a_name: 'Client', field_b_name: 'Tasks',
  })).json().field_a;
  // owned collection + parent: self one_to_many (Sub-tasks / Parent)
  const parentRel = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: tasksDb, cardinality: 'one_to_many', field_a_name: 'Parent', field_b_name: 'Sub-tasks',
  })).json();
  const parentField = parentRel.field_a; // side a (single ref to parent)
  const subField = parentRel.field_b; // side b (owned collection)
  // self many-to-many: Blocks / Blocked by
  blocksField = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksDb, database_b_id: tasksDb, cardinality: 'many_to_many', field_a_name: 'Blocks', field_b_name: 'Blocked by',
  })).json().field_a;

  acme = (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Acme' } })).json().id;
  parentTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Epic' } })).json().id;
  childTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Child' } })).json().id;
  blockerTask = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Blocker' } })).json().id;
  source = (await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'Ship it', estimate: 5 } })).json().id;

  // wire up source: Client=Acme, Parent=Epic, one sub-task (Child), Blocks=Blocker
  await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/links/${taskField.id}`, { record_ids: [acme] });
  await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/links/${parentField.id}`, { record_ids: [parentTask] });
  await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${childTask}/links/${parentField.id}`, { record_ids: [source] }); // Child's parent is source
  await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/links/${blocksField.id}`, { record_ids: [blockerTask] });
  // a description document
  const doc = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/document`)).json();
  await inject('PUT', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/document`, {
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the plan', styles: {} }] }],
    expected_version: doc.version,
  });
  void subField;
});

afterAll(async () => {
  await app.close();
});

describe('record duplicate (MN-074)', () => {
  it('clones values + description + single-ref + m2m links, but not owned collections', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/duplicate`);
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json();
    expect(copy.id).not.toBe(source);
    expect(copy.title).toBe('Ship it (copy)');
    expect(copy.values.estimate).toBe(5);

    // single reference copied
    expect(copy.values.client?.[0]?.title).toBe('Acme');
    // parent (single ref) copied
    expect(copy.values.parent?.[0]?.title).toBe('Epic');
    // many-to-many copied
    expect(copy.values.blocks?.[0]?.title).toBe('Blocker');
    // owned collection NOT copied — the copy has no sub-tasks (Child still belongs only to source)
    expect(copy.values['sub_tasks'] ?? []).toHaveLength(0);
    const child = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${childTask}`)).json();
    expect(child.values.parent?.[0]?.id).toBe(source); // child still parented to the original only

    // description document copied
    const doc = (await inject('GET', `/workspaces/${wsId}/databases/${tasksDb}/records/${copy.id}/document`)).json();
    expect(JSON.stringify(doc.content)).toContain('the plan');
    expect(doc.version).toBeGreaterThan(0);
  });

  it('404s a bogus record id', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/00000000-0000-0000-0000-000000000000/duplicate`);
    expect(res.statusCode).toBe(404);
  });

  /**
   * Duplicate is `@MinRole`-free but calls `assertDb(req, db, 'creator')` — a
   * clone writes a whole new record plus its links, so it sits on the schema rung,
   * not the editor one. This test used to carry that name while asserting only a
   * 404 on a bogus id: dropping the requirement to 'viewer' left it green.
   * An editor is the interesting rung — one below creator, and able to write
   * records by every other route.
   */
  it('needs creator access — an editor cannot duplicate', async () => {
    const guest = await signUpUser(app, 'DupeGuest');
    const guestId = (
      await app.inject({ method: 'GET', url: '/api/v1/me', headers: authed(guest.token) })
    ).json().id;
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

    const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: spaceId, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(guest.token),
      payload: { token },
    });
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);

    const asGuest = (method: string, url: string, payload?: unknown) =>
      app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(guest.token), payload: payload as never });

    // Positive control: the editor really can write records here, so the refusal
    // below is about the creator rung and not about reach.
    expect(
      (await asGuest('POST', `/workspaces/${wsId}/databases/${tasksDb}/records`, { values: { name: 'editor can create' } })).statusCode,
      'an editor must be able to create ordinary records',
    ).toBe(201);

    const dup = await asGuest('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/duplicate`);
    expect(dup.statusCode, `an editor must not be able to duplicate: ${dup.body}`).toBe(403);

    // Promote to creator: the same call now works — the rung is what gates it.
    const grant = await inject('POST', `/workspaces/${wsId}/grants`, {
      user_id: guestId,
      space_id: spaceId,
      role: 'creator',
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const asCreator = await asGuest('POST', `/workspaces/${wsId}/databases/${tasksDb}/records/${source}/duplicate`);
    expect(asCreator.statusCode, `a creator must be able to duplicate: ${asCreator.body}`).toBe(201);
  });
});
