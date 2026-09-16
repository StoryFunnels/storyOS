import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 3 — the record-level narrowing #469 never had: a guest whose
 * only access to the TARGET database of a relation is one or more
 * record-scoped grants (#472) must see a chip only for a linked record one
 * of those grants actually names — never a bare-database-level "sees
 * everything" or "sees nothing" outcome, and never a partial/redacted chip
 * for the denied one (an ABSENT chip, per #469's own precedent).
 *
 * This is the SAME underlying gap ticket #473 needs closed for its own
 * ruling (a linked record outside a grant is a bare reference, a rollup
 * over inaccessible records returns nothing) — attachRollups/attachLookups
 * derive their candidate ids from attachLinks' own chips, so fixing this
 * one fix point closes both tickets' remaining read-path gap.
 *
 * THIS IS A SECURITY BOUNDARY: every assertion uses a real guest with a
 * real record-scoped grant, never an admin/member sanity check alone.
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
let projectApiName: string;
let projectFieldId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function setGrant(scope: { space_id?: string; database_id?: string; record_id?: string }, role: string) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/grants`, { user_id: guestId, ...scope, role });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ChipScopeOwner');
  guest = await signUpUser(app, 'ChipScopeGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p3 Chip Scope WS' })).json().id;
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
  projectApiName = rel.json().field_a.api_name ?? rel.json().field_a.apiName;

  projectA = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Project A' } })).json().id;
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}/links/${projectFieldId}`, {
    record_ids: [clientX, clientY],
  });

  // Guest: record-scoped grant on projectA (so they can see the project at
  // all) PLUS a record-scoped grant on clientX only — never a space/database
  // grant on either database, so visibleRecordIds narrows both sides.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: projectA, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  await setGrant({ record_id: clientX }, 'viewer');
});

afterAll(async () => {
  await app.close();
});

describe('#474 phase 3 — relation chips narrow to record-scoped grants on the TARGET database', () => {
  it('the chip array contains ONLY the granted linked record — the denied one is absent, not redacted', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(res.statusCode, res.body).toBe(200);
    const chips = res.json().values[projectApiName] as Array<{ id: string }>;
    const ids = chips.map((c) => c.id);
    expect(ids).toContain(clientX);
    expect(ids).not.toContain(clientY);
  });

  it('listLinks (the relation-picker/panel endpoint) agrees with the chip — same narrowing, same fix point family', async () => {
    const linksRes = await as(
      guest.token,
      'GET',
      `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}/links/${projectFieldId}`,
    );
    expect(linksRes.statusCode, linksRes.body).toBe(200);
    const ids = (linksRes.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(clientX);
    expect(ids).not.toContain(clientY);
  });

  it('a rollup over the relation counts only the granted linked record, not both', async () => {
    const countField = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${projectsDb}/fields`, {
      display_name: 'Client Count',
      type: 'rollup',
      config: { relation_field_id: projectFieldId, op: 'count' },
    });
    expect(countField.statusCode, countField.body).toBeLessThan(300);
    const countApiName = countField.json().apiName ?? countField.json().api_name;

    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    expect(res.json().values[countApiName]).toBe(1); // clientX only, not clientY
  });

  it('widening the grant to include the previously-denied record widens the chip too', async () => {
    await setGrant({ record_id: clientY }, 'viewer');
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${projectsDb}/records/${projectA}`);
    const ids = (res.json().values[projectApiName] as Array<{ id: string }>).map((c) => c.id);
    expect(ids.sort()).toEqual([clientX, clientY].sort());
  });
});
