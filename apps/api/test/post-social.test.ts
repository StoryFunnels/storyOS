import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections, memberships, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';
import { seal } from '../src/common/secretbox';

/**
 * Ticket #42 / MN-257 — post_social's save-time gate, against a real
 * Postgres. The provider HTTP calls themselves (LinkedIn/X publish, media
 * upload) are covered without a database in
 * src/automations/post-social.action.test.ts (PostSocialActionService.run()
 * driven directly with a stubbed `fetcher`, the same convention
 * http-request-action.service.test.ts / send-email.action.test.ts use) —
 * this file only exercises what needs real save-time plumbing: connection
 * lookups, the admin-only require_approval:false override (mirrors
 * send-email-automation.test.ts's own test for send_email), and the
 * LINKEDIN_ACTIONS_ENABLED flag gate.
 *
 * The test env never sets LINKEDIN_ACTIONS_ENABLED (see
 * src/sources/providers/provider-enabled.test.ts's own note), so every test
 * here runs with it OFF — exactly the "flags off" scenario the ticket's own
 * E2E requirement asks for.
 */
describe('post_social automation action — save-time validation (ticket #42)', () => {
  let app: NestFastifyApplication;
  let db: Db;
  let admin: { token: string; email: string };
  let adminId: string;
  let member: { token: string; email: string };
  let wsId: string;
  let spaceId: string;
  let dbId: string;
  let textApi: string;

  async function as(method: string, url: string, payload?: unknown, token: string = admin.token) {
    return app.inject({
      method: method as never,
      url: `/api/v1${url}`,
      headers: authed(token),
      payload: (payload ?? {}) as never,
    });
  }

  async function createConnection(provider: 'linkedin' | 'x') {
    const auth = provider === 'linkedin' ? { access_token: 'li-tok', obtained_at: Date.now() } : { access_token: 'x-tok' };
    const [connection] = await db
      .insert(connections)
      .values({
        workspaceId: wsId,
        provider,
        name: `Test ${provider} ${randomUUID()}`,
        authSealed: seal(JSON.stringify(auth)),
        status: 'active',
        createdBy: adminId,
      })
      .returning();
    return connection!.id as string;
  }

  async function createRule(
    overrides: Record<string, unknown> = {},
    token: string = admin.token,
  ) {
    return as(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/automations`,
      {
        name: `Post social ${randomUUID()}`,
        trigger: { type: 'record_created' },
        actions: [
          {
            type: 'post_social',
            connection_id: overrides.connection_id,
            target: 'x',
            text: 'Hello {Title}',
            ...overrides,
          },
        ],
      },
      token,
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await signUpUser(app, 'PostSocialAdmin');
    adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
    wsId = (await as('POST', '/workspaces', { name: 'Post Social WS' })).json().id;
    spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Posts' })).json().id;
    const textField = (
      await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Body', type: 'text', config: {} })
    ).json();
    textApi = textField.apiName;
    void textApi;

    member = await signUpUser(app, 'PostSocialMember');
    const memberId = (await db.query.user.findFirst({ where: eq(user.email, member.email) }))!.id;
    await db.insert(memberships).values({ workspaceId: wsId, userId: memberId, role: 'member', status: 'active' });
  });

  afterAll(async () => {
    await app.close();
  });

  describe('connection requirements', () => {
    it('an unknown connection_id 422s', async () => {
      const res = await createRule({ connection_id: randomUUID(), target: 'x' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('unknown connection');
    });

    it("an 'x' target must reference an 'x' connection, not linkedin", async () => {
      const linkedinConnId = await createConnection('linkedin');
      const res = await createRule({ connection_id: linkedinConnId, target: 'x' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("must be a 'x' connection");
    });

    it("a 'linkedin_member' target must reference a 'linkedin' connection, not x", async () => {
      const xConnId = await createConnection('x');
      const res = await createRule({ connection_id: xConnId, target: 'linkedin_member' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain("must be a 'linkedin' connection");
    });

    it('a well-formed x connection + target validates fine', async () => {
      const xConnId = await createConnection('x');
      const res = await createRule({ connection_id: xConnId, target: 'x' });
      expect(res.statusCode).toBe(201);
    });
  });

  describe('LINKEDIN_ACTIONS_ENABLED gate (#42 E2E requirement)', () => {
    it('with the flag off, a linkedin_org/linkedin_member target is rejected as "not enabled"', async () => {
      const linkedinConnId = await createConnection('linkedin');
      const res = await createRule({ connection_id: linkedinConnId, target: 'linkedin_member' });
      expect(res.statusCode).toBe(422);
      expect(res.body).toContain('not enabled');

      const resOrg = await createRule({ connection_id: linkedinConnId, target: 'linkedin_org' });
      expect(resOrg.statusCode).toBe(422);
      expect(resOrg.body).toContain('not enabled');
    });

    it('with the flag off, an x target is NOT rejected by the flag check', async () => {
      const xConnId = await createConnection('x');
      const res = await createRule({ connection_id: xConnId, target: 'x' });
      // Any other validation still applies normally — this just proves the
      // LinkedIn-specific flag never fires for x.
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain('not enabled');
    });
  });

  describe('require_approval: false admin-only override', () => {
    it('a non-admin member cannot save require_approval: false on post_social (422)', async () => {
      const xConnId = await createConnection('x');
      const res = await createRule({ connection_id: xConnId, target: 'x', require_approval: false }, member.token);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/only a workspace admin/i);
    });

    it('an admin-scoped AGENT token cannot save require_approval: false on post_social either (422)', async () => {
      const xConnId = await createConnection('x');
      const minted = await app.get(TokensService).create(adminId, wsId, 'test agent token', 'admin', true, 'agent');
      const res = await createRule(
        { connection_id: xConnId, target: 'x', require_approval: false },
        minted.token,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json().error.message).toMatch(/human decision/i);
    });

    it('an admin typing it themselves (source=human) CAN save require_approval: false', async () => {
      const xConnId = await createConnection('x');
      const res = await createRule({ connection_id: xConnId, target: 'x', require_approval: false });
      expect(res.statusCode).toBe(201);
    });

    it('a non-admin member CAN still save the default (unset) or an explicit true', async () => {
      const xConnId = await createConnection('x');
      const resDefault = await createRule({ connection_id: xConnId, target: 'x' }, member.token);
      expect(resDefault.statusCode).toBe(201);
      const resTrue = await createRule(
        { connection_id: xConnId, target: 'x', require_approval: true },
        member.token,
      );
      expect(resTrue.statusCode).toBe(201);
    });
  });
});
