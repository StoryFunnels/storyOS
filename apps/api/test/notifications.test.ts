import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let alice: { token: string; email: string };
let bob: { token: string; email: string };
let bobId: string;
let wsId: string;
let dbId: string;
let recId: string;
let assigneeApi: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  alice = await signUpUser(app, 'Alice');
  bob = await signUpUser(app, 'Bob');
  wsId = (await as(alice.token, 'POST', '/workspaces', { name: 'Notify WS' })).json().id;
  const invite = await as(alice.token, 'POST', `/workspaces/${wsId}/invites`, { email: bob.email, role: 'member' });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(bob.token, 'POST', '/invites/accept', { token });
  const members = (await as(alice.token, 'GET', `/workspaces/${wsId}/members`)).json();
  bobId = members.find((m: { user: { name: string } }) => m.user.name === 'Bob').user.id;

  const spaceId = (await as(alice.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(alice.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  const assignee = (await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Assignee', type: 'user', config: {},
  })).json();
  assigneeApi = assignee.apiName;
  recId = (await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Notify me' },
  })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('notifications (MN-049)', () => {
  it('assignment produces a notification for the added user, never the actor', async () => {
    await as(alice.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`, {
      values: { [assigneeApi]: bobId },
    });
    const bobCount = (await as(bob.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(bobCount.count).toBe(1);
    const aliceCount = (await as(alice.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(aliceCount.count).toBe(0);

    const list = (await as(bob.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(list.data[0].type).toBe('assigned');
    expect(list.data[0].record.title).toBe('Notify me');
    expect(list.data[0].actor.name).toBe('Alice');
  });

  it('mention + thread comment notify the right people', async () => {
    await as(alice.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'ping ' }, { type: 'mention', user_id: bobId }],
    });
    const list = (await as(bob.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(list.data.some((n: { type: string }) => n.type === 'mentioned')).toBe(true);

    // Bob replies — Alice (record creator + commenter) gets "commented".
    await as(bob.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'pong' }],
    });
    const aliceList = (await as(alice.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    expect(aliceList.data.some((n: { type: string }) => n.type === 'commented')).toBe(true);
  });

  it('mark read + read-all work; my-work lists assigned records', async () => {
    const list = (await as(bob.token, 'GET', `/workspaces/${wsId}/notifications`)).json();
    await as(bob.token, 'POST', `/workspaces/${wsId}/notifications/${list.data[0].id}/read`);
    await as(bob.token, 'POST', `/workspaces/${wsId}/notifications/read-all`);
    const after = (await as(bob.token, 'GET', `/workspaces/${wsId}/notifications/unread-count`)).json();
    expect(after.count).toBe(0);

    const myWork = (await as(bob.token, 'GET', `/workspaces/${wsId}/my-work`)).json();
    expect(myWork.groups).toHaveLength(1);
    expect(myWork.groups[0].records[0].title).toBe('Notify me');
    const aliceWork = (await as(alice.token, 'GET', `/workspaces/${wsId}/my-work`)).json();
    expect(aliceWork.groups).toHaveLength(0);
  });
});
