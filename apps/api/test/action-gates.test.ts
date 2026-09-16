import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { actionGatePolicies, approvals, memberships, user } from '../src/db/schema';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { TokensService } from '../src/tokens/tokens.service';

/**
 * #542 Phase 2 — the workspace-declared "delete_records" action-class gate,
 * end to end against a real Postgres. Exercises the ticket's own adversarial
 * framing: a human at the keyboard is never held; an agent-sourced delete
 * (single AND batch) is held rather than performed; approving actually
 * deletes; rejecting never does; and a gate policy can't be declared with an
 * approver who couldn't actually clear it (lockout prevention).
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let approverAdmin: { token: string; email: string };
let approverAdminId: string;
let member: { token: string; email: string };
let memberId: string;
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown, token: string = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: (payload ?? {}) as never,
  });
}

async function agentToken(): Promise<string> {
  // #357/#390 — an agent-scoped PAT, same technique send-email-automation
  // test uses: TokensService.create(..., origin: 'agent') is what makes a
  // request's req.auth.source resolve to 'agent' rather than the ordinary
  // PAT default of 'mcp'.
  const created = await tokens.create(adminId, wsId, `agent-${randomUUID()}`, 'admin', true, 'agent');
  return created.token;
}

async function createDeletePolicy(overrides: { approverId?: string; databaseId?: string | null; spaceId?: string | null } = {}) {
  const res = await inject('POST', `/workspaces/${wsId}/action-gates`, {
    action_class: 'delete_records',
    approver_id: overrides.approverId ?? approverAdminId,
    database_id: overrides.databaseId,
    space_id: overrides.spaceId,
  });
  return res;
}

async function newRecord(name: string): Promise<string> {
  const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name } })).json();
  return rec.id as string;
}

async function stillExists(recordId: string): Promise<boolean> {
  const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`);
  return res.statusCode === 200;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  tokens = app.get(TokensService);

  admin = await signUpUser(app, 'GateAdmin');
  wsId = (await inject('POST', '/workspaces', { name: 'Gates WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;

  approverAdmin = await signUpUser(app, 'GateApprover');
  approverAdminId = (await db.query.user.findFirst({ where: eq(user.email, approverAdmin.email) }))!.id;
  await db.insert(memberships).values({ workspaceId: wsId, userId: approverAdminId, role: 'admin', status: 'active' });

  member = await signUpUser(app, 'GateMember');
  memberId = (await db.query.user.findFirst({ where: eq(user.email, member.email) }))!.id;
  await db.insert(memberships).values({ workspaceId: wsId, userId: memberId, role: 'member', status: 'active' });
});

afterAll(async () => {
  await app.close();
});

describe('#542 Phase 2 — action-class gate: delete_records', () => {
  it('lockout prevention: a policy cannot be declared with a non-admin as approver', async () => {
    const res = await createDeletePolicy({ approverId: memberId });
    expect(res.statusCode).toBe(422);

    const rows = await db.query.actionGatePolicies.findMany({ where: eq(actionGatePolicies.workspaceId, wsId) });
    expect(rows).toHaveLength(0); // refused, never persisted
  });

  it('lockout prevention: re-enabling a policy with its approver swapped to a non-admin is refused too', async () => {
    const created = await createDeletePolicy();
    expect(created.statusCode).toBeLessThan(300);
    const id = created.json().id as string;

    const res = await inject('PATCH', `/workspaces/${wsId}/action-gates/${id}`, { approver_id: memberId });
    expect(res.statusCode).toBe(422);

    // cleanup for the next tests
    await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
  });

  it('a person at the keyboard deletes a record even with an active gate — never held', async () => {
    const policy = await createDeletePolicy();
    const id = policy.json().id as string;
    try {
      const recordId = await newRecord('Human deletes this');
      const res = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`); // admin's own session token
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });
      expect(await stillExists(recordId)).toBe(false);

      const pending = await db.query.approvals.findMany({ where: eq(approvals.recordId, recordId) });
      expect(pending).toHaveLength(0); // no approval row was ever created
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
    }
  });

  it('an agent-sourced single delete is held for approval, not performed', async () => {
    const policy = await createDeletePolicy();
    const id = policy.json().id as string;
    try {
      const recordId = await newRecord('Agent should not delete this yet');
      const token = await agentToken();
      const res = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token);

      expect(res.statusCode).toBe(200);
      expect(res.json().pending_approval).toBe(true);
      expect(await stillExists(recordId)).toBe(true); // NOT deleted — held, not performed-then-notified

      const approval = await db.query.approvals.findFirst({ where: eq(approvals.recordId, recordId) });
      expect(approval).toBeTruthy();
      expect(approval!.status).toBe('pending');
      expect(approval!.approverId).toBe(approverAdminId);
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
    }
  });

  it('an agent-sourced BATCH delete is held for the WHOLE selection — never a partial delete', async () => {
    const policy = await createDeletePolicy();
    const id = policy.json().id as string;
    try {
      const recordIds = [await newRecord('Batch A'), await newRecord('Batch B'), await newRecord('Batch C')];
      const token = await agentToken();
      const res = await inject(
        'POST',
        `/workspaces/${wsId}/databases/${dbId}/records/batch-delete`,
        { record_ids: recordIds },
        token,
      );

      expect(res.statusCode).toBe(201); // POST's default Nest status — unchanged from an ordinary batch-delete
      expect(res.json().pending_approval).toBe(true);
      for (const id of recordIds) expect(await stillExists(id)).toBe(true); // ALL held, none partially applied

      const approval = await db.query.approvals.findFirst({ where: eq(approvals.id, res.json().approval_id) });
      const snapshot = approval!.actionSnapshot as { action: { record_ids: string[] } };
      expect(snapshot.action.record_ids.sort()).toEqual([...recordIds].sort());
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
    }
  });

  it('approving a held delete actually performs it, attributed to the ORIGINAL agent source', async () => {
    const policy = await createDeletePolicy();
    const id = policy.json().id as string;
    try {
      const recordId = await newRecord('Approve me');
      const token = await agentToken();
      const held = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token);
      const approvalId = held.json().approval_id as string;

      const approveRes = await inject('POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`); // approverAdmin could also decide; admin is a workspace admin too
      expect(approveRes.statusCode).toBeLessThan(300);
      await jobs.tick();

      expect(await stillExists(recordId)).toBe(false);
      const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
      expect(decided!.status).toBe('approved');
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
    }
  });

  it('rejecting a held delete leaves the record alone', async () => {
    const policy = await createDeletePolicy();
    const id = policy.json().id as string;
    try {
      const recordId = await newRecord('Reject me');
      const token = await agentToken();
      const held = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token);
      const approvalId = held.json().approval_id as string;

      const rejectRes = await inject('POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'not now' });
      expect(rejectRes.statusCode).toBeLessThan(300);
      await jobs.tick();

      expect(await stillExists(recordId)).toBe(true);
      const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approvalId) });
      expect(decided!.status).toBe('rejected');
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${id}`);
    }
  });

  it('an ungated workspace deletes exactly as before — no policy, no hold, no added round trip', async () => {
    const recordId = await newRecord('No policy here');
    const token = await agentToken();
    const res = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
  });

  it('a database-scoped policy overrides a workspace-scoped one for that database (most specific wins)', async () => {
    const workspacePolicy = await createDeletePolicy(); // workspace-wide
    const dbPolicy = await createDeletePolicy({ databaseId: dbId, approverId: adminId }); // this database, different approver
    try {
      const recordId = await newRecord('Scoped');
      const token = await agentToken();
      const held = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token);
      expect(held.statusCode).toBe(200);
      const approval = await db.query.approvals.findFirst({ where: eq(approvals.id, held.json().approval_id) });
      expect(approval!.approverId).toBe(adminId); // the DATABASE-scoped policy's approver, not the workspace one's
    } finally {
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${workspacePolicy.json().id}`);
      await inject('DELETE', `/workspaces/${wsId}/action-gates/${dbPolicy.json().id}`);
    }
  });
});
