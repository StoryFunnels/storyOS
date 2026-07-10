import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let tasksId: string;
let logsId: string;
let recId: string;
let buttonId: string;
let stateApi: string;
let doneId: string;
let logRelationFieldId: string; // relation field on Logs pointing at Tasks

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Presser');
  wsId = (await inject('POST', '/workspaces', { name: 'Buttons WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  tasksId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  logsId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Logs' })).json().id;

  const state = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
    display_name: 'State', type: 'select', config: {}, options: [{ label: 'Open' }, { label: 'Done' }],
  })).json();
  stateApi = state.apiName;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;

  const relation = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: logsId, database_b_id: tasksId, cardinality: 'one_to_many', field_a_name: 'Task',
  })).json();
  logRelationFieldId = relation.field_a.id;

  recId = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records`, {
    values: { name: 'Approve me' },
  })).json().id;

  const button = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
    display_name: 'Approve',
    type: 'button',
    config: {
      color: 'green',
      actions: [
        { type: 'set_values', values: { [stateApi]: doneId } },
        { type: 'create_record', database_id: logsId, values: { name: 'Approved: {Title}' }, link_via_relation_field_id: logRelationFieldId },
        { type: 'add_comment', body_template: 'Approved by the button ({Title})' },
      ],
    },
  });
  expect(button.statusCode, button.body).toBe(201);
  buttonId = button.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('button fields (MN-046)', () => {
  it('rejects writes to button values and invalid configs', async () => {
    const write = await inject('PATCH', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}`, {
      values: { approve: true },
    });
    expect(write.statusCode).toBe(422);

    const bad = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Broken', type: 'button', config: { actions: [] },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('press executes all actions as the presser', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}/buttons/${buttonId}/press`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().effects).toHaveLength(3);

    const rec = (await inject('GET', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}`)).json();
    expect(rec.values[stateApi]).toBe(doneId);

    const logs = (await inject('GET', `/workspaces/${wsId}/databases/${logsId}/records`)).json();
    expect(logs.data[0].title).toBe('Approved: Approve me');
    expect(logs.data[0].values.task[0].id).toBe(recId);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}/comments`)).json();
    expect(comments.data[0].body[0].text).toContain('Approved by the button (Approve me)');
  });

  it('stale configs 422 at press instead of 500', async () => {
    // Point a new button at a field, then delete the field.
    const doomed = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Doomed target', type: 'number', config: {},
    })).json();
    const staleBtn = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Stale', type: 'button',
      config: { actions: [{ type: 'set_values', values: { [doomed.apiName]: 1 } }] },
    })).json();
    await inject('DELETE', `/workspaces/${wsId}/databases/${tasksId}/fields/${doomed.id}`);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}/buttons/${staleBtn.id}/press`);
    expect(res.statusCode).toBe(422);
  });

  it('update_linked action updates the records linked through a relation (MN-080)', async () => {
    // Note field on Logs; the Tasks-side relation field to Logs.
    const note = (await inject('POST', `/workspaces/${wsId}/databases/${logsId}/fields`, {
      display_name: 'Note', type: 'text', config: {},
    })).json();
    const tasksDetail = (await inject('GET', `/workspaces/${wsId}/databases/${tasksId}`)).json();
    const tasksToLogs = tasksDetail.fields.find((f: { type: string }) => f.type === 'relation');

    // a fresh task linked to a fresh log
    const task2 = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records`, { values: { name: 'Parent' } })).json().id;
    const log2 = (await inject('POST', `/workspaces/${wsId}/databases/${logsId}/records`, { values: { name: 'Child log' } })).json().id;
    await inject('PUT', `/workspaces/${wsId}/databases/${tasksId}/records/${task2}/links/${tasksToLogs.id}`, { record_ids: [log2] });

    const btn = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Touch logs', type: 'button',
      config: { actions: [{ type: 'update_linked', relation_field_id: tasksToLogs.id, values: { [note.apiName]: 'touched by rule' } }] },
    })).json();
    const press = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records/${task2}/buttons/${btn.id}/press`);
    expect(press.statusCode, press.body).toBe(201);
    expect(press.json().effects[0].summary).toContain('1 linked');

    const linkedLog = (await inject('GET', `/workspaces/${wsId}/databases/${logsId}/records/${log2}`)).json();
    expect(linkedLog.values[note.apiName]).toBe('touched by rule');
  });

  it('notify_user: @me runs, a non-person target is rejected at press (MN-080)', async () => {
    // @me notify (to self) — filtered to no recipients, still succeeds.
    const selfBtn = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Self notify', type: 'button',
      config: { actions: [{ type: 'notify_user', user: '@me', message: 'note to self ({Title})' }] },
    })).json();
    const okPress = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}/buttons/${selfBtn.id}/press`);
    expect(okPress.statusCode, okPress.body).toBe(201);
    expect(okPress.json().effects[0].type).toBe('notify_user');

    // notify targeting a non-person field is rejected at press (reference validation).
    const badBtn = (await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/fields`, {
      display_name: 'Bad notify', type: 'button',
      config: { actions: [{ type: 'notify_user', user: stateApi, message: 'hi' }] },
    })).json();
    const badPress = await inject('POST', `/workspaces/${wsId}/databases/${tasksId}/records/${recId}/buttons/${badBtn.id}/press`);
    expect(badPress.statusCode).toBe(422);
  });
});
