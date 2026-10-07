import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections } from '../src/db/schema';
import { seal } from '../src/common/secretbox';

/**
 * #455 — `AutomationsService.update()` only re-validated an action's
 * connection reference (`send_email`/`http_request`'s `connection_id` must
 * resolve to a real connection) when the PATCH itself replaced `actions`. A
 * patch that only flips `enabled: false -> true` skipped validation
 * entirely, so a rule whose connection was deleted WHILE it sat disabled
 * could be silently re-enabled and fail only in the run log.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let dbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'EnableGuardOwner');
  adminId = (await as(admin.token, 'GET', '/me')).json().id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '455 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#455 — enabling a rule re-validates its connection references', () => {
  it('a rule disabled while its connection existed, then re-enabled after the connection is deleted, is refused', async () => {
    const [connection] = await db
      .insert(connections)
      .values({
        workspaceId: wsId,
        provider: 'resend',
        name: `Test Resend ${randomUUID()}`,
        authSealed: seal(JSON.stringify({ api_key: 're_test', from_address: 'a@example.com' })),
        scopes: ['domain:example.com', 'from:a@example.com'],
        status: 'active',
        createdBy: adminId,
      })
      .returning();

    const rule = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Email on create',
      trigger: { type: 'record_created' },
      enabled: false,
      actions: [
        {
          type: 'send_email',
          connection_id: connection!.id,
          to: 'someone@example.com',
          subject: 'Hi',
          body_markdown: 'hello',
          require_approval: false,
        },
      ],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const ruleId = rule.json().id;

    // The connection is removed while the rule sits disabled.
    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/connections/${connection!.id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);

    // Re-enabling WITHOUT touching `actions` used to skip validation entirely.
    const enable = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${ruleId}`, {
      enabled: true,
    });
    expect(enable.statusCode, enable.body).toBe(422);
    expect(enable.json().error.message).toMatch(/unknown connection/);
  });

  it('MUST KEEP WORKING: re-enabling a rule whose connection still exists succeeds', async () => {
    const [connection] = await db
      .insert(connections)
      .values({
        workspaceId: wsId,
        provider: 'resend',
        name: `Test Resend ${randomUUID()}`,
        authSealed: seal(JSON.stringify({ api_key: 're_test', from_address: 'a@example.com' })),
        scopes: ['domain:example.com', 'from:a@example.com'],
        status: 'active',
        createdBy: adminId,
      })
      .returning();

    const rule = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Email on create (still connected)',
      trigger: { type: 'record_created' },
      enabled: false,
      actions: [
        {
          type: 'send_email',
          connection_id: connection!.id,
          to: 'someone@example.com',
          subject: 'Hi',
          body_markdown: 'hello',
          require_approval: false,
        },
      ],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const enable = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}`, {
      enabled: true,
    });
    expect(enable.statusCode, enable.body).toBeLessThan(300);
  });

  it('MUST KEEP WORKING: flipping enabled on a rule with no connection-dependent actions (e.g. every shipped pack automation) is unaffected', async () => {
    const rule = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify self',
      trigger: { type: 'record_created' },
      enabled: false,
      actions: [{ type: 'notify_user', user: '@me', message: 'hi' }],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const enable = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}`, {
      enabled: true,
    });
    expect(enable.statusCode, enable.body).toBeLessThan(300);
  });

  it('MUST KEEP WORKING: a patch that changes actions is still validated exactly as before (no double-validation regression)', async () => {
    const rule = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Notify self, patched',
      trigger: { type: 'record_created' },
      enabled: true,
      actions: [{ type: 'notify_user', user: '@me', message: 'v1' }],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const patch = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}`, {
      actions: [{ type: 'notify_user', user: '@me', message: 'v2' }],
    });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
  });
});
