import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automations, connections, user } from '../src/db/schema';
import { SocialAccountsService } from '../src/connections/social-accounts.service';
import { SOCIAL_COMMAND_CENTER_PACK } from '../src/packs/social-command-center';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #456 - while LinkedIn posting is NOT switched on for the deployment (the test environment leaves LINKEDIN_ACTIONS_ENABLED off, as
 * production does until LinkedIn's app review clears), the guided flow must say so and refuse, and X must keep working.
 *
 * The flag is read once per process, so this lives in its own file: publishing-setup.test.ts switches it on.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let postsDb: string;
const lookups: string[] = [];

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: (payload ?? {}) as never });
async function connection(provider: 'x' | 'linkedin') {
  const [row] = await db
    .insert(connections)
    .values({ workspaceId: wsId, provider, name: `${provider} ${randomUUID().slice(0, 6)}`, authSealed: seal(JSON.stringify({ access_token: 'fake-token-not-real' })), status: 'active', createdBy: adminId })
    .returning();
  return row!.id;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  app.get(SocialAccountsService).fetcher = (async (url: string) => {
    lookups.push(String(url));
    return { status: 200, json: async () => ({ data: { id: '777', name: 'Acme', username: 'acme_fake' } }), text: async () => '' };
  }) as never;
  admin = await signUpUser(app, 'Flag Off Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as('POST', '/workspaces', { name: 'Flag Off WS' })).json().id;
  expect((await as('POST', `/workspaces/${wsId}/packs/install`, { manifest: SOCIAL_COMMAND_CENTER_PACK.manifest })).statusCode).toBeLessThan(300);
  postsDb = ((await as('GET', `/workspaces/${wsId}/databases`)).json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Posts')!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('LinkedIn posting is not switched on for this deployment', () => {
  it('the read says so per channel, so the card can disable the step with the right sentence', async () => {
    const res = await as('GET', `/workspaces/${wsId}/databases/${postsDb}/publishing`);
    const channels = res.json().channels as Array<{ provider: string; posting_enabled: boolean }>;
    expect(channels.find((c) => c.provider === 'linkedin')!.posting_enabled).toBe(false);
    expect(channels.find((c) => c.provider === 'x')!.posting_enabled).toBe(true);
  });

  it('turning on a LinkedIn page or profile is refused with provider_not_switched_on, before the network is asked anything', async () => {
    const li = await connection('linkedin');
    for (const body of [
      { connection_id: li, target: 'linkedin_org', account_id: 'urn:li:organization:5551234' },
      { connection_id: li, target: 'linkedin_member' },
    ]) {
      const res = await as('POST', `/workspaces/${wsId}/databases/${postsDb}/publishing/enable`, body);
      expect(res.statusCode).toBe(422);
      expect((res.json().error.meta.unmet as Array<{ code: string }>).map((u) => u.code)).toEqual(['provider_not_switched_on']);
    }
    expect(lookups).toEqual([]);
    expect((await db.query.automations.findMany({ where: eq(automations.databaseId, postsDb) })).filter((r) => JSON.stringify(r.actions).includes('post_social'))).toHaveLength(0);
  });

  it('X is unaffected: it is bring-your-own-tier and turns on', async () => {
    const x = await connection('x');
    const res = await as('POST', `/workspaces/${wsId}/databases/${postsDb}/publishing/enable`, { connection_id: x, target: 'x' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().rule).toMatchObject({ target: 'x', enabled: true });
  });
});
