import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections, user } from '../src/db/schema';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #60 — YouTube upload is OFF by default (YOUTUBE_ACTIONS_ENABLED unset: Google has not verified the app's sensitive
 * scopes). With the switch off nothing can be saved or listed for it, and the catalog says a self-managed operator still has to
 * configure the app (no YOUTUBE_CLIENT_ID/SECRET here), never a dead Connect button. post-social-youtube.test.ts covers it on.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;

const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: (payload ?? {}) as never });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'YT Gate Admin');
  wsId = (await as('POST', '/workspaces', { name: 'YT gate WS' })).json().id;
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('YouTube upload switched off', () => {
  it('self-managed with no operator app: the catalog says operator_config, not connectable and not cloud_only', async () => {
    const youtube = ((await as('GET', `/workspaces/${wsId}/connections/providers`)).json().data as Array<{ id: string; tier: string; availability: string; oauth?: { configured: boolean } }>).find((p) => p.id === 'youtube')!;
    expect(youtube.tier).toBe('oauth_managed');
    expect(youtube.availability).toBe('operator_config');
    expect(youtube.oauth!.configured).toBe(false);
  });

  it('starting the connect without the operator app is a clean 404, not a redirect to a dead consent screen', async () => {
    expect((await as('GET', `/workspaces/${wsId}/connections/oauth/youtube/start`)).statusCode).toBe(404);
  });

  it('an upload rule cannot be saved, and the picker refuses', async () => {
    const adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
    const [conn] = await db
      .insert(connections)
      .values({ workspaceId: wsId, provider: 'youtube', name: 'youtube', authSealed: seal(JSON.stringify({ access_token: 't' })), status: 'active', createdBy: adminId })
      .returning();
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Videos ${randomUUID().slice(0, 6)}` })).json().id as string;
    const video = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Cut', type: 'attachment', config: {} })).json() as { id: string };
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'youtube off',
      trigger: { type: 'record_created' },
      actions: [{ type: 'post_social', text: 'hi', connection_id: conn!.id, target: 'youtube_channel', account_id: 'UCabcdefghijklmnopqrstuv', video_field_id: video.id, title: 'T' }],
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/not enabled on this deployment/);
    const picker = await as('GET', `/workspaces/${wsId}/connections/${conn!.id}/social-accounts`);
    expect(picker.statusCode).toBe(422);
    expect(picker.body).toMatch(/not enabled/);
  });
});
