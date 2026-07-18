import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateFieldId: string;
let stateOptions: Array<{ id: string; label: string }>;
let estimateFieldId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Viewer');
  wsId = (await inject('POST', '/workspaces', { name: 'Views WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  const state = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  stateFieldId = state.id;
  stateOptions = state.options;

  estimateFieldId = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Estimate',
      type: 'number',
    })
  ).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('views backend (MN-020)', () => {
  let boardId: string;

  it('creates a board view with a validated config', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Task Board',
      type: 'board',
      config: {
        filters: { field: 'estimate', op: 'gt', value: 0 },
        sorts: [{ field: 'estimate', direction: 'desc' }],
        group_by_field_id: stateFieldId,
        card_field_ids: [estimateFieldId],
        column_widths: { [estimateFieldId]: 120 },
        hidden_field_ids: [],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    boardId = res.json().id;
  });

  it('rejects boards grouped by non-select fields and unknown references', async () => {
    const badGroup = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Bad board',
      type: 'board',
      config: { group_by_field_id: estimateFieldId, sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(badGroup.statusCode).toBe(422);

    const badFilter = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Ghost filter',
      type: 'table',
      config: { filters: { field: 'ghost', op: 'eq', value: 1 }, sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} },
    });
    expect(badFilter.statusCode).toBe(422);
  });

  it('round-trips config through update and introspection', async () => {
    const update = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/views/${boardId}`, {
      name: 'Sprint Board',
      config: {
        sorts: [],
        hidden_field_ids: [estimateFieldId],
        group_by_field_id: stateFieldId,
        card_field_ids: [],
        column_widths: {},
      },
    });
    expect(update.statusCode).toBe(200);

    const detail = await inject('GET', `/workspaces/${wsId}/databases/${dbId}`);
    const view = detail.json().views.find((v: { id: string }) => v.id === boardId);
    expect(view.name).toBe('Sprint Board');
    expect(view.config.hidden_field_ids).toEqual([estimateFieldId]);
  });

  it('drops references to deleted fields defensively at read time', async () => {
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${estimateFieldId}`);
    const detail = await inject('GET', `/workspaces/${wsId}/databases/${dbId}`);
    const view = detail.json().views.find((v: { id: string }) => v.id === boardId);
    expect(view.config.hidden_field_ids).toEqual([]);
    expect(view.config.group_by_field_id).toBe(stateFieldId); // select field still lives
  });

  it('keeps at least one view per database', async () => {
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${boardId}`);
    const detail = await inject('GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(detail.json().views).toHaveLength(1);

    const last = detail.json().views[0].id;
    const res = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/views/${last}`);
    expect(res.statusCode).toBe(409);
  });

  it('guests cannot create views', async () => {
    const guest = await signUpUser(app, 'ViewGuest');
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ space_id: spaceId, role: 'commenter' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await app.inject({
      method: 'POST',
      url: '/api/v1/invites/accept',
      headers: authed(guest.token),
      payload: { token },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/views`,
      headers: authed(guest.token),
      payload: { name: 'Nope', type: 'table', config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} } },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('view rename / duplicate / default (MN-241)', () => {
  // Own database so earlier tests' field deletions can't affect this block.
  let vdb: string;
  const EMPTY = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };
  const views = async () =>
    (await inject('GET', `/workspaces/${wsId}/databases/${vdb}`)).json().views as Array<{
      id: string;
      name: string;
      position: number;
      isDefault: boolean;
      config: { hidden_field_ids?: string[] };
    }>;
  const addView = async (name: string) =>
    (await inject('POST', `/workspaces/${wsId}/databases/${vdb}/views`, { name, type: 'table', config: EMPTY })).json();

  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    vdb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'ViewOps' })).json().id;
  });

  it('the auto-created view is the default', async () => {
    const defaults = (await views()).filter((v) => v.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.name).toBe('All records');
  });

  it('duplicates a view with its full config, next to the original', async () => {
    const source = await addView('Filtered');
    const res = await inject('POST', `/workspaces/${wsId}/databases/${vdb}/views/${source.id}/duplicate`);
    expect(res.statusCode, res.body).toBe(201);
    const copy = res.json();
    expect(copy.name).toBe('Filtered copy');
    expect(copy.isDefault).toBe(false);
    expect(copy.type).toBe('table');
    expect(copy.position).toBe(source.position + 1);
  });

  it('sets a new default and clears the old — exactly one default', async () => {
    const target = await addView('New default');
    expect(target.isDefault).toBe(false);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${vdb}/views/${target.id}/default`);
    expect(res.statusCode, res.body).toBe(201);

    const defaults = (await views()).filter((v) => v.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.id).toBe(target.id);
  });

  it('promotes another view to default when the default is deleted', async () => {
    const currentDefault = (await views()).find((v) => v.isDefault)!;
    const del = await inject('DELETE', `/workspaces/${wsId}/databases/${vdb}/views/${currentDefault.id}`);
    expect(del.statusCode).toBe(200);

    const after = await views();
    expect(after.some((v) => v.id === currentDefault.id)).toBe(false);
    expect(after.filter((v) => v.isDefault)).toHaveLength(1);
  });

  it('rename goes through the existing PATCH', async () => {
    const view = (await views())[0]!;
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${vdb}/views/${view.id}`, { name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect((await views()).find((v) => v.id === view.id)!.name).toBe('Renamed');
  });
});

/**
 * MN-258: nested and/or filter groups. #253's backend spike found `compileFilter`
 * and `checkFilterNames`/`cleanViewConfig` already recurse correctly, but with
 * ZERO test coverage — despite already shipping and being relied on by
 * calendar-view.tsx's nested date-window filter in production. `checkFilterNames`
 * lives as a private closure inside `ViewsService.validateConfig`, so it's only
 * reachable through the real endpoint — own database, so earlier blocks'
 * field/view churn can't affect these.
 */
describe('nested filter groups: checkFilterNames validates and/or recursively (MN-258)', () => {
  let ndb: string;
  let estimateId: string;
  let priorityId: string;
  let priorityOpts: Array<{ id: string; label: string }>;
  const EMPTY = { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {} };

  beforeAll(async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    ndb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'NestedFilters' })).json().id;
    estimateId = (
      await inject('POST', `/workspaces/${wsId}/databases/${ndb}/fields`, { display_name: 'Estimate', type: 'number' })
    ).json().id;
    const priority = (
      await inject('POST', `/workspaces/${wsId}/databases/${ndb}/fields`, {
        display_name: 'Priority',
        type: 'select',
        options: [{ label: 'Low' }, { label: 'High' }],
      })
    ).json();
    priorityId = priority.id;
    priorityOpts = priority.options;
  });

  it('rejects an unknown field 2 levels deep inside and/or nesting (checkFilterNames recurses)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${ndb}/views`, {
      name: 'Ghost nested',
      type: 'table',
      config: {
        ...EMPTY,
        filters: {
          and: [
            { field: 'estimate', op: 'gt', value: 0 },
            { or: [{ field: 'priority', op: 'has', value: [priorityOpts[0]!.id] }, { field: 'ghost', op: 'eq', value: 1 }] },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('accepts and round-trips a valid 3-level nested and/or filter unchanged', async () => {
    const filters = {
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ and: [{ field: 'priority', op: 'has', value: [priorityOpts[0]!.id] }] }, { field: 'priority', op: 'has', value: [priorityOpts[1]!.id] }] },
      ],
    };
    const created = await inject('POST', `/workspaces/${wsId}/databases/${ndb}/views`, {
      name: 'Valid nested',
      type: 'table',
      config: { ...EMPTY, filters },
    });
    expect(created.statusCode, created.body).toBe(201);

    const detail = await inject('GET', `/workspaces/${wsId}/databases/${ndb}`);
    const view = detail.json().views.find((v: { id: string }) => v.id === created.json().id);
    expect(view.config.filters).toEqual(filters);
  });

  it('cleanViewConfig drops a deleted field from inside a nested group at read time, collapsing the emptied group', async () => {
    const filters = {
      and: [
        { field: 'estimate', op: 'gt', value: 0 },
        { or: [{ field: 'priority', op: 'has', value: [priorityOpts[0]!.id] }] },
      ],
    };
    const created = await inject('POST', `/workspaces/${wsId}/databases/${ndb}/views`, {
      name: 'To be pruned',
      type: 'table',
      config: { ...EMPTY, filters },
    });
    expect(created.statusCode, created.body).toBe(201);

    await inject('DELETE', `/workspaces/${wsId}/databases/${ndb}/fields/${priorityId}`);

    const detail = await inject('GET', `/workspaces/${wsId}/databases/${ndb}`);
    const view = detail.json().views.find((v: { id: string }) => v.id === created.json().id);
    // The {or:[...]} group's only child referenced the deleted field — the whole
    // group disappears, leaving just the surviving top-level condition.
    expect(view.config.filters).toEqual({ and: [{ field: 'estimate', op: 'gt', value: 0 }] });
  });
});
