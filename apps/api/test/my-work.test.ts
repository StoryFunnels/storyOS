import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-072: My Work returns dense-row data — the database's renderable fields plus
 * each record's projected values (status/assignee/…), not just title + updated_at.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ownerId: string;
let ws: string;
let db: string;
let stateApi: string;
let assigneeApi: string;
/** The option the seeded record is actually set to — the only value `state` may hold. */
let toDoOptionId: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  ownerId = (await inject('GET', '/me')).json().id;
  ws = (await inject('POST', '/workspaces', { name: 'Work WS' })).json().id;
  const space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  db = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;

  const stateField = (
    await inject('POST', `/workspaces/${ws}/databases/${db}/fields`, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  stateApi = stateField.apiName;
  const toDo = stateField.options.find((o: { label: string }) => o.label === 'To Do').id;
  toDoOptionId = toDo;
  assigneeApi = (
    await inject('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Assignee', type: 'user' })
  ).json().apiName;

  await inject('POST', `/workspaces/${ws}/databases/${db}/records`, {
    values: { name: 'My task', [stateApi]: toDo, [assigneeApi]: ownerId },
  });
});

afterAll(async () => {
  await app.close();
});

describe('My Work dense data (MN-072)', () => {
  it('returns renderable fields + projected values for assigned records', async () => {
    const res = await inject('GET', `/workspaces/${ws}/my-work?tab=assigned`);
    expect(res.statusCode).toBe(200);
    const group = res.json().groups.find((g: { database: { id: string } }) => g.database.id === db);
    expect(group, 'the Tasks group is present').toBeTruthy();

    // Field metadata for dense rows, incl. select options.
    const stateFieldMeta = group.fields.find((f: { api_name: string }) => f.api_name === stateApi);
    expect(stateFieldMeta.type).toBe('select');
    expect(stateFieldMeta.options.map((o: { label: string }) => o.label)).toContain('To Do');
    expect(group.fields.some((f: { api_name: string }) => f.api_name === assigneeApi)).toBe(true);

    // Per-record projected values — status + assignee, not just the title.
    const rec = group.records[0];
    expect(rec.title).toBe('My task');
    // The file's premise is "projected VALUES, not just the title". `toBeTruthy()`
    // passed for the wrong option id, for `true`, or for a label instead of an id —
    // every bug this line exists to catch. The seeded record is To Do; say so.
    expect(rec.values[stateApi], 'the projected select value must be the To Do option id').toBe(toDoOptionId);
    expect(rec.values[assigneeApi]).toBe(ownerId);
  });
});
