import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import { activityEvents } from '../src/db/schema';
import type { Db } from '../src/db/client';

/**
 * ticket #1226 - activity events name the agent behind an agent-made change, so the Activity panel's gold badge can say WHICH agent.
 * The name is the snapshot stamped on the row from the credential's own agent (never request input), so a page needs no lookup.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let dbId: string;

async function as(token: string, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: { ...authed(token), ...headers }, payload: payload as never });
}
async function mintAgentToken(name: string) {
  const agent = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, { values: { name, enabled: true } })).json();
  const res = await as(admin.token, 'POST', '/me/tokens', { name: 'agent token', workspace_id: wsId, scope: 'write', agent_id: agent.id });
  expect(res.statusCode, res.body).toBe(201);
  return { agentId: agent.id as string, token: res.json().token as string };
}
const recUrl = (id: string) => `/workspaces/${wsId}/databases/${dbId}/records/${id}`;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'ActivityAgentName');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '1226 WS' })).json().id;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`)).json().agentsDb.id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
});
afterAll(async () => {
  await app.close();
});

describe('ticket #1226 - activity events return agent_name', () => {
  it('GET activity returns agent_id and agent_name for a source=agent event', async () => {
    const { agentId, token } = await mintAgentToken('Triage Bot');
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'a' } })).json();
    expect((await as(token, 'PATCH', recUrl(rec.id), { values: { name: 'b' } })).statusCode).toBeLessThan(300);

    const feed = (await as(admin.token, 'GET', `${recUrl(rec.id)}/activity`)).json();
    const updated = feed.data.find((e: { type: string }) => e.type === 'record.updated');
    expect(updated.source).toBe('agent');
    expect(updated.agent_id).toBe(agentId);
    expect(updated.agent_name).toBe('Triage Bot');
  });

  it('agent_name is null for human events, and a forged header cannot name an agent', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'h' } })).json();
    await as(admin.token, 'PATCH', recUrl(rec.id), { values: { name: 'h2' } }, { 'x-agent-name': 'Evil Bot', 'x-agent-id': 'nope' });
    const feed = (await as(admin.token, 'GET', `${recUrl(rec.id)}/activity`)).json();
    expect(feed.data.length).toBeGreaterThan(1);
    for (const e of feed.data) {
      expect(e.source).toBe('human');
      expect(e.agent_id).toBeNull();
      expect(e.agent_name).toBeNull();
    }
  });

  it('a row with source agent but no stamped name (written before the columns) reads null, never guessed', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'old' } })).json();
    await db.update(activityEvents).set({ source: 'agent', agentId: null, agentName: null }).where(eq(activityEvents.recordId, rec.id));
    const feed = (await as(admin.token, 'GET', `${recUrl(rec.id)}/activity`)).json();
    expect(feed.data[0].source).toBe('agent');
    expect(feed.data[0].agent_name).toBeNull();
  });

  it('a non-agent source never carries an agent name even if the columns hold one (automation stays null)', async () => {
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'auto' } })).json();
    await db.update(activityEvents).set({ source: 'automation', agentId: '00000000-0000-0000-0000-000000000001', agentName: 'Stale' }).where(eq(activityEvents.recordId, rec.id));
    const feed = (await as(admin.token, 'GET', `${recUrl(rec.id)}/activity`)).json();
    expect(feed.data[0].agent_id).toBeNull();
    expect(feed.data[0].agent_name).toBeNull();
  });

  it('the name is a snapshot: renaming the agent later does not retcon past events', async () => {
    const { token, agentId } = await mintAgentToken('Old Name');
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'x0' } })).json();
    for (let i = 1; i <= 5; i++) await as(token, 'PATCH', recUrl(rec.id), { values: { name: `x${i}` } });
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${agentsDbId}/records/${agentId}`, { values: { name: 'New Name' } });
    const feed = (await as(admin.token, 'GET', `${recUrl(rec.id)}/activity`)).json();
    const agentEvents = feed.data.filter((e: { source: string }) => e.source === 'agent');
    expect(agentEvents.length).toBe(5);
    expect(agentEvents.every((e: { agent_name: string }) => e.agent_name === 'Old Name')).toBe(true);
  });

  it('the database comments feed and the field-change history name the agent too', async () => {
    const { agentId, token } = await mintAgentToken('Commenter Bot');
    const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'c0' } })).json();
    const c = await as(token, 'POST', `${recUrl(rec.id)}/comments`, { body: [{ type: 'text', text: 'hi' }] });
    expect(c.statusCode, c.body).toBeLessThan(300);
    await as(token, 'PATCH', recUrl(rec.id), { values: { name: 'c1' } });

    const comments = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/activity/comments`)).json();
    const mine = comments.data.find((e: { record: { id: string } }) => e.record.id === rec.id);
    expect(mine.agent_id).toBe(agentId);
    expect(mine.agent_name).toBe('Commenter Bot');

    const changes = (await as(admin.token, 'GET', `${recUrl(rec.id)}/versions/changes`)).json();
    const agentChange = changes.data.find((e: { source: string }) => e.source === 'agent');
    expect(agentChange.agent_name).toBe('Commenter Bot');
  });
});
