import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-212 (#138): a database cannot carry two fields with the same display name.
 * apiName was always unique; the display name wasn't, so two fields could render
 * the same label on a card. User-typed names hard-block; auto-generated relation
 * defaults suffix themselves instead.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let space: string;
let tasks: string;
let notes: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(owner.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'Unique WS' })).json().id;
  space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  notes = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Notes' })).json().id;
  const first = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
    display_name: 'Priority',
    type: 'text',
  });
  expect(first.statusCode).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('display-name uniqueness (MN-212)', () => {
  it('rejects creating a field with an existing name (case-insensitive, trimmed)', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, {
      display_name: '  priority ',
      type: 'number',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.message ?? res.json().message).toMatch(/already exists/);
  });

  it('allows the same name on a DIFFERENT database', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${notes}/fields`, {
      display_name: 'Priority',
      type: 'text',
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects renaming a field to an existing name, but allows renaming to itself', async () => {
    const other = (
      await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Effort', type: 'number' })
    ).json();

    const clash = await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/fields/${other.id}`, {
      display_name: 'Priority',
    });
    expect(clash.statusCode).toBe(422);

    // Re-saving its own name (e.g. only the config changed) must not self-collide.
    const self = await inject('PATCH', `/workspaces/${ws}/databases/${tasks}/fields/${other.id}`, {
      display_name: 'Effort',
    });
    expect(self.statusCode).toBe(200);
  });

  it('rejects a USER-TYPED relation field name that collides — never silently suffixes', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: tasks,
      database_b_id: notes,
      cardinality: 'many_to_many',
      field_a_name: 'Priority', // user-typed, collides on Tasks
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.message ?? res.json().message).toMatch(/already exists/);
  });

  it('auto-suffixes an AUTO-GENERATED relation default instead of failing', async () => {
    // Default side-A name is the target database's name ("Notes"). Occupy it first.
    await inject('POST', `/workspaces/${ws}/databases/${tasks}/fields`, { display_name: 'Notes', type: 'text' });
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: tasks,
      database_b_id: notes,
      cardinality: 'many_to_many',
      // no field_a_name → auto default "Notes" collides → should become "Notes 2"
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().field_a.display_name).toBe('Notes 2');
  });

  it('a self-relation gets two distinct names even when both are auto-generated', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: notes,
      database_b_id: notes,
      cardinality: 'many_to_many',
    });
    expect(res.statusCode).toBe(201);
    const a = res.json().field_a.display_name.toLowerCase();
    const b = res.json().field_b.display_name.toLowerCase();
    expect(a).not.toBe(b);
  });
});
