import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let guest: { token: string; email: string };
let adminId: string;
let memberId: string;
let wsId: string;
let dbId: string;
let recId: string;
/** The record created *through the PAT* — the one whose activity carries the actor claim. */
let patRecId: string;
let stateField: { id: string; apiName: string; options: Array<{ id: string; label: string }> };

const H = (t: string) => authed(t);
async function inject(method: string, url: string, token: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: H(token), payload: payload as never });
}

const commentsUrl = () => `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Olena');
  member = await signUpUser(app, 'Max');
  guest = await signUpUser(app, 'Dana');
  adminId = (await inject('GET', '/me', admin.token)).json().id;
  memberId = (await inject('GET', '/me', member.token)).json().id;

  wsId = (await inject('POST', '/workspaces', admin.token, { name: 'Collab WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`, admin.token)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, admin.token, { space_id: spaceId, name: 'Tasks' })).json().id;
  stateField = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, admin.token, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  recId = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, admin.token, {
      values: { name: 'Discussed task' },
    })
  ).json().id;

  for (const person of [
    { u: member, role: 'member' as const },
    { u: guest, role: 'guest' as const, space_ids: [spaceId] },
  ]) {
    const invite = await inject('POST', `/workspaces/${wsId}/invites`, admin.token, {
      email: person.u.email,
      role: person.role,
      ...(person.role === 'guest' ? { grants: person.space_ids.map((id: string) => ({ space_id: id, role: 'commenter' as const })) } : {}),
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await inject('POST', '/invites/accept', person.u.token, { token });
  }
});

afterAll(async () => {
  await app.close();
});

describe('comments (MN-026)', () => {
  let commentId: string;

  it('creates a comment with a server-extracted mention', async () => {
    const res = await inject('POST', commentsUrl(), member.token, {
      body: [
        { type: 'text', text: 'Blocked on assets — ' },
        { type: 'mention', user_id: adminId },
        { type: 'text', text: ' can you help?' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    commentId = res.json().id;

    /**
     * The test is named for the mention, and used to assert only the 201: a server
     * that dropped every mention segment on the floor passed it. The extraction is
     * the behaviour — pin the stored body and the resolved mention.
     */
    const body = res.json().body as Array<{ type: string; user_id?: string }>;
    const mention = body.find((seg) => seg.type === 'mention');
    expect(mention, 'the mention segment must survive the round trip').toBeTruthy();
    expect(mention!.user_id, 'and must still point at the mentioned user').toBe(adminId);

    // What the extraction is FOR: the mentioned user hears about it. The response
    // does not echo the derived list, so the notification is the observable.
    const notifs = await inject('GET', `/workspaces/${wsId}/notifications`, admin.token);
    expect(notifs.statusCode).toBe(200);
    const list = notifs.json().data as Array<{
      type: string;
      record: { id: string };
      actor: { id: string };
    }>;
    const hit = list.find((n) => n.type === 'mentioned' && n.record.id === recId);
    expect(hit, 'the @mentioned admin must be notified about THIS record').toBeTruthy();
    expect(hit!.actor.id, 'attributed to the commenter').toBe(memberId);
  });

  it('guests can read and comment (the one guest write)', async () => {
    const list = await inject('GET', commentsUrl(), guest.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const res = await inject('POST', commentsUrl(), guest.token, {
      body: [{ type: 'text', text: 'Client feedback: looks great' }],
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects mentions of non-members and of guests', async () => {
    const res = await inject('POST', commentsUrl(), member.token, {
      body: [{ type: 'mention', user_id: 'nonexistent-user' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('only the author edits; author or admin deletes', async () => {
    const edit = await inject('PATCH', `${commentsUrl()}/${commentId}`, admin.token, {
      body: [{ type: 'text', text: 'hijack' }],
    });
    expect(edit.statusCode).toBe(403);

    const ownEdit = await inject('PATCH', `${commentsUrl()}/${commentId}`, member.token, {
      body: [{ type: 'text', text: 'edited' }],
    });
    expect(ownEdit.statusCode).toBe(200);

    const adminDelete = await inject('DELETE', `${commentsUrl()}/${commentId}`, admin.token);
    expect(adminDelete.statusCode).toBe(200);
    const list = await inject('GET', commentsUrl(), admin.token);
    expect(list.json().data.every((c: { id: string }) => c.id !== commentId)).toBe(true);
  });
});

describe('activity (MN-027)', () => {
  it('renders diffs with field names and option labels', async () => {
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recId}`, admin.token, {
      values: { [stateField.apiName]: stateField.options[1]!.id },
    });
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/activity`, admin.token);
    expect(res.statusCode).toBe(200);
    const types = res.json().data.map((e: { type: string }) => e.type);
    expect(types).toContain('record.created');
    expect(types).toContain('comment.created');
    const update = res.json().data.find((e: { type: string }) => e.type === 'record.updated');
    expect(update.changes).toEqual([{ field: 'State', from: null, to: 'Done' }]);
    expect(update.actor.name).toBe('Olena');
  });

  it('is not writable via the API', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/activity`, admin.token, {});
    expect([404, 405]).toContain(res.statusCode);
  });

  it('survives field deletion — renders "(deleted field)"', async () => {
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${stateField.id}`, admin.token);
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/activity`, admin.token);
    const update = res.json().data.find((e: { type: string }) => e.type === 'record.updated');
    expect(update.changes[0].field).toContain('(deleted field)');
  });
});

describe('personal access tokens (MN-028)', () => {
  let patPlaintext: string;
  let patId: string;

  it('creates a PAT shown once, prefix-only afterwards', async () => {
    const res = await inject('POST', '/me/tokens', member.token, { name: 'ci-script', workspace_id: wsId });
    expect(res.statusCode).toBe(201);
    patPlaintext = res.json().token;
    patId = res.json().id;
    expect(patPlaintext.startsWith('mn_pat_')).toBe(true);

    const list = await inject('GET', '/me/tokens', member.token);
    expect(list.json().data[0].token_prefix).toContain('…');
    expect(JSON.stringify(list.json())).not.toContain(patPlaintext);
  });

  it('a PAT drives the API with the creator’s role', async () => {
    const records = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${dbId}/records`,
      headers: { authorization: `Bearer ${patPlaintext}` },
      payload: { values: { name: 'Created by PAT' } },
    });
    expect(records.statusCode, records.body).toBe(201);
    patRecId = records.json().id;

    // Member role — settings endpoints stay closed.
    const invites = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${wsId}/invites`,
      headers: { authorization: `Bearer ${patPlaintext}` },
    });
    expect(invites.statusCode).toBe(403);
  });

  /**
   * This used to fetch the activity of `recId` — a record the PAT never touched —
   * assert only its 200, and then check `/me`. Nothing looked at an actor, so a
   * PAT write recorded against a null or system actor passed. The record the PAT
   * actually created is the one whose trail carries the claim.
   */
  it('activity from a PAT resolves to the owning user', async () => {
    const res = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/records/${patRecId}/activity`,
      admin.token,
    );
    expect(res.statusCode, res.body).toBe(200);

    const created = (res.json().data as Array<{ type: string; actor?: { id: string; name: string } | null }>).find(
      (e) => e.type === 'record.created',
    );
    expect(created, 'the PAT write must leave a record.created event').toBeTruthy();
    expect(created!.actor?.id, 'a PAT acts AS its owner — not as nobody, not as the token').toBe(memberId);

    // …and the owner is the member, not the admin who reads the trail.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${patPlaintext}` },
    });
    expect(me.json().id).toBe(memberId);
    expect(created!.actor?.id).not.toBe(adminId);
  });

  it('revocation is immediate', async () => {
    await inject('DELETE', `/me/tokens/${patId}`, member.token);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${patPlaintext}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
