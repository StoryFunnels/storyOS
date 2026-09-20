import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #736: personal embedded-collection view overrides. Filtering/sorting/coloring
 * an embedded relation collection on a record page used to write straight onto
 * the relation FIELD's own shared config — one viewer's filter became every
 * viewer's, permanently. This is the per-user layer instead, mirroring #259's
 * personal-filter mechanism for views but keyed by field id.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let teammate: { token: string; email: string };
let wsId: string;
let clientsId: string;
let projectsId: string;
let relationFieldId: string;
let numberFieldId: string;
/** Captured ONCE, right after the relation is created and before any personal
 * write happens — a later test comparing against this proves the field's own
 * config never moved, rather than comparing one already-corrupted state to
 * another. */
let originalFieldConfig: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'PcvOwner');
  teammate = await signUpUser(app, 'PcvMate');

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Personal Collection View WS' })).json().id;
  const spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  clientsId = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients' })).json().id;
  projectsId = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })).json().id;

  const statusField = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Status',
      type: 'select',
      options: [{ label: 'Active' }, { label: 'Done' }],
    })
  ).json();
  const activeOpt = statusField.options.find((o: { label: string }) => o.label === 'Active').id;
  const doneOpt = statusField.options.find((o: { label: string }) => o.label === 'Done').id;

  const numberField = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${projectsId}/fields`, {
      display_name: 'Budget',
      type: 'number',
    })
  ).json();
  numberFieldId = numberField.id;

  const rel = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/relations`, {
      database_a_id: clientsId,
      database_b_id: projectsId,
      cardinality: 'many_to_many',
    })
  ).json();
  relationFieldId = rel.field_a.id;

  const client = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${clientsId}/records`, { values: { name: 'Acme' } })
  ).json();

  const p1 = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${projectsId}/records`, {
      values: { name: 'Active One', status: activeOpt },
    })
  ).json();
  const p2 = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${projectsId}/records`, {
      values: { name: 'Done Two', status: doneOpt },
    })
  ).json();
  await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/records/${client.id}/links/${relationFieldId}`, {
    record_ids: [p1.id, p2.id],
  });

  const detail = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}`);
  originalFieldConfig = JSON.stringify(
    detail.json().fields.find((f: { id: string }) => f.id === relationFieldId).config,
  );

  const invite = await as(owner.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: teammate.email,
    role: 'member',
  });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(teammate.token, 'POST', '/invites/accept', { token: inviteToken });
});

afterAll(async () => {
  await app.close();
});

describe('personal collection-view overrides (#736)', () => {
  it('defaults to no override for a fresh field', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().config).toBeNull();
  });

  it('404s for a field that is not a relation', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${numberFieldId}/personal-collection-view`);
    // numberFieldId lives on Projects, not Clients — also confirms cross-database
    // field ids 404 rather than silently resolving.
    expect(res.statusCode).toBe(404);
  });

  it('404s for a field that does not exist', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/00000000-0000-0000-0000-000000000000/personal-collection-view`);
    expect(res.statusCode).toBe(404);
  });

  it('a viewer-rank member (not just an editor) may set their own override', async () => {
    const res = await as(teammate.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`, {
      filters: { and: [{ field: 'status', op: 'eq', value: 'Active' }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    await as(teammate.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
  });

  describe('the load-bearing test: two users, one field, zero cross-contamination', () => {
    it('each user reads back only their own override, and the field\'s own config never moves', async () => {
      const ownerSet = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`, {
        filters: { and: [{ field: 'status', op: 'eq', value: 'Active' }] },
        color_by: 'status',
      });
      expect(ownerSet.statusCode, ownerSet.body).toBe(200);

      const mateSet = await as(teammate.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`, {
        sorts: [{ field: 'name', direction: 'desc' }],
      });
      expect(mateSet.statusCode, mateSet.body).toBe(200);

      const ownerGet = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
      const mateGet = await as(teammate.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
      expect(ownerGet.json().config).toEqual({
        filters: { and: [{ field: 'status', op: 'eq', value: 'Active' }] },
        color_by: 'status',
      });
      expect(mateGet.json().config).toEqual({ sorts: [{ field: 'name', direction: 'desc' }] });
      expect(ownerGet.json().config).not.toEqual(mateGet.json().config);

      // The SHARED field config never moved — byte-identical against the TRUE
      // original captured right after the relation was created — after BOTH
      // users' personal-collection-view writes. This is the AC1 assertion.
      const after = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}`);
      const afterConfig = JSON.stringify(after.json().fields.find((f: { id: string }) => f.id === relationFieldId).config);
      expect(afterConfig).toBe(originalFieldConfig);
    });

    afterAll(async () => {
      await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
      await as(teammate.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    });
  });

  it('clear removes the ENTIRE override (filter, sort, color together), falling back to no override', async () => {
    const set = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`, {
      filters: { and: [{ field: 'status', op: 'eq', value: 'Active' }] },
      sorts: [{ field: 'name', direction: 'asc' }],
      color_by: 'status',
    });
    expect(set.statusCode, set.body).toBe(200);

    const clear = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    expect(clear.statusCode, clear.body).toBe(200);

    const get = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    expect(get.json().config).toBeNull();
  });

  it('clearing twice (or clearing one never set) is a no-op, not an error', async () => {
    const first = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    expect(first.statusCode, first.body).toBe(200);
    const second = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${clientsId}/fields/${relationFieldId}/personal-collection-view`);
    expect(second.statusCode, second.body).toBe(200);
  });

  it('deleting the field (via the relations API, which owns relation fields) leaves the override gracefully unreachable, not crashing other endpoints', async () => {
    const rel = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/relations`, {
        database_a_id: clientsId,
        database_b_id: projectsId,
        cardinality: 'many_to_many',
      })
    ).json();
    const set = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${clientsId}/fields/${rel.field_a.id}/personal-collection-view`, {
      filters: { and: [{ field: 'status', op: 'eq', value: 'Active' }] },
    });
    expect(set.statusCode, set.body).toBe(200);

    const delRel = await as(owner.token, 'DELETE', `/workspaces/${wsId}/relations/${rel.id}`, { confirm: true });
    expect(delRel.statusCode, delRel.body).toBe(200);

    const get = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${clientsId}/fields/${rel.field_a.id}/personal-collection-view`);
    expect(get.statusCode).toBe(404);

    // The rest of the user's preferences blob is unaffected — no crash, no 500,
    // even though it still carries the now-orphaned key internally.
    const prefs = await as(owner.token, 'GET', '/users/me/preferences');
    expect(prefs.statusCode).toBe(200);
  });
});
