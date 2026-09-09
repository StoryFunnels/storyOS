import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { memberships, notifications } from '../src/db/schema';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #293 — publishing OUT of Personal, and forking back IN.
 *
 * personal-space.md's rule: publishing is a ONE-WAY move (spaceId re-point for a
 * document, ownerUserId clear for a view); coming back is "Copy to My Space", an
 * independent fork with no sync. This file is the positive half of that promise —
 * personal-space.test.ts already covers the negative "never notify while personal"
 * invariant, which this suite must not disturb (it never calls move/publish there).
 */
let app: NestFastifyApplication;
let db: Db;
let owner: { token: string };
let ownerId: string;
let mentioned: { token: string };
let mentionedId: string;
let wsId: string;
let sharedSpaceA: string;
let sharedSpaceB: string;
let sharedDb: string;
let personalSpaceId: string;

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
  db = app.get(DB);

  owner = await signUpUser(app, 'PublishOwner');
  mentioned = await signUpUser(app, 'PublishMentioned');
  ownerId = (await as(owner.token, 'GET', '/me')).json().id;
  mentionedId = (await as(mentioned.token, 'GET', '/me')).json().id;

  wsId = (await as(owner.token, 'POST', '/workspaces', { name: 'Publish WS' })).json().id;
  await db.insert(memberships).values({ workspaceId: wsId, userId: mentionedId, role: 'member' });

  sharedSpaceA = (await as(owner.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  sharedSpaceB = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Second shared space' })
  ).json().id;
  sharedDb = (
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: sharedSpaceA, name: 'Tasks' })
  ).json().id;

  personalSpaceId = (await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/personal`)).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#293 — move a document out of Personal', () => {
  it('publishes a personal document into a shared space, and notifies a user it mentions for the first time', async () => {
    const created = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/${personalSpaceId}/documents`, {
      title: 'Draft that mentions someone',
    });
    expect(created.statusCode, created.body).toBe(201);
    const docId = created.json().id;

    await as(owner.token, 'PATCH', `/workspaces/${wsId}/documents/${docId}`, {
      expected_version: created.json().version ?? 0,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'cc ', styles: {} },
            { type: 'mention', props: { kind: 'user', id: mentionedId, label: 'PublishMentioned' } },
          ],
        },
      ],
    });

    const before = await db.query.notifications.findMany({ where: eq(notifications.workspaceId, wsId) });

    const moved = await as(owner.token, 'POST', `/workspaces/${wsId}/documents/${docId}/move`, {
      space_id: sharedSpaceA,
    });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json().space_id ?? moved.json().spaceId).toBe(sharedSpaceA);

    const after = await db.query.notifications.findMany({ where: eq(notifications.workspaceId, wsId) });
    expect(after.length, 'the move must notify the mentioned user for the first time').toBe(before.length + 1);
    const created_notif = after.find((n) => !before.some((b) => b.id === n.id))!;
    expect(created_notif.userId).toBe(mentionedId);
    expect(created_notif.type).toBe('mentioned');
  });

  it('moving a document between two already-shared spaces does not notify again', async () => {
    // The document from the previous test, already in sharedSpaceA and already
    // mentioning `mentioned` — mentions were surfaced once, at the personal->shared
    // move. A second, shared->shared move must not re-fire.
    const docs = (
      await as(owner.token, 'GET', `/workspaces/${wsId}/spaces/${sharedSpaceA}/documents`)
    ).json().data as Array<{ id: string; title: string }>;
    const docId = docs.find((d) => d.title === 'Draft that mentions someone')!.id;

    const before = await db.query.notifications.findMany({ where: eq(notifications.workspaceId, wsId) });
    const moved = await as(owner.token, 'POST', `/workspaces/${wsId}/documents/${docId}/move`, {
      space_id: sharedSpaceB,
    });
    expect(moved.statusCode, moved.body).toBe(201);
    const after = await db.query.notifications.findMany({ where: eq(notifications.workspaceId, wsId) });
    expect(after.length).toBe(before.length);
  });

  it('rejects a personal space as the move target', async () => {
    const created = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/${personalSpaceId}/documents`, {
      title: 'Should stay personal',
    });
    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/documents/${created.json().id}/move`, {
      space_id: personalSpaceId,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('#293 — copy a document into my personal space (fork, not sync)', () => {
  it('creates an independent copy; editing one afterward never touches the other', async () => {
    const original = await as(owner.token, 'POST', `/workspaces/${wsId}/spaces/${sharedSpaceA}/documents`, {
      title: 'Shared page to fork',
    });
    const originalId = original.json().id;

    const copyRes = await as(owner.token, 'POST', `/workspaces/${wsId}/documents/${originalId}/copy-to-personal`);
    expect(copyRes.statusCode, copyRes.body).toBe(201);
    const copy = copyRes.json();
    expect(copy.id).not.toBe(originalId);
    expect(copy.space_id ?? copy.spaceId).toBe(personalSpaceId);
    expect(copy.title).toBe('Shared page to fork');

    await as(owner.token, 'PATCH', `/workspaces/${wsId}/documents/${originalId}`, { title: 'Renamed original' });
    await as(owner.token, 'PATCH', `/workspaces/${wsId}/documents/${copy.id}`, { title: 'Renamed copy' });

    const originalAfter = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${originalId}`);
    const copyAfter = await as(owner.token, 'GET', `/workspaces/${wsId}/documents/${copy.id}`);
    expect(originalAfter.json().title).toBe('Renamed original');
    expect(copyAfter.json().title).toBe('Renamed copy');
  });
});

describe('#293 — publish a personal view', () => {
  it("clears ownerUserId — the view becomes visible to a workspace member who wasn't its owner", async () => {
    const created = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'My lens to publish',
      type: 'table',
      config: {},
    });
    const viewId = created.json().id;

    const before = await as(mentioned.token, 'GET', `/workspaces/${wsId}/spaces/${sharedSpaceA}/views`);
    expect((before.json().data as Array<{ name: string }>).map((v) => v.name)).not.toContain('My lens to publish');

    const published = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/publish`);
    expect(published.statusCode, published.body).toBe(201);
    expect(published.json().owner_user_id ?? published.json().ownerUserId).toBeFalsy();

    const after = await as(mentioned.token, 'GET', `/workspaces/${wsId}/spaces/${sharedSpaceA}/views`);
    expect((after.json().data as Array<{ name: string }>).map((v) => v.name)).toContain('My lens to publish');
  });

  it('refuses to publish an already-shared view', async () => {
    const created = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Already shared attempt',
      type: 'table',
      config: {},
    });
    const viewId = created.json().id;
    await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/publish`);

    const res = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/publish`);
    expect(res.statusCode).toBe(422);
  });
});

describe('#293 — copy a shared view into my personal space (fork, not sync)', () => {
  it('creates an independent personal copy of a shared view', async () => {
    const shared = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views`, {
      name: 'Shared view to fork',
      type: 'table',
      config: {},
    });
    const sharedViewId = shared.json().id;

    const copyRes = await as(
      owner.token,
      'POST',
      `/workspaces/${wsId}/databases/${sharedDb}/views/${sharedViewId}/copy-to-personal`,
    );
    expect(copyRes.statusCode, copyRes.body).toBe(201);
    const copy = copyRes.json();
    expect(copy.id).not.toBe(sharedViewId);
    expect(copy.owner_user_id ?? copy.ownerUserId).toBeTruthy();
    expect(copy.database_id ?? copy.databaseId).toBe(sharedDb);

    const mine = await as(owner.token, 'GET', `/workspaces/${wsId}/views/personal`);
    expect((mine.json().data as Array<{ name: string }>).map((v) => v.name)).toContain('Shared view to fork copy');
  });
});
