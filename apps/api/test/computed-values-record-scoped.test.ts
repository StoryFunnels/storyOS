import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #778 — `RecordsService.project()` copied `row.computedValues` VERBATIM
 * into the response, before attachRollups/attachFormulas ran their
 * caller-aware narrowing on `values`. So a record-scoped guest correctly
 * denied a linked child got a correctly-narrowed count in `values` but the
 * TRUE, unrestricted count in `computed_values` — in the SAME response body.
 * Vera reproduced this live with curl; this is that reproduction as a test,
 * asserting it goes red on the unfixed code and green after.
 *
 * Same fixture shape as relation-chip-record-scoped.test.ts (#474 phase 3),
 * which already proves `values` narrows correctly — this file is specifically
 * about `computed_values` agreeing with it.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let spaceId: string;
let projectsDb: string;
let clientsDb: string;
let projectA: string;
let clientX: string;
let clientY: string;
let projectFieldId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { record_id?: string }, role: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...scope, role });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ComputedValuesOwner');
  guest = await signUpUser(app, 'ComputedValuesGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '778 Computed Values WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  projectsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;
  clientsDb = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;

  clientX = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client X (granted)' } })).json().id;
  clientY = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: 'Client Y (denied)' } })).json().id;

  const rel = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsDb,
    database_b_id: clientsDb,
    cardinality: 'many_to_many',
    field_a_name: 'Clients',
    field_b_name: 'Projects',
  });
  projectFieldId = rel.json().field_a.id;

  projectA = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Project A' } })).json().id;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}/links/${projectFieldId}`, {
    record_ids: [clientX, clientY],
  });

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: projectA, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  // Guest sees projectA and clientX only — never clientY. True count is 2, narrowed count is 1.
  await setGrant({ record_id: clientX }, 'viewer');
});

afterAll(async () => {
  await app.close();
});

describe('#778 — computed_values agrees with the caller-narrowed values, never leaks the raw count', () => {
  it('a rollup count: computed_values matches the narrowed values, not the true unrestricted count', async () => {
    const countField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Client Count',
      type: 'rollup',
      config: { relation_field_id: projectFieldId, op: 'count' },
    });
    expect(countField.statusCode, countField.body).toBeLessThan(300);
    const countFieldId = countField.json().id as string;
    const countApiName = countField.json().apiName ?? countField.json().api_name;

    // Admin sees the true count in both places — nothing to narrow for them.
    const adminRes = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(adminRes.json().values[countApiName]).toBe(2);
    expect(adminRes.json().computed_values[countFieldId]).toBe(2);

    const guestRes = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(guestRes.statusCode, guestRes.body).toBe(200);
    // Already correct before this fix (attachRollups derives it from narrowed chips).
    expect(guestRes.json().values[countApiName]).toBe(1);
    // THE ACTUAL BUG: computed_values must agree, not silently hand back the true count.
    expect(guestRes.json().computed_values[countFieldId]).toBe(1);
  });

  it('query_records (list) leaks the same way as get_record — both go through project()', async () => {
    const countField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Client Count List',
      type: 'rollup',
      config: { relation_field_id: projectFieldId, op: 'count' },
    });
    const countFieldId = countField.json().id as string;
    const countApiName = countField.json().apiName ?? countField.json().api_name;

    const list = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records`);
    expect(list.statusCode, list.body).toBe(200);
    const row = (list.json().data as Array<{ id: string }>).find((r) => r.id === projectA) as {
      values: Record<string, unknown>;
      computed_values: Record<string, unknown>;
    };
    expect(row.values[countApiName]).toBe(1);
    expect(row.computed_values[countFieldId]).toBe(1);
  });

  it("a formula aggregating over the relation: computed_values follows values, not the persisted materialized copy", async () => {
    const formulaField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Client Count Formula',
      type: 'formula',
      config: { expression: 'count({Clients})' },
    });
    expect(formulaField.statusCode, formulaField.body).toBeLessThan(300);
    const formulaFieldId = formulaField.json().id as string;
    const formulaApiName = formulaField.json().apiName ?? formulaField.json().api_name;

    const adminRes = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(adminRes.json().values[formulaApiName]).toBe(2);

    const guestRes = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(guestRes.json().values[formulaApiName]).toBe(1);
    expect(guestRes.json().computed_values[formulaFieldId]).toBe(1);
  });

  it('widening the grant widens computed_values too, not just values', async () => {
    const countField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Client Count Widen',
      type: 'rollup',
      config: { relation_field_id: projectFieldId, op: 'count' },
    });
    const countFieldId = countField.json().id as string;
    const countApiName = countField.json().apiName ?? countField.json().api_name;

    const before = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(before.json().values[countApiName]).toBe(1);
    expect(before.json().computed_values[countFieldId]).toBe(1);

    await setGrant({ record_id: clientY }, 'viewer');
    const after = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(after.json().values[countApiName]).toBe(2);
    expect(after.json().computed_values[countFieldId]).toBe(2);
  });
});
