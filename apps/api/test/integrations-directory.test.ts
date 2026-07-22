import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

interface DirectoryEntry {
  id: string;
  label: string;
  built_by: string;
  auth_kind: string;
  status: string;
  connected: boolean;
}

async function directory(token: string): Promise<DirectoryEntry[]> {
  const res = await as(token, 'GET', `/workspaces/${wsId}/integrations`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'IntegrationsDirAdmin');
  member = await signUpUser(app, 'IntegrationsDirMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Integrations Directory WS' })).json().id;

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('Integrations directory (#44)', () => {
  it('is readable by a plain member — read status, never a credential', async () => {
    const data = await directory(member.token);
    const byId = new Map(data.map((d) => [d.id, d]));

    expect(byId.get('github')?.connected).toBe(false);
    expect(byId.get('linear')?.connected).toBe(false);
    expect(byId.get('slack')?.connected).toBe(false);
    // Not built yet — still `status: 'soon'`, never connected regardless of anything else.
    expect(byId.get('google-calendar')?.status).toBe('soon');
    expect(byId.get('google-calendar')?.connected).toBe(false);
    // Built-in — always available, nothing to connect.
    expect(byId.get('delegate-agent')?.status).toBe('available');
    expect(byId.get('delegate-agent')?.connected).toBe(true);

    // No response field is secret-shaped — redactSecrets is a no-op here by
    // construction, but the shape itself should stay that way.
    expect(JSON.stringify(data)).not.toMatch(/token|secret|api_key|webhook_url/i);
  });

  it('reflects a platform going from not-connected to connected', async () => {
    const before = await directory(admin.token);
    expect(before.find((d) => d.id === 'slack')?.connected).toBe(false);

    const save = await as(admin.token, 'POST', `/workspaces/${wsId}/integrations/slack`, {
      bot_token: 'xoxb-test-token',
    });
    expect(save.statusCode, save.body).toBe(201);

    const after = await directory(admin.token);
    expect(after.find((d) => d.id === 'slack')?.connected).toBe(true);
    // Untouched platforms don't flip along with it.
    expect(after.find((d) => d.id === 'github')?.connected).toBe(false);
  });

  it('carries the registry metadata the gallery renders generically', async () => {
    const data = await directory(admin.token);
    const github = data.find((d) => d.id === 'github');
    expect(github?.label).toBe('GitHub');
    expect(github?.built_by).toBe('StoryOS');
    expect(github?.auth_kind).toBe('oauth2');
    expect(data.map((d) => d.id)).toContain('storyfunnels');
    expect(data.map((d) => d.id)).toContain('storypages');
  });
});
