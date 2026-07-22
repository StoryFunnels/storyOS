import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationJobs, memberships, notifications, user } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { ApprovalsService } from '../src/automations/approvals.service';
import { JobRunnerService } from '../src/automations/job-runner.service';

/**
 * MN-255 — the approval gate, end to end against a real Postgres. Exercises:
 * gate → pending approval + notification, no job, no inline run; approve →
 * exactly one MN-253 job from the FROZEN snapshot, idempotent under a
 * concurrent double-approve; reject → never a job, reason on the audit
 * comment; human-only gating (write-scope PAT refused; an admin-scope PAT
 * belonging to a non-admin, non-approver member still refused); the 7-day
 * expiry sweep; and the per-rule approverId override.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let approvalsService: ApprovalsService;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let adminId: string;
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

async function mint(scope: string, token: string): Promise<string> {
  const res = await inject('POST', '/me/tokens', { name: `t-${randomUUID()}`, workspace_id: wsId, scope, allow_run_button: true }, token);
  expect(res.statusCode, `mint ${scope}`).toBe(201);
  return res.json().token as string;
}

async function createRule(overrides: { approverId?: string } = {}) {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
    name: `Gate ${randomUUID()}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'add_comment', body_template: 'Approved comment for {Title}', require_approval: true }],
    ...overrides,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}

async function createRecordAndSettle(name: string) {
  const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name } })).json();
  await engine.settle(rec.id);
  return rec as { id: string };
}

async function pendingApprovalFor(recordId: string) {
  const rows = await db.query.approvals.findMany({ where: eq(approvals.recordId, recordId) });
  const pending = rows.find((a) => a.status === 'pending');
  if (!pending) throw new Error(`no pending approval for record ${recordId}`);
  return pending;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  approvalsService = app.get(ApprovalsService);
  jobs = app.get(JobRunnerService);

  admin = await signUpUser(app, 'ApprovalAdmin');
  wsId = (await inject('POST', '/workspaces', { name: 'Approvals WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;

  member = await signUpUser(app, 'ApprovalMember');
  memberId = (await db.query.user.findFirst({ where: eq(user.email, member.email) }))!.id;
  // A real (non-admin) member, added directly — an invite round-trip adds
  // nothing this suite needs to verify.
  await db.insert(memberships).values({ workspaceId: wsId, userId: memberId, role: 'member', status: 'active' });
});

afterAll(async () => {
  await app.close();
});

describe('approval gate (MN-255)', () => {
  it('a require_approval action creates a pending approval (rendered preview) + notifies the approver — no job, no inline run', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Widget');
    const approval = await pendingApprovalFor(rec.id);

    expect(approval.status).toBe('pending');
    expect(approval.previewText).toContain('Widget'); // {Name} was rendered NOW, at gate time
    expect(approval.approverId).toBe(adminId); // defaults to the rule owner

    const notes = await db.query.notifications.findMany({ where: eq(notifications.type, 'action_approval_requested') });
    expect(notes.some((n) => n.refId === approval.id)).toBe(true);

    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) });
    expect(jobRows).toHaveLength(0);

    const commentRows = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(commentRows.data).toHaveLength(0); // the gated action never ran inline
  });

  it('approve enqueues exactly one MN-253 job from the frozen snapshot — idempotent under a concurrent double-approve', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Gadget');
    const approval = await pendingApprovalFor(rec.id);

    let calls = 0;
    jobs.registerExecutor('add_comment', async (payload) => {
      calls += 1;
      return { echoed: payload };
    });

    const [r1, r2] = await Promise.all([
      inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`),
      inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`),
    ]);
    expect(r1.statusCode).toBeLessThan(300);
    expect(r2.statusCode).toBeLessThan(300);

    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) });
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]!.idempotencyKey).toBe(`approval:${approval.id}`);

    await jobs.tick();
    expect(calls).toBe(1); // never double-executed
    const settled = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, jobRows[0]!.id) });
    expect(settled!.status).toBe('succeeded');

    const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(decided!.status).toBe('approved');
    expect(decided!.decidedBy).toBe(adminId);
  });

  it('reject never enqueues a job and records the reason on an audit comment', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Do not ship');
    const approval = await pendingApprovalFor(rec.id);

    const res = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/reject`, { reason: 'not ready yet' });
    expect(res.statusCode).toBeLessThan(300);

    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) });
    expect(jobRows).toHaveLength(0);

    const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(decided!.status).toBe('rejected');
    expect(decided!.reason).toBe('not ready yet');

    const commentRows = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(commentRows.data.some((c: { body: Array<{ text: string }> }) => c.body[0]!.text.includes('not ready yet'))).toBe(
      true,
    );
  });

  it('frozen snapshot: editing the record after gating does not change what eventually runs', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Original Name');
    const approval = await pendingApprovalFor(rec.id);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, { values: { name: 'Changed Name' } });

    jobs.registerExecutor('add_comment', async (payload) => payload);
    await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`);

    const jobRow = (await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) }))[0]!;
    const snapshotAction = (jobRow.payload as { action: { body_template: string } }).action;
    expect(snapshotAction.body_template).toContain('Original Name');
    expect(snapshotAction.body_template).not.toContain('Changed Name');
  });

  it('a write-scope PAT cannot approve (needs admin scope)', async () => {
    await createRule();
    const rec = await createRecordAndSettle('PAT write');
    const approval = await pendingApprovalFor(rec.id);
    const pat = await mint('write', admin.token);
    const res = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`, {}, pat);
    expect(res.statusCode).toBe(403);
  });

  it('an admin-scope PAT still 403s when it belongs to a non-admin, non-approver member', async () => {
    await createRule(); // approver defaults to admin (the rule owner)
    const rec = await createRecordAndSettle('PAT admin, wrong owner');
    const approval = await pendingApprovalFor(rec.id);
    const pat = await mint('admin', member.token); // admin-scoped, but minted by a workspace 'member'
    const res = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`, {}, pat);
    expect(res.statusCode).toBe(403);
  });

  it('a session caller who is a workspace admin can decide even when a different user is the named approver', async () => {
    const rule = await createRule({ approverId: memberId });
    const rec = await createRecordAndSettle('Admin overrides approver');
    const approval = await pendingApprovalFor(rec.id);
    expect(approval.approverId).toBe(memberId);
    expect(approval.ruleId).toBe(rule.id);

    const res = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`); // admin's own session
    expect(res.statusCode).toBeLessThan(300);
    const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(decided!.status).toBe('approved');
  });

  it('the named approver (a non-admin member) can decide via their own session', async () => {
    await createRule({ approverId: memberId });
    const rec = await createRecordAndSettle('Member is the approver');
    const approval = await pendingApprovalFor(rec.id);

    const res = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/reject`, {}, member.token);
    expect(res.statusCode).toBeLessThan(300);
    const decided = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(decided!.status).toBe('rejected');
    expect(decided!.decidedBy).toBe(memberId);
  });

  it('expiry sweep flips a stale pending approval to expired, posts an audit comment, and never enqueues a job', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Will expire');
    const approval = await pendingApprovalFor(rec.id);

    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, approval.id));
    await approvalsService.expireStale();

    const after = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(after!.status).toBe('expired');
    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) });
    expect(jobRows).toHaveLength(0);
    const commentRows = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(commentRows.data.some((c: { body: Array<{ text: string }> }) => c.body[0]!.text.includes('Expired'))).toBe(true);
  });

  it('approving (or rejecting) an already-decided approval is a no-op, not an error', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Already decided');
    const approval = await pendingApprovalFor(rec.id);
    const first = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/reject`);
    expect(first.statusCode).toBeLessThan(300);
    const second = await inject('POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`);
    expect(second.statusCode).toBeLessThan(300);
    // The second call didn't flip a rejected approval to approved.
    const after = await db.query.approvals.findFirst({ where: eq(approvals.id, approval.id) });
    expect(after!.status).toBe('rejected');
    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.approvalId, approval.id) });
    expect(jobRows).toHaveLength(0);
  });

  it('GET .../approvals lists and filters by status', async () => {
    await createRule();
    const rec = await createRecordAndSettle('Listable');
    const approval = await pendingApprovalFor(rec.id);
    const all = (await inject('GET', `/workspaces/${wsId}/approvals`)).json();
    expect(all.some((a: { id: string }) => a.id === approval.id)).toBe(true);
    const pendingOnly = (await inject('GET', `/workspaces/${wsId}/approvals?status=pending`)).json();
    expect(pendingOnly.every((a: { status: string }) => a.status === 'pending')).toBe(true);
    expect(pendingOnly.some((a: { id: string }) => a.id === approval.id)).toBe(true);
  });
});
