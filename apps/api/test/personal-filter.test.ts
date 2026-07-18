import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #259: personal filter overrides. A viewer can narrow a shared view for
 * themselves without ever touching the view's own persisted ViewConfig, and
 * without seeing (or causing) any other viewer's override.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let teammate: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateField: { id: string; options: Array<{ id: string; label: string }> };
let todoOpt: string;
let doneOpt: string;
let viewId: string;
/** Captured ONCE, immediately after the view is created and before any
 * personal-filter write happens — deliberately NOT re-fetched inside a later
 * test, so an earlier test's leftover state can't make the "unchanged" check
 * vacuously true by comparing one corrupted snapshot to another. */
let originalViewConfig: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

/** Parse a CSV body into rows (same helper as csv-export.test.ts). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

async function exportNames(token: string, view: string): Promise<string[]> {
  const res = await as(token, 'GET', `/workspaces/${wsId}/databases/${dbId}/export/csv?view=${view}`);
  expect(res.statusCode, res.body).toBe(200);
  const rows = parseCsv(res.body);
  const nameCol = rows[0]!.indexOf('Name');
  return rows.slice(1).map((r) => r[nameCol]!);
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'PfOwner');
  teammate = await signUpUser(app, 'PfMate');

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Personal Filter WS' })).json().id;
  const spaceId = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  stateField = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  todoOpt = stateField.options.find((o) => o.label === 'To Do')!.id;
  doneOpt = stateField.options.find((o) => o.label === 'Done')!.id;

  await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Todo Alpha', state: todoOpt },
  });
  await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Todo Beta', state: todoOpt },
  });
  await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Done Gamma', state: doneOpt },
  });

  viewId = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Everything',
      type: 'table',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    })
  ).json().id;
  const created = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
  originalViewConfig = JSON.stringify(
    created.json().views.find((v: { id: string }) => v.id === viewId).config,
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

describe('personal filter overrides (#259)', () => {
  it('defaults to no override for a fresh view', async () => {
    const res = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().filter).toBeNull();
  });

  it('a viewer-rank member (not just an editor) may set their own override', async () => {
    // teammate is workspace role "member" → effective "creator" everywhere, but
    // the point of the AC is that this is NOT an admin-gated action — assert the
    // write succeeds without any explicit grant beyond ordinary membership.
    const res = await as(teammate.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`, {
      filter: { field: 'state', op: 'eq', value: todoOpt },
    });
    expect(res.statusCode, res.body).toBe(200);
    // Clean up so it doesn't leak into later tests in this describe block.
    await as(teammate.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
  });

  it('rejects a filter referencing an unknown field (422, mirrors view-config validation)', async () => {
    const res = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`, {
      filter: { field: 'ghost', op: 'eq', value: 1 },
    });
    expect(res.statusCode).toBe(422);
  });

  describe('the load-bearing test: two users, one view, zero cross-contamination', () => {
    it('each user reads back only their own override', async () => {
      const ownerSet = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`, {
        filter: { field: 'state', op: 'eq', value: doneOpt },
      });
      expect(ownerSet.statusCode, ownerSet.body).toBe(200);

      const mateSet = await as(teammate.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`, {
        filter: { field: 'state', op: 'eq', value: todoOpt },
      });
      expect(mateSet.statusCode, mateSet.body).toBe(200);

      const ownerGet = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
      const mateGet = await as(teammate.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
      expect(ownerGet.json().filter).toEqual({ field: 'state', op: 'eq', value: doneOpt });
      expect(mateGet.json().filter).toEqual({ field: 'state', op: 'eq', value: todoOpt });
      // Not just "different from default" — each user's own value, not the other's.
      expect(ownerGet.json().filter).not.toEqual(mateGet.json().filter);

      // The SHARED view config never moved — byte-identical against the TRUE
      // original captured right after creation (not a locally re-fetched
      // "before", which an earlier test's leftover state could have already
      // corrupted, making this comparison vacuously true) — after BOTH users'
      // personal-filter writes.
      const after = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
      const afterConfig = JSON.stringify(after.json().views.find((v: { id: string }) => v.id === viewId).config);
      expect(afterConfig).toBe(originalViewConfig);
    });

    it('each user sees only their own narrowed result set (query-time layering, no cross-contamination)', async () => {
      const ownerRows = await exportNames(owner.token, viewId);
      const mateRows = await exportNames(teammate.token, viewId);
      expect(ownerRows.sort()).toEqual(['Done Gamma']);
      expect(mateRows.sort()).toEqual(['Todo Alpha', 'Todo Beta']);
      // Disjoint — proves this isn't one shared result set both happen to read.
      expect(ownerRows.some((n) => mateRows.includes(n))).toBe(false);
    });

    it('AND-narrows, never widens: the personal result set is a subset of the shared-filter-only set', async () => {
      // The view itself carries no filter, so "shared-filter-only" = every record.
      const everything = ['Todo Alpha', 'Todo Beta', 'Done Gamma'];
      const ownerRows = await exportNames(owner.token, viewId);
      const mateRows = await exportNames(teammate.token, viewId);
      for (const name of ownerRows) expect(everything).toContain(name);
      for (const name of mateRows) expect(everything).toContain(name);
      expect(ownerRows.length).toBeLessThan(everything.length);
      expect(mateRows.length).toBeLessThan(everything.length);
    });

    afterAll(async () => {
      await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
      await as(teammate.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/personal-filter`);
    });
  });

  it('AND-narrows against a NON-empty shared filter too, not just an unfiltered view', async () => {
    const narrowedView = (
      await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
        name: 'Todo only',
        type: 'table',
        config: {
          filters: { field: 'state', op: 'eq', value: todoOpt },
          sorts: [],
          hidden_field_ids: [],
          card_field_ids: [],
          column_widths: {},
        },
      })
    ).json().id;

    const sharedOnly = await exportNames(owner.token, narrowedView);
    expect(sharedOnly.sort()).toEqual(['Todo Alpha', 'Todo Beta']);

    const set = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${narrowedView}/personal-filter`, {
      filter: { field: 'name', op: 'contains', value: 'Alpha' },
    });
    expect(set.statusCode, set.body).toBe(200);

    const narrowedFurther = await exportNames(owner.token, narrowedView);
    expect(narrowedFurther).toEqual(['Todo Alpha']);
    // Subset of the shared-filter-only set, not a different/wider set.
    for (const name of narrowedFurther) expect(sharedOnly).toContain(name);
    expect(narrowedFurther.length).toBeLessThan(sharedOnly.length);
  });

  describe('cleanup: no crash, no dangling state', () => {
    let cleanupViewId: string;
    let cleanupFieldId: string;

    beforeAll(async () => {
      const field = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
          display_name: 'Scratch',
          type: 'number',
        })
      ).json();
      cleanupFieldId = field.id;

      cleanupViewId = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
          name: 'Scratch view',
          type: 'table',
          config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
        })
      ).json().id;

      const set = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${cleanupViewId}/personal-filter`, {
        filter: { and: [{ field: 'state', op: 'eq', value: doneOpt }, { field: 'scratch', op: 'gt', value: 0 }] },
      });
      expect(set.statusCode, set.body).toBe(200);
    });

    it('deleting the view leaves the override gracefully unreachable, not crashing other endpoints', async () => {
      const del = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${cleanupViewId}`);
      expect(del.statusCode, del.body).toBe(200);

      const get = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${cleanupViewId}/personal-filter`);
      expect(get.statusCode).toBe(404);

      // The rest of the user's preferences blob is unaffected — no crash, no
      // 500, even though it still carries the now-orphaned key internally.
      const prefs = await as(owner.token, 'GET', '/users/me/preferences');
      expect(prefs.statusCode).toBe(200);
    });

    it('deleting a field the override references prunes that condition at read time — no crash', async () => {
      const secondView = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
          name: 'Scratch view 2',
          type: 'table',
          config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
        })
      ).json().id;

      const anotherField = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
          display_name: 'Scratch2',
          type: 'number',
        })
      ).json();

      const set = await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${secondView}/personal-filter`, {
        filter: { and: [{ field: 'state', op: 'eq', value: doneOpt }, { field: anotherField.apiName, op: 'gt', value: 0 }] },
      });
      expect(set.statusCode, set.body).toBe(200);

      const delField = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${anotherField.id}`);
      expect(delField.statusCode, delField.body).toBe(200);

      const get = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${secondView}/personal-filter`);
      expect(get.statusCode, get.body).toBe(200);
      // The dead condition is pruned out of the `and` group; the surviving
      // condition stays wrapped (cleanFilterNode only collapses an EMPTY group,
      // same as cleanViewConfig — it doesn't also flatten a lone survivor).
      expect(get.json().filter).toEqual({ and: [{ field: 'state', op: 'eq', value: doneOpt }] });
    });

    it('a deleted field referenced ALONE leaves no crash and an empty override', async () => {
      const thirdView = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
          name: 'Scratch view 3',
          type: 'table',
          config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
        })
      ).json().id;
      const soloField = (
        await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
          display_name: 'Solo',
          type: 'number',
        })
      ).json();

      await as(owner.token, 'PUT', `/workspaces/${wsId}/databases/${dbId}/views/${thirdView}/personal-filter`, {
        filter: { field: soloField.apiName, op: 'gt', value: 0 },
      });
      const delField = await as(owner.token, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${soloField.id}`);
      expect(delField.statusCode, delField.body).toBe(200);

      const get = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/views/${thirdView}/personal-filter`);
      expect(get.statusCode, get.body).toBe(200);
      expect(get.json().filter).toBeNull();

      // And the export/query path must not crash either, even with the stale
      // reference still sitting in storage until the next successful write.
      const exportRes = await as(owner.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/export/csv?view=${thirdView}`);
      expect(exportRes.statusCode, exportRes.body).toBe(200);
    });
  });
});
