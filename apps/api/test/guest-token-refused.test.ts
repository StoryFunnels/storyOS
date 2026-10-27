import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #1091 — the UI (Connect your AI) and the docs say a guest cannot create a personal access token, but POST /me/tokens only checked for an
 * ACTIVE MEMBERSHIP, never the role. Not an escalation (the token still acts with a guest's narrowing on every request); a contract
 * mismatch. The API now matches what the UI says.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let ws: string;
let space: string;
const as = (token: string, method: string, url: string, payload?: unknown) => app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

async function joinAs(role: 'member' | 'guest', name: string) {
  const person = await signUpUser(app, name);
  const invite = await as(admin.token, 'POST', `/workspaces/${ws}/invites`, { email: person.email, role, ...(role === 'guest' ? { grants: [{ space_id: space, role: 'viewer' }] } : {}) });
  expect(invite.statusCode, invite.body).toBeLessThan(300);
  await as(person.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
  return person;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Token Admin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Guest tokens WS' })).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1091 POST /me/tokens by role', () => {
  it('a GUEST is refused 403 with a message that says guests cannot create tokens; nothing is created', async () => {
    const guest = await joinAs('guest', 'Guest Minter');
    const res = await as(guest.token, 'POST', '/me/tokens', { name: 'sneaky', workspace_id: ws });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/guests cannot create/i);
    expect(res.body, 'the same sentence the Connect your AI page shows').toContain('Ask a workspace admin');
    const mine = await as(guest.token, 'GET', '/me/tokens');
    expect((mine.json() as { data?: unknown[] } | unknown[]), 'no token row was written').toSatisfy((v: unknown) => (Array.isArray(v) ? v : (v as { data?: unknown[] }).data ?? []).length === 0);
  });

  it('a member and an admin can still create one', async () => {
    const member = await joinAs('member', 'Member Minter');
    for (const [who, token] of [['member', member.token], ['admin', admin.token]] as const) {
      const res = await as(token, 'POST', '/me/tokens', { name: `${who} token`, workspace_id: ws });
      expect(res.statusCode, `${who}: ${res.body}`).toBe(201);
      expect(res.json().token).toMatch(/^mn_pat_/);
    }
  });

  it('a person who is a GUEST in this workspace but an admin in another can mint for the other one', async () => {
    const guest = await joinAs('guest', 'Guest Here, Admin There');
    const own = (await as(guest.token, 'POST', '/workspaces', { name: 'Their own workspace' })).json().id as string;
    const ok = await as(guest.token, 'POST', '/me/tokens', { name: 'own', workspace_id: own });
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await as(guest.token, 'POST', '/me/tokens', { name: 'here', workspace_id: ws })).statusCode).toBe(403);
  });

  it('a workspace they are not in is still the same 404 for a guest as for anyone (the refusal does not become a probe)', async () => {
    const guest = await joinAs('guest', 'Guest Prober');
    const other = (await as(admin.token, 'POST', '/workspaces', { name: 'Not theirs' })).json().id as string;
    expect((await as(guest.token, 'POST', '/me/tokens', { name: 'x', workspace_id: other })).statusCode).toBe(404);
  });
});

describe('#1091 what must keep working', () => {
  it('Tyron-style internal minting for a guest is untouched (the guard is on the REST route, not the mint function)', async () => {
    const guest = await joinAs('guest', 'Guest Via Tyron');
    const guestId = (await as(guest.token, 'GET', '/me')).json().id as string;
    const minted = await app.get(TokensService).create(guestId, ws, 'Tyron (approved)', 'read', true, 'agent');
    expect(minted.token).toMatch(/^mn_pat_/);
  });

  it('an agent identity token is unchanged: an admin still mints one for an agent, a member who is not its owner still cannot', async () => {
    const member = await joinAs('member', 'Not The Owner');
    const pack = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
    const agent = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${pack.agentsDb.id}/records`, { values: { name: 'Token agent', enabled: true } });
    expect(agent.statusCode, agent.body).toBe(201);
    const byAdmin = await as(admin.token, 'POST', '/me/tokens', { name: 'agent token', workspace_id: ws, agent_id: agent.json().id });
    expect(byAdmin.statusCode, byAdmin.body).toBe(201);
    expect((await as(member.token, 'POST', '/me/tokens', { name: 'stolen', workspace_id: ws, agent_id: agent.json().id })).statusCode).toBe(403);
  });

  it('a guest can still LIST and REVOKE what they hold (existing tokens are not touched by this change)', async () => {
    const guest = await joinAs('guest', 'Guest Existing');
    const guestId = (await as(guest.token, 'GET', '/me')).json().id as string;
    const existing = await app.get(TokensService).create(guestId, ws, 'made before the rule', 'read', true);
    const listed = (await as(guest.token, 'GET', '/me/tokens')).json() as { data?: Array<{ id: string }> } | Array<{ id: string }>;
    expect((Array.isArray(listed) ? listed : listed.data ?? []).some((t) => t.id === existing.id)).toBe(true);
    expect((await as(guest.token, 'DELETE', `/me/tokens/${existing.id}`)).statusCode).toBeLessThan(300);
  });
});
