import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { ConnectionsService } from '../src/connections/connections.service';
import type { ConnectionFetcher } from '../src/connections/providers';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let connections: ConnectionsService;

/** Every outbound "call the provider" request the service made — captured
 * instead of touching a real network, exactly like webhooks.test.ts's `sent`. */
let calls: Array<{ url: string }> = [];
let nextStatus = 200;
let nextJson: unknown = {};

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ConnAdmin');
  member = await signUpUser(app, 'ConnMember');
  wsId = (await inject('POST', '/workspaces', { name: 'Connections WS' })).json().id;

  const invite = await inject('POST', `/workspaces/${wsId}/invites`, { email: member.email, role: 'member' });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accepted = await inject('POST', '/invites/accept', { token: inviteToken }, member.token);
  if (accepted.statusCode >= 300) throw new Error(`member invite failed: ${accepted.body}`);

  connections = app.get(ConnectionsService);
  const fetcher: ConnectionFetcher = async (url) => {
    calls.push({ url });
    return { status: nextStatus, json: async () => nextJson, text: async () => JSON.stringify(nextJson) };
  };
  connections.fetcher = fetcher;
});

afterAll(async () => {
  await app.close();
});

describe('connections registry (MN-252)', () => {
  it('lists the provider catalog', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/connections/providers`);
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['apify', 'resend', 'google']));
  });

  it('rejects create with a failing healthCheck (422) and never inserts a row', async () => {
    nextStatus = 401;
    const res = await inject('POST', `/workspaces/${wsId}/connections`, {
      provider: 'apify',
      name: 'Bad Apify key',
      auth: { api_key: 'invalid' },
    });
    expect(res.statusCode).toBe(422);

    const list = await inject('GET', `/workspaces/${wsId}/connections`);
    expect(list.json().data.find((c: { name: string }) => c.name === 'Bad Apify key')).toBeUndefined();
  });

  it('creates a connection when the healthCheck passes, and never returns the secret', async () => {
    nextStatus = 200;
    const created = await inject('POST', `/workspaces/${wsId}/connections`, {
      provider: 'apify',
      name: 'Prod Apify',
      auth: { api_key: 'apify_api_super_secret_token' },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('active');
    // The redaction contract (MN-252 AC): grep the raw response for the secret
    // or any auth-shaped field name — neither should ever appear.
    expect(created.body).not.toContain('apify_api_super_secret_token');
    expect(created.body).not.toContain('auth_sealed');
    expect(created.body).not.toContain('authSealed');

    const listed = await inject('GET', `/workspaces/${wsId}/connections`);
    expect(listed.statusCode).toBe(200);
    // Redaction test for the list endpoint too — the actual AC target.
    expect(listed.body).not.toContain('apify_api_super_secret_token');
    expect(listed.body).not.toContain('auth_sealed');
    expect(listed.body).not.toContain('authSealed');
    const row = listed.json().data.find((c: { id: string }) => c.id === body.id);
    expect(row).toEqual(
      expect.objectContaining({ id: body.id, provider: 'apify', name: 'Prod Apify', status: 'active' }),
    );
    expect(Object.keys(row)).not.toContain('auth');
    expect(Object.keys(row)).not.toContain('auth_sealed');

    await inject('DELETE', `/workspaces/${wsId}/connections/${body.id}`);
  });

  it('admin-only: a member is rejected (403) on every mutation, but can still list', async () => {
    const create = await inject(
      'POST',
      `/workspaces/${wsId}/connections`,
      { provider: 'apify', name: 'Member attempt', auth: { api_key: 'x' } },
      member.token,
    );
    expect(create.statusCode, `a member must be refused, not 404'd: ${create.body}`).toBe(403);

    const list = await inject('GET', `/workspaces/${wsId}/connections`, undefined, member.token);
    expect(list.statusCode, 'read access is member-level, not admin-only').toBe(200);

    // Positive control: the member really is in this workspace.
    expect((await inject('GET', `/workspaces/${wsId}/databases`, undefined, member.token)).statusCode).toBe(200);
  });

  it('admin-only: delete and test also 403 a member', async () => {
    nextStatus = 200;
    const created = (
      await inject('POST', `/workspaces/${wsId}/connections`, {
        provider: 'apify',
        name: 'For member-403 checks',
        auth: { api_key: 'apify_x' },
      })
    ).json();

    const del = await inject('DELETE', `/workspaces/${wsId}/connections/${created.id}`, undefined, member.token);
    expect(del.statusCode).toBe(403);
    const test = await inject('POST', `/workspaces/${wsId}/connections/${created.id}/test`, undefined, member.token);
    expect(test.statusCode).toBe(403);

    await inject('DELETE', `/workspaces/${wsId}/connections/${created.id}`);
  });

  it('disconnect hard-deletes the row', async () => {
    nextStatus = 200;
    const created = (
      await inject('POST', `/workspaces/${wsId}/connections`, {
        provider: 'apify',
        name: 'To delete',
        auth: { api_key: 'apify_y' },
      })
    ).json();

    const del = await inject('DELETE', `/workspaces/${wsId}/connections/${created.id}`);
    expect(del.statusCode).toBe(200);

    const list = await inject('GET', `/workspaces/${wsId}/connections`);
    expect(list.json().data.find((c: { id: string }) => c.id === created.id)).toBeUndefined();

    // A second delete finds nothing — no tombstone.
    const again = await inject('DELETE', `/workspaces/${wsId}/connections/${created.id}`);
    expect(again.statusCode).toBe(404);
  });

  it('/test re-runs the health check and flips status on failure', async () => {
    nextStatus = 200;
    const created = (
      await inject('POST', `/workspaces/${wsId}/connections`, {
        provider: 'apify',
        name: 'Flaky',
        auth: { api_key: 'apify_z' },
      })
    ).json();

    nextStatus = 500;
    const failing = await inject('POST', `/workspaces/${wsId}/connections/${created.id}/test`);
    expect(failing.statusCode).toBe(422);
    const afterFail = (await inject('GET', `/workspaces/${wsId}/connections`)).json().data.find(
      (c: { id: string }) => c.id === created.id,
    );
    expect(afterFail.status).toBe('error');

    nextStatus = 200;
    const passing = await inject('POST', `/workspaces/${wsId}/connections/${created.id}/test`);
    expect(passing.statusCode).toBe(201);
    const afterPass = (await inject('GET', `/workspaces/${wsId}/connections`)).json().data.find(
      (c: { id: string }) => c.id === created.id,
    );
    expect(afterPass.status).toBe('active');

    await inject('DELETE', `/workspaces/${wsId}/connections/${created.id}`);
  });

  it('OAuth: connect 302s with a signed state (admin only)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    const res = await inject('GET', `/workspaces/${wsId}/connections/oauth/google/start`);
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location).toContain('accounts.google.com');
    expect(location).toContain('state=');

    const asMember = await inject(
      'GET',
      `/workspaces/${wsId}/connections/oauth/google/start`,
      undefined,
      member.token,
    );
    expect(asMember.statusCode).toBe(403);
  });

  it('OAuth: callback with a forged/tampered state is rejected (400), before any provider work', async () => {
    calls = []; // isolate from prior tests' healthCheck calls
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/connections/oauth/callback?state=totally-forged-state&code=abc',
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toHaveLength(0); // never reached the token exchange
  });

  it('OAuth: callback with a good state but no code redirects with an error, not a 500', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    const start = await inject('GET', `/workspaces/${wsId}/connections/oauth/google/start`);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('/settings/connections?error=');
  });

  it('refresh loop: a failed refresh flips status to expired and notifies the creator', async () => {
    process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';

    // Complete an OAuth connect end-to-end: start → callback with a good code.
    const start = await inject('GET', `/workspaces/${wsId}/connections/oauth/google/start`);
    const state = new URL(String(start.headers.location)).searchParams.get('state')!;

    nextStatus = 200;
    nextJson = { access_token: 'ya29.initial', refresh_token: 'refresh-1', expires_in: 1 }; // expires almost immediately
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=good-code`,
    });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toContain('connected=google');

    const listed = (await inject('GET', `/workspaces/${wsId}/connections`)).json().data;
    const conn = listed.find((c: { provider: string }) => c.provider === 'google');
    expect(conn).toBeDefined();
    expect(conn.status).toBe('active');

    // The token is already "expired" (1 second ttl) — the refresh sweep should
    // pick it up. Make the refresh call itself fail.
    nextStatus = 400;
    await connections.refreshDueTokens();

    const afterRefresh = (await inject('GET', `/workspaces/${wsId}/connections`)).json().data.find(
      (c: { id: string }) => c.id === conn.id,
    );
    expect(afterRefresh.status).toBe('expired');

    const notifs = await inject('GET', `/workspaces/${wsId}/notifications?type=connection_error`);
    expect(notifs.statusCode).toBe(200);
    expect(
      notifs
        .json()
        .data.some((n: { type: string; snippet: string }) => n.type === 'connection_error' && n.snippet?.includes('google')),
    ).toBe(true);

    await inject('DELETE', `/workspaces/${wsId}/connections/${conn.id}`);
  });
});
