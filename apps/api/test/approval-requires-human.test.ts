import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, memberships, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #859 — an approval is a person's decision. `assertHuman` asked "are you an admin or the named
 * approver?" and never "are you a person?", so an agent holding an admin's credentials (every
 * agent in the fleet) could approve its own gated action: "agent proposes, agent confirms".
 *
 * The adversarial shape: the SAME admin identity, once through a browser session (human) and once
 * through a token (mcp, and an agent-origin token), against the SAME held action. The human
 * passes; the token is refused with a reason, WHILE holding admin and WHILE being the named
 * approver, and the action stays held. A person who is the named approver, and an admin who is
 * not, both still approve: this narrows by source, not by role.
 */
let app: NestFastifyApplication;
let db: Db;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let other: { token: string; email: string };
let otherId: string;
let wsId: string;
let dbId: string;

const call = (method: string, url: string, token: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  tokens = app.get(TokensService);
  admin = await signUpUser(app, 'ApprHuman Admin');
  wsId = (await call('POST', '/workspaces', admin.token, { name: '859 WS' })).json().id;
  const spaceId = (await call('GET', `/workspaces/${wsId}/spaces`, admin.token)).json()[0].id;
  dbId = (await call('POST', `/workspaces/${wsId}/databases`, admin.token, { space_id: spaceId, name: 'Tickets' })).json().id;
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  other = await signUpUser(app, 'ApprHuman Other');
  otherId = (await db.query.user.findFirst({ where: eq(user.email, other.email) }))!.id;
  await db.insert(memberships).values({ workspaceId: wsId, userId: otherId, role: 'admin', status: 'active' });
});

afterAll(async () => {
  await app.close();
});

/** Gate deletes for `approverId`, then have an agent-origin token delete a record: returns the held approval id. */
async function heldApproval(approverId: string): Promise<string> {
  const policy = await call('POST', `/workspaces/${wsId}/action-gates`, admin.token, { action_class: 'delete_records', approver_id: approverId });
  expect(policy.statusCode, policy.body).toBeLessThan(300);
  const rec = (await call('POST', `/workspaces/${wsId}/databases/${dbId}/records`, admin.token, { values: { name: 'gated' } })).json().id as string;
  const agent = (await tokens.create(adminId, wsId, 'proposer', 'admin', true, 'agent')).token;
  const res = await call('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec}`, agent);
  expect(res.json().pending_approval, res.body).toBe(true);
  await call('DELETE', `/workspaces/${wsId}/action-gates/${policy.json().id}`, admin.token);
  return res.json().approval_id as string;
}
const status = async (id: string) => (await db.query.approvals.findFirst({ where: eq(approvals.id, id) }))!.status;

describe('#859 — approve/reject need a person, not just a role', () => {
  it('the SAME admin: a token is refused (with the reason, still pending); a session approves', async () => {
    const id = await heldApproval(adminId); // the admin IS the named approver
    const mcp = (await tokens.create(adminId, wsId, 'admin-mcp', 'admin', true)).token; // ordinary PAT = mcp
    const agent = (await tokens.create(adminId, wsId, 'admin-agent', 'admin', true, 'agent')).token;
    for (const [label, t] of [['mcp', mcp], ['agent', agent]] as const) {
      const res = await call('POST', `/workspaces/${wsId}/approvals/${id}/approve`, t);
      expect(res.statusCode, `${label}: ${res.body}`).toBe(403);
      expect(res.json().error.message, 'names the reason').toMatch(/needs a person/);
      expect(await status(id), `${label}: still held`).toBe('pending');
    }
    const human = await call('POST', `/workspaces/${wsId}/approvals/${id}/approve`, admin.token);
    expect(human.statusCode, human.body).toBeLessThan(300);
    expect(await status(id)).not.toBe('pending');
  });

  it('reject is refused to a token too, and a session rejects', async () => {
    const id = await heldApproval(adminId);
    const mcp = (await tokens.create(adminId, wsId, 'admin-mcp2', 'admin', true)).token;
    const res = await call('POST', `/workspaces/${wsId}/approvals/${id}/reject`, mcp, { reason: 'no' });
    expect(res.statusCode, res.body).toBe(403);
    expect(await status(id)).toBe('pending');
    const human = await call('POST', `/workspaces/${wsId}/approvals/${id}/reject`, admin.token, { reason: 'no' });
    expect(human.statusCode, human.body).toBeLessThan(300);
  });

  it('role is NOT narrowed: a human admin who is not the named approver still approves', async () => {
    const id = await heldApproval(otherId); // named approver is the other admin
    const res = await call('POST', `/workspaces/${wsId}/approvals/${id}/approve`, admin.token);
    expect(res.statusCode, res.body).toBeLessThan(300);
  });

  it('the agent-run gate (runs/:run/approve|reject) needs a person too; a session gets past the source check', async () => {
    const mcp = (await tokens.create(adminId, wsId, 'admin-mcp3', 'admin', true)).token;
    const bogus = '00000000-0000-4000-8000-000000000000';
    for (const verb of ['approve', 'reject']) {
      const refused = await call('POST', `/workspaces/${wsId}/agents/runs/${bogus}/${verb}`, mcp);
      expect(refused.statusCode, `${verb} by token: ${refused.body}`).toBe(403);
      const person = await call('POST', `/workspaces/${wsId}/agents/runs/${bogus}/${verb}`, admin.token);
      expect(person.statusCode, `${verb} by session reaches the run lookup, not the source check: ${person.body}`).not.toBe(403);
    }
  });
});
