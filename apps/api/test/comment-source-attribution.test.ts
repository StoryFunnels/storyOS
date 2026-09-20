import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { comments } from '../src/db/schema';

/**
 * #734 (D3 defect, parent #732) — `list_comments` returned only `author`/
 * `author_id`/`created_at`/`edited_at`/`id`/`text`, while `get_history`
 * already exposes real `source` (human/agent/mcp/automation) on the SAME
 * record via `api_tokens.origin` (ADR-0016). Agents hand-typed their own
 * name into a comment body to fake provenance instead. This adds the same
 * source/agent_id/agent_name badge record_versions/record_field_changes
 * already carry (#31/#481/#541), read from the real credential — never a
 * second, separately-maintained value.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let agentsDbId: string;
let wsId: string;
let dbId: string;
let recId: string;

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
  db = app.get(DB);
  admin = await signUpUser(app, 'CommentSourceOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '734 WS' })).json().id;

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  recId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Rec' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#734 — comments carry real source attribution', () => {
  it('a comment posted via a genuine human session shows source: human, no agent badge', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'a human comment' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().source).toBe('human');
    expect(res.json().agent_id).toBeNull();

    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`);
    const posted = list.json().data.find((c: { id: string }) => c.id === res.json().id);
    expect(posted.source).toBe('human');
    expect(posted.agent_id).toBeNull();
    expect(posted.agent_name).toBeNull();
  });

  it("a comment posted via an agent's API token shows source: agent, with the correct agent_id/agent_name — without relying on comment-body text conventions", async () => {
    const agent = await createAgent('Commenter Bot');
    const agentToken = await mintAgentToken(agent.id);

    const res = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`, {
      body: [{ type: 'text', text: 'no self-identification needed here' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().source).toBe('agent');
    expect(res.json().agent_id).toBe(agent.id);
    expect(res.json().agent_name).toBe('Commenter Bot');

    const list = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recId}/comments`);
    const posted = list.json().data.find((c: { id: string }) => c.id === res.json().id);
    expect(posted.source).toBe('agent');
    expect(posted.agent_id).toBe(agent.id);
    expect(posted.agent_name).toBe('Commenter Bot');
    // The body text itself carries no provenance hint — the field IS the mechanism.
    expect(posted.body[0].text).toBe('no self-identification needed here');
  });

  it('MUST KEEP WORKING: a comment predating this migration (null source) still renders correctly, not crashing anything that reads it', async () => {
    const rec2 = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Rec2' } })).json().id;
    // A raw insert with no source/agent_id/agent_name — exactly the shape
    // every comment written before this ticket has, since the migration
    // added these columns nullable with no default (never retconned to
    // 'human').
    const [row] = await db
      .insert(comments)
      .values({ recordId: rec2, authorId: 'legacy-user-id', body: [{ type: 'text', text: 'pre-existing comment' }] })
      .returning();

    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec2}/comments`);
    expect(res.statusCode, res.body).toBe(200);
    const posted = res.json().data.find((c: { id: string }) => c.id === row!.id);
    expect(posted, JSON.stringify(res.json().data)).toBeTruthy();
    expect(posted.source).toBeNull();
    expect(posted.agent_id).toBeNull();
    expect(posted.agent_name).toBeNull();
    expect(posted.body[0].text).toBe('pre-existing comment');
  });
});
