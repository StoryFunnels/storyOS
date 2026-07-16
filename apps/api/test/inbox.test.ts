import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-073: the inbox gains archive + a type filter, and a select (status/priority)
 * change on a record pings its assignees with a `state_changed` notification.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let member: { token: string; email: string };
let memberId: string;
let ws: string;
let db: string;
let stateApi: string;
let assigneeApi: string;
let toDo: string;
let done: string;
let rec: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

const notifs = async (query = '') =>
  (await inject('GET', `/workspaces/${ws}/notifications${query}`, undefined, member.token)).json().data as Array<{
    id: string;
    type: string;
  }>;

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  member = await signUpUser(app, 'Casey');
  memberId = (await inject('GET', '/me', undefined, member.token)).json().id;

  ws = (await inject('POST', '/workspaces', { name: 'Inbox WS' })).json().id;
  const invite = await inject('POST', `/workspaces/${ws}/invites`, { email: member.email, role: 'member' });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await inject('POST', '/invites/accept', { token }, member.token);

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
  toDo = stateField.options.find((o: { label: string }) => o.label === 'To Do').id;
  done = stateField.options.find((o: { label: string }) => o.label === 'Done').id;

  assigneeApi = (
    await inject('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Assignee', type: 'user' })
  ).json().apiName;

  rec = (
    await inject('POST', `/workspaces/${ws}/databases/${db}/records`, {
      values: { [stateApi]: toDo, [assigneeApi]: memberId },
    })
  ).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('state-change notifications (MN-073)', () => {
  it('a select change pings the assignee with state_changed', async () => {
    const res = await inject('PATCH', `/workspaces/${ws}/databases/${db}/records/${rec}`, {
      values: { [stateApi]: done },
    });
    expect(res.statusCode).toBe(200);

    const list = await notifs();
    expect(list.some((n) => n.type === 'state_changed')).toBe(true);
  });

  it('filters by type', async () => {
    const list = await notifs('?type=state_changed');
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((n) => n.type === 'state_changed')).toBe(true);
  });
});

describe('archive (MN-073)', () => {
  it('archiving hides it from the default inbox but keeps it in the archived view', async () => {
    const target = (await notifs()).find((n) => n.type === 'state_changed')!;
    expect(target).toBeTruthy();

    const arch = await inject('POST', `/workspaces/${ws}/notifications/${target.id}/archive`, {}, member.token);
    expect(arch.statusCode).toBe(201);

    expect((await notifs()).some((n) => n.id === target.id)).toBe(false);
    expect((await notifs('?archived=true')).some((n) => n.id === target.id)).toBe(true);
  });

  it('unarchive restores it to the inbox', async () => {
    const archived = (await notifs('?archived=true')).find((n) => n.type === 'state_changed')!;
    await inject('POST', `/workspaces/${ws}/notifications/${archived.id}/unarchive`, {}, member.token);
    expect((await notifs()).some((n) => n.id === archived.id)).toBe(true);
  });
});
