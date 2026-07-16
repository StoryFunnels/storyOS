import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-211 (#137): a self-relation puts both fields on one card, so the two sides
 * must be named distinctly — dependency-aware defaults when unnamed, a clear 422
 * when the user types the same name twice.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let issues: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(owner.token),
    payload: payload as never,
  });
}

const makeDb = async (name: string) => {
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  return (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name })).json().id;
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ws = (await inject('POST', '/workspaces', { name: 'SelfRel WS' })).json().id;
  issues = await makeDb('Issues');
});

afterAll(async () => {
  await app.close();
});

describe('self-relation naming (MN-211)', () => {
  it('an unnamed one_to_many self-relation defaults to Parent / Sub-items', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: issues,
      database_b_id: issues,
      cardinality: 'one_to_many',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().field_a.display_name).toBe('Parent');
    expect(res.json().field_b.display_name).toBe('Sub-items');
  });

  it('an unnamed many_to_many self-relation defaults to Related / Related to', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: issues,
      database_b_id: issues,
      cardinality: 'many_to_many',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().field_a.display_name).toBe('Related');
    expect(res.json().field_b.display_name).toBe('Related to');
  });

  it('identical user-typed side names are refused with an instructive message', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: issues,
      database_b_id: issues,
      cardinality: 'many_to_many',
      field_a_name: 'Linked',
      field_b_name: ' linked ', // case/whitespace variants count as identical
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error?.message ?? res.json().message).toMatch(/different names/);
  });

  it('distinct user-typed names work and land on the same database', async () => {
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: issues,
      database_b_id: issues,
      cardinality: 'many_to_many',
      field_a_name: 'Blocks',
      field_b_name: 'Blocked by',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().field_a.display_name).toBe('Blocks');
    expect(res.json().field_b.display_name).toBe('Blocked by');
    expect(res.json().field_a.database_id).toBe(issues);
    expect(res.json().field_b.database_id).toBe(issues);
  });

  it('cross-database defaults are unchanged (db names, no dependency wording)', async () => {
    const projects = await makeDb('Projects');
    const res = await inject('POST', `/workspaces/${ws}/relations`, {
      database_a_id: issues,
      database_b_id: projects,
      cardinality: 'many_to_many',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().field_a.display_name).toBe('Projects');
    expect(res.json().field_b.display_name).toBe('Issues');
  });
});
