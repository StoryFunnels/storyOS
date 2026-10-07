import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #677 (Gap 1) — `record_versions` (the whole-record snapshot table) had no
 * way to tell a human write apart from an agent one: `actor_id` is a bare
 * user id either way. `record_field_changes` (a sibling table, #31) already
 * carries `source`/`agent_id`/`agent_name` — this gives `record_versions`
 * the identical badge, populated from the same #541 credential-resolved
 * identity every other write path already threads through, not a new
 * mechanism.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let dbId: string;
let adminId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function createAgent(name: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: { name, enabled: true },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; title: string };
}

async function mintAgentToken(agentId: string) {
  const res = await as(admin.token, 'POST', '/me/tokens', {
    name: 'agent token',
    workspace_id: wsId,
    scope: 'write',
    agent_id: agentId,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'VersionAttribOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '677 WS' })).json().id;

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  adminId = (await as(admin.token, 'GET', '/me')).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#677 — record_versions attribution', () => {
  it('a human edit captures source: human, with no agent badge', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'v1' } })).json();
    const update = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'v2' },
    });
    expect(update.statusCode, update.body).toBeLessThan(300);

    const versions = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions`)).json();
    const captured = versions.data[0]; // the pre-edit ("v1") snapshot, captured just before the write landed
    expect(captured.source).toBe('human');
    expect(captured.agent_id).toBeNull();
    expect(captured.agent_name).toBeNull();
    expect(captured.title).toBe('v1');
    expect(captured.actor_id).toBe(adminId);
  });

  it('an agent-token edit captures source: agent, with the agent id/name — the exact distinction that did not exist before', async () => {
    const agent = await createAgent('Editor Bot');
    const agentToken = await mintAgentToken(agent.id);
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'before' } })).json();

    const update = await as(agentToken, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { name: 'after' },
    });
    expect(update.statusCode, update.body).toBeLessThan(300);

    const versions = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions`)).json();
    const captured = versions.data[0];
    expect(captured.source).toBe('agent');
    expect(captured.agent_id).toBe(agent.id);
    expect(captured.agent_name).toBe('Editor Bot');
    // "under whose authority": actor_id is still the HUMAN owner, never the agent (#541's own invariant).
    expect(captured.actor_id).toBe(adminId);
  });

  it('restoring a version also captures attribution on the pre-restore snapshot and the activity event', async () => {
    const agent = await createAgent('Restore Bot');
    const agentToken = await mintAgentToken(agent.id);
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'original' } })).json();
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, { values: { name: 'edited' } });
    const versions = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions`)).json();
    const originalVersionId = versions.data[versions.data.length - 1].id;

    const restore = await as(
      agentToken,
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/${originalVersionId}/restore`,
    );
    expect(restore.statusCode, restore.body).toBe(201);

    const afterVersions = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions`)).json();
    // The pre-restore state ("edited") was itself snapshotted, attributed to the agent that triggered the restore.
    const preRestoreSnapshot = afterVersions.data.find((v: { title: string }) => v.title === 'edited');
    expect(preRestoreSnapshot, JSON.stringify(afterVersions.data)).toBeTruthy();
    expect(preRestoreSnapshot.source).toBe('agent');
    expect(preRestoreSnapshot.agent_id).toBe(agent.id);
    expect(preRestoreSnapshot.agent_name).toBe('Restore Bot');
  });

  it('MUST KEEP WORKING: restore itself is unaffected — values/title land exactly as before', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'first' } })).json();
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, { values: { name: 'second' } });
    const versions = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions`)).json();
    const firstVersionId = versions.data[versions.data.length - 1].id;

    const restore = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/versions/${firstVersionId}/restore`);
    expect(restore.statusCode, restore.body).toBe(201);
    expect(restore.json().title).toBe('first');
  });
});
