import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-205: a #record mention written in a record's document creates a backlink
 * ("Mentioned in") on the target, and an @member mention notifies that member.
 * Backlinks are permission-scoped — a guest can't learn a title it can't see.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let member: { token: string; email: string };
let memberId: string;
let ws: string;
let tasksSpace: string;
let tasks: string;
let projectsDb: string;
let source: string; // a Task whose document mentions the target
let target: string; // a Project that gets mentioned

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

async function putDoc(rec: string, content: unknown, version: number, token?: string) {
  return inject(
    'PUT',
    `/workspaces/${ws}/databases/${tasks}/records/${rec}/document`,
    { content, expected_version: version },
    token,
  );
}

const mentionDoc = (recordId: string, userId: string) => [
  {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'see ', styles: {} },
      { type: 'mention', props: { kind: 'record', id: recordId, label: 'Target Project' } },
      { type: 'text', text: ' cc ', styles: {} },
      { type: 'mention', props: { kind: 'user', id: userId, label: 'Casey' } },
    ],
  },
];

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Owner');
  member = await signUpUser(app, 'Casey');
  memberId = (await inject('GET', '/me', undefined, member.token)).json().id;

  ws = (await inject('POST', '/workspaces', { name: 'Mentions WS' })).json().id;
  // add Casey as a full member
  const invite = await inject('POST', `/workspaces/${ws}/invites`, { email: member.email, role: 'member' });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  await inject('POST', '/invites/accept', { token: inviteToken }, member.token);

  tasksSpace = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  tasks = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: tasksSpace, name: 'Tasks' })).json().id;
  projectsDb = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: tasksSpace, name: 'Projects' })).json().id;
  source = (await inject('POST', `/workspaces/${ws}/databases/${tasks}/records`, { values: {} })).json().id;
  target = (await inject('POST', `/workspaces/${ws}/databases/${projectsDb}/records`, { values: {} })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('record mentions & backlinks (MN-205)', () => {
  it('a #mention in a document creates a backlink on the target', async () => {
    expect((await putDoc(source, mentionDoc(target, memberId), 0)).statusCode).toBe(200);

    const backlinks = await inject(
      'GET',
      `/workspaces/${ws}/databases/${projectsDb}/records/${target}/backlinks`,
    );
    expect(backlinks.statusCode).toBe(200);
    expect(backlinks.json().data.map((r: { id: string }) => r.id)).toContain(source);
  });

  it('notifies the @mentioned member', async () => {
    const notifs = await inject('GET', `/workspaces/${ws}/notifications`, undefined, member.token);
    expect(notifs.statusCode).toBe(200);
    /**
     * The callback used to declare `record_id` / `recordId` and check neither —
     * and neither exists: a notification carries a nested `record: { id }`. So the
     * scoping the shape implied never happened, and *any* 'mentioned' row from any
     * record in this shared workspace satisfied it. Scope it to the source record.
     */
    const list = notifs.json().data as Array<{ type: string; record: { id: string } }>;
    expect(
      list.some((n) => n.type === 'mentioned' && n.record.id === source),
      'the mention on the source record must notify Casey',
    ).toBe(true);
  });

  it('removing the #mention drops the backlink', async () => {
    // version is now 1 after the first save
    expect((await putDoc(source, [{ type: 'paragraph', content: [] }], 1)).statusCode).toBe(200);
    const backlinks = await inject(
      'GET',
      `/workspaces/${ws}/databases/${projectsDb}/records/${target}/backlinks`,
    );
    expect(backlinks.json().data.map((r: { id: string }) => r.id)).not.toContain(source);
  });

  it('does not mention itself even if a record links to its own id', async () => {
    // re-add the mention for the following guest test, and prove self-mention is ignored
    const selfDoc = [
      {
        type: 'paragraph',
        content: [{ type: 'mention', props: { kind: 'record', id: source, label: 'self' } }],
      },
    ];
    expect((await putDoc(source, selfDoc, 2)).statusCode).toBe(200);
    const backlinks = await inject(
      'GET',
      `/workspaces/${ws}/databases/${tasks}/records/${source}/backlinks`,
    );
    expect(backlinks.json().data.map((r: { id: string }) => r.id)).not.toContain(source);
  });
});

describe('backlinks are permission-scoped (MN-205)', () => {
  it("a guest without access to the source's database sees no backlink to it", async () => {
    // restore the target mention from source
    await putDoc(source, mentionDoc(target, memberId), 3);

    // guest granted only on the Projects database (not Tasks where `source` lives)
    const guest = await signUpUser(app, 'Guestie');
    const invite = await inject('POST', `/workspaces/${ws}/invites`, {
      email: guest.email,
      role: 'guest',
      grants: [{ database_id: projectsDb, role: 'viewer' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await inject('POST', '/invites/accept', { token }, guest.token);

    const backlinks = await inject(
      'GET',
      `/workspaces/${ws}/databases/${projectsDb}/records/${target}/backlinks`,
      undefined,
      guest.token,
    );
    expect(backlinks.statusCode).toBe(200);
    // the source lives in Tasks, which the guest cannot see → filtered out
    expect(backlinks.json().data.map((r: { id: string }) => r.id)).not.toContain(source);
  });
});
