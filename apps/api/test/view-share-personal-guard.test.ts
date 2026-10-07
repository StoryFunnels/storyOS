import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { memberships, views } from '../src/db/schema';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #554 — ViewsService.share()/unshare() had no `ownerUserId` check at all: any
 * member with ordinary editor access to a database could publish ANOTHER
 * member's personal view to a fully anonymous public URL, without the
 * owner's knowledge or consent. Fix (b), chosen and recorded here: a personal
 * view (ownerUserId set) can NEVER be published by ANYONE, including its own
 * owner — personal space's whole premise is invisibility to everyone else,
 * and a public URL is a categorically stronger exposure than "visible only
 * to me". `unshare()` is deliberately NOT gated the same way — revoking only
 * removes exposure, and a view published before this fix (or by a future
 * bug) must stay revocable through the normal API.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string };
let owner: { token: string };
let other: { token: string };
let wsId: string;
let spaceId: string;
let sharedDb: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'ShareGuardAdmin');
  owner = await signUpUser(app, 'ShareGuardOwner');
  other = await signUpUser(app, 'ShareGuardOther');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '554 WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  sharedDb = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Shared Tasks' })
  ).json().id;

  // Both owner and other are ordinary members — plain editor access to every
  // workspace database, exactly the "editor access to the shared database,
  // but not the view's owner" caller the ticket describes.
  await db.insert(memberships).values({ workspaceId: wsId, userId: (await as(owner.token, 'GET', '/me')).json().id, role: 'member' });
  await db.insert(memberships).values({ workspaceId: wsId, userId: (await as(other.token, 'GET', '/me')).json().id, role: 'member' });
});

afterAll(async () => {
  await app.close();
});

describe('#554 — a personal view can never be published, by anyone', () => {
  it('reproduces the finding: a non-owning editor cannot share ANOTHER member\'s personal view — refused, not silently succeeding', async () => {
    const personal = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Owner\'s private lens',
      type: 'table',
      config: {},
    });
    expect(personal.statusCode, personal.body).toBe(201);
    const viewId = personal.json().id;

    // The exact reproduction from the ticket's AC #1, now against the FIXED code.
    const shareAsOther = await as(other.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/share`, {});
    expect(shareAsOther.statusCode, shareAsOther.body).toBe(404);
    expect(shareAsOther.json().token).toBeUndefined();
  });

  it('MUST KEEP REFUSING: even the view\'s OWN owner cannot share their own personal view (fix (b) is unconditional)', async () => {
    const personal = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Owner tries to publish their own',
      type: 'table',
      config: {},
    });
    const viewId = personal.json().id;

    const shareAsOwner = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/share`, {});
    expect(shareAsOwner.statusCode, shareAsOwner.body).toBe(404);
  });

  it('unshare() on another member\'s personal view still succeeds (no-op) — deliberately NOT gated like share(), since revoking only removes exposure', async () => {
    const personal = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Owner\'s lens, unshare attempt',
      type: 'table',
      config: {},
    });
    const viewId = personal.json().id;

    const unshareAsOther = await as(other.token, 'DELETE', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/share`);
    expect(unshareAsOther.statusCode, unshareAsOther.body).toBeLessThan(300);
  });

  it('rollout safety net: a personal view already published (pre-fix data, or a future bug) can still be revoked via the normal API', async () => {
    const personal = await as(owner.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/personal`, {
      name: 'Already-leaked personal view',
      type: 'table',
      config: {},
    });
    const viewId = personal.json().id;

    // Simulate the pre-fix state directly — a token that got minted before
    // this guard existed. share() itself is now refused, so this is written
    // straight to the row, exactly the state a production rollout audit
    // (ticket AC #6) would find and need to clean up.
    await db.update(views).set({ config: { share: { public_token: 'leaked-token-abc', include_relation_api_names: [], indexable: false } } }).where(eq(views.id, viewId));

    const unshare = await as(other.token, 'DELETE', `/workspaces/${wsId}/databases/${sharedDb}/views/${viewId}/share`);
    expect(unshare.statusCode, unshare.body).toBeLessThan(300);

    const row = await db.query.views.findFirst({ where: eq(views.id, viewId) });
    expect((row?.config as { share?: unknown } | null)?.share).toBeUndefined();
  });

  it('MUST KEEP WORKING: an ordinary (non-personal) shared view still publishes normally for any editor', async () => {
    const dbDetail = await (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${sharedDb}`)).json();
    const ordinaryViewId = dbDetail.views[0].id;

    const share = await as(other.token, 'POST', `/workspaces/${wsId}/databases/${sharedDb}/views/${ordinaryViewId}/share`, {});
    expect(share.statusCode, share.body).toBeLessThan(300);
    expect(share.json().token).toBeTruthy();

    const unshare = await as(other.token, 'DELETE', `/workspaces/${wsId}/databases/${sharedDb}/views/${ordinaryViewId}/share`);
    expect(unshare.statusCode, unshare.body).toBeLessThan(300);
  });
});
