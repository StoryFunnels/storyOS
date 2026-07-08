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
