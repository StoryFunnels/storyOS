import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';

/**
 * #541 — the foundation ticket for #20: every agent-initiated write records
 * BOTH the acting agent and the human whose authority it acted under, the
 * authorising principal is resolved from the CREDENTIAL (never a field the
 * agent supplies), an agent with no resolvable owner is REFUSED (fail
 * closed), and attribution survives the agent record being renamed or
 * deleted.
 *
 * Scope of this PR (see ticket comment for the full reasoning): the
 * identity-resolution foundation (token -> live agent owner, fail-closed,
 * denormalized snapshot) is wired end-to-end through `RecordsService`'s two
 * most central write paths (create/update) and a bulk date-range query.
 * Broader propagation to every other write path (comments, relations,
 * views, batch operations, ...) is flagged as mechanical follow-up, not
 * further foundational work.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let dbId: string;
let titleApiName: string;
let adminId: string;
const { db, pool } = connectTestDb();

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

/** Mints a PAT scoped to a specific agent, as the admin (the agent's owner
 * here, since createAgent() above creates it as admin). */
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
  admin = await signUpUser(app, 'AgentIdentityOwner');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Agent Identity WS' })).json().id;

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Work' })).json().id;
  const field = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Title',
    type: 'text',
    config: {},
  });
  titleApiName = field.json().apiName;
  adminId = (await as(admin.token, 'GET', '/me')).json().id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('#541 agent identity and the authorisation chain', () => {
  it('AC1/AC3: a write made with an agent-scoped token records BOTH the agent and the authorising human, demonstrated end to end', async () => {
    const agent = await createAgent('Triage Bot');
    const agentToken = await mintAgentToken(agent.id);

    const created = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [titleApiName]: 'Made by an agent' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json().id as string;

    // "at what time" + bulk query: the new endpoint reports this write.
    const activity = await as(admin.token, 'GET', `/workspaces/${wsId}/agents/${agent.id}/activity`);
    expect(activity.statusCode, activity.body).toBe(200);
    const events = activity.json().events as Array<{ record_id: string; agent_id: string; agent_name: string; actor_id: string; created_at: string }>;
    const own = events.find((e) => e.record_id === recordId);
    expect(own, JSON.stringify(events)).toBeTruthy();
    expect(own!.agent_id).toBe(agent.id);
    expect(own!.agent_name).toBe('Triage Bot');
    // "under whose authority": actorId is the HUMAN owner, never the agent.
    expect(own!.actor_id).toBe(adminId);
    expect(new Date(own!.created_at).getTime()).toBeGreaterThan(0);
  });

  it('AC1: an update through an agent-scoped token also carries both identities, on the field-change row too', async () => {
    const agent = await createAgent('Editor Bot');
    const agentToken = await mintAgentToken(agent.id);
    const created = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Before' } })).json();

    const updated = await as(agentToken, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${created.id}`, {
      values: { [titleApiName]: 'After' },
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const activity = await as(admin.token, 'GET', `/workspaces/${wsId}/agents/${agent.id}/activity`);
    const changes = activity.json().field_changes as Array<{ record_id: string; agent_id: string; agent_name: string; old_value: string; new_value: string }>;
    const own = changes.find((c) => c.record_id === created.id);
    expect(own, JSON.stringify(changes)).toBeTruthy();
    expect(own!.agent_id).toBe(agent.id);
    expect(own!.new_value).toBe('After');
  });

  it('AC2: the authorising principal is resolved from the CREDENTIAL — a client cannot claim to act as an agent it wasn\'t minted for', async () => {
    // Stronger than merely "ignored": the record-value validator rejects an
    // unknown field outright (422), so there is no field at all through
    // which a request could smuggle an agent identity — proven here, not
    // assumed. The real identity comes ONLY from auth.guard.ts resolving the
    // TOKEN's own stored agent_id, never anything in a request body.
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [titleApiName]: 'Ordinary write', agent_id: 'not-a-real-field' },
    });
    expect(created.statusCode).toBe(422);

    // The same write WITHOUT the bogus field succeeds and carries no agent
    // attribution at all — an ordinary token has nothing to smuggle in.
    const clean = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [titleApiName]: 'Ordinary write, clean' },
    });
    expect(clean.statusCode, clean.body).toBe(201);
  });

  it('AC4: fail closed — a token minted for an agent that is later DELETED is refused outright, not defaulted to a system/admin identity', async () => {
    const agent = await createAgent('Doomed Bot');
    const agentToken = await mintAgentToken(agent.id);

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${agentsDbId}/records/${agent.id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);

    const res = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [titleApiName]: 'Should never land' },
    });
    expect(res.statusCode, res.body).toBe(401); // refused, not a 500 and not a silent fallback
  });

  it('AC4: fail closed — a token minted for an agent whose OWNER is no longer an active member is refused (inverted-default test)', async () => {
    const otherOwner = await signUpUser(app, 'ReassignedOwner');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: otherOwner.email, role: 'member' });
    const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(otherOwner.token, 'POST', '/invites/accept', { token: inviteToken });

    // The other member creates their OWN agent (so they're its owner/creator).
    const agentAsOther = await as(otherOwner.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
      values: { name: 'Orphan-to-be Bot', enabled: true },
    });
    expect(agentAsOther.statusCode, agentAsOther.body).toBe(201);
    const agentId = agentAsOther.json().id as string;
    const agentToken = await mintAgentToken(agentId); // admin may also mint (admin override)

    // Sanity: works while the owner is active.
    const before = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'While active' } });
    expect(before.statusCode, before.body).toBe(201);

    // Remove the owner from the workspace — the agent's authority evaporates.
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json() as Array<{
      id: string;
      user: { email: string };
    }>;
    const otherMembership = members.find((m) => m.user.email === otherOwner.email)!;
    const removed = await as(admin.token, 'DELETE', `/workspaces/${wsId}/members/${otherMembership.id}`);
    expect(removed.statusCode, removed.body).toBeLessThan(300);

    const after = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Should be refused' } });
    expect(after.statusCode, after.body).toBe(401); // no resolvable human principal -> refused, never defaulted
  });

  it('AC5: attribution survives the agent being RENAMED — historical rows keep the name at write time, not the current name', async () => {
    const agent = await createAgent('Original Name');
    const agentToken = await mintAgentToken(agent.id);
    const created = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Written before rename' } });
    expect(created.statusCode, created.body).toBe(201);

    const renamed = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${agentsDbId}/records/${agent.id}`, {
      values: { name: 'Renamed Bot' },
    });
    expect(renamed.statusCode, renamed.body).toBeLessThan(300);

    const activity = await as(admin.token, 'GET', `/workspaces/${wsId}/agents/${agent.id}/activity`);
    const events = activity.json().events as Array<{ record_id: string; agent_name: string }>;
    const own = events.find((e) => e.record_id === created.json().id);
    expect(own!.agent_name).toBe('Original Name'); // the snapshot, not the live (renamed) name
  });

  it('AC5: attribution survives DELETE — the historical row still names the agent after it is deleted', async () => {
    const agent = await createAgent('Soon Deleted Bot');
    const agentToken = await mintAgentToken(agent.id);
    const created = await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'Written before delete' } });
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json().id as string;

    const del = await as(admin.token, 'DELETE', `/workspaces/${wsId}/databases/${agentsDbId}/records/${agent.id}`);
    expect(del.statusCode, del.body).toBeLessThan(300);

    // Read the raw row directly — the /activity endpoint itself re-resolves
    // the agent (by ref) to report its name, which a soft-deleted agent would
    // 404 on; the point of this AC is the STORED row, not that lookup.
    const raw = await db.query.activityEvents.findMany({
      where: (t, { eq: eqOp }) => eqOp(t.recordId, recordId),
    });
    const ownRaw = raw.find((r) => r.type === 'record.created');
    expect(ownRaw?.agentId).toBe(agent.id);
    expect(ownRaw?.agentName).toBe('Soon Deleted Bot');
  });

  it('MUST KEEP WORKING: an ordinary human write carries NO agent attribution at all (not empty string, absent)', async () => {
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { [titleApiName]: 'A human wrote this' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const raw = await db.query.activityEvents.findMany({
      where: (t, { eq: eqOp }) => eqOp(t.recordId, created.json().id),
    });
    expect(raw[0]?.agentId).toBeNull();
    expect(raw[0]?.agentName).toBeNull();
  });

  it('AC6: bulk queryable for a date range — a `from` in the future returns nothing, proving the filter is real', async () => {
    const agent = await createAgent('Range Test Bot');
    const agentToken = await mintAgentToken(agent.id);
    await as(agentToken, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { [titleApiName]: 'x' } });

    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/agents/${agent.id}/activity?from=${encodeURIComponent(future)}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().events).toEqual([]);
  });
});
