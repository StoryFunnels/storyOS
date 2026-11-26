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
import { createHmac } from 'node:crypto';
import { signDownloadUrl } from '../src/files/signed-download';
import { signAttachmentUrl } from '../src/attachments/signed-attachment';

/**
 * Ticket #51 — Meta publishing is OFF by default (META_ACTIONS_ENABLED unset: Meta's own App Review has not cleared). With the
 * switch off nothing can be saved or listed for it, and the catalog says a self-managed operator still has to configure the
 * app (no META_APP_ID/SECRET here), never a dead Connect button. post-social-meta.test.ts covers it on.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;

const as = (method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: (payload ?? {}) as never });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'Meta Gate Admin');
  wsId = (await as('POST', '/workspaces', { name: 'Meta gate WS' })).json().id;
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('Meta switched off', () => {
  it('self-managed with no operator app: the catalog says operator_config', async () => {
    const meta = ((await as('GET', `/workspaces/${wsId}/connections/providers`)).json().data as Array<{ id: string; availability: string; oauth?: { configured: boolean } }>).find((p) => p.id === 'meta')!;
    expect(meta.availability).toBe('operator_config');
    expect(meta.oauth!.configured).toBe(false);
  });

  it('starting the connect without the operator app is a clean 404, not a redirect to a dead dialog', async () => {
    expect((await as('GET', `/workspaces/${wsId}/connections/oauth/meta/start`)).statusCode).toBe(404);
  });

  it('a Meta post rule cannot be saved, and the picker refuses', async () => {
    const adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
    const [conn] = await db
      .insert(connections)
      .values({ workspaceId: wsId, provider: 'meta', name: 'meta', authSealed: seal(JSON.stringify({ user_token: 't', pages: [] })), status: 'active', createdBy: adminId })
      .returning();
    const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Posts ${randomUUID().slice(0, 6)}` })).json().id as string;
    for (const target of ['facebook_page', 'instagram_business']) {
      const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'meta off',
        trigger: { type: 'record_created' },
        actions: [{ type: 'post_social', text: 'hi', connection_id: conn!.id, target, account_id: '1001' }],
      });
      expect(res.statusCode, res.body).toBe(422);
      expect(res.body).toMatch(/not enabled on this deployment/);
    }
    const picker = await as('GET', `/workspaces/${wsId}/connections/${conn!.id}/social-accounts`);
    expect(picker.statusCode).toBe(422);
    expect(picker.body).toMatch(/not enabled/);
  });
});

describe('a signature from one signed-URL family never verifies as another', () => {
  it('a file-download signature is not an attachment signature (and the reverse)', () => {
    const id = randomUUID();
    const expires = String(Math.floor(Date.now() / 1000) + 600);
    expect(signAttachmentUrl(id, expires)).not.toBe(signDownloadUrl(id, expires));
    const bare = createHmac('sha256', 'x').update(`${id}:${expires}`).digest('hex');
    expect(signAttachmentUrl(id, expires)).not.toBe(bare);
  });
});
