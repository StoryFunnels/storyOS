import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, user } from '../src/db/schema';
import { TokensService } from '../src/tokens/tokens.service';
import { JobRunnerService } from '../src/automations/job-runner.service';

/**
 * #869 — a SECOND decision on an already-decided approval must be REFUSED, with a reason.
 *
 * Found in a browser (Vera, on the skill-publish approval): after a person Approves, the Inbox still
 * showed Approve/Reject, and clicking Reject returned 201 and toasted "Rejected" while the server
 * ignored it. `ApprovalsService.decide()` treated "already decided" as an idempotent no-op and the
 * controller returned the row as a success, so the person who realises too late and clicks Reject is
 * told they undid something that is still in force. MN-125's sentence applies: "a security control
 * that says 'done' and does nothing is the dangerous half."
 *
 * This is GENERIC to every approval kind that goes through `ApprovalsService.resolve()`, so it is
 * proven here on a plain action-class gate (a held delete), not on one producer. Both directions,
 * asserted on the RESPONSE and on the STORED row, and on what the approval was FOR (the record).
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let tokens: TokensService;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let dbId: string;

const call = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const alive = async (recordId: string) => (await call(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`)).statusCode === 200;
const status = async (id: string) => (await db.query.approvals.findFirst({ where: eq(approvals.id, id) }))!;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  tokens = app.get(TokensService);
  admin = await signUpUser(app, 'SecondDecision Admin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await call(admin.token, 'POST', '/workspaces', { name: '869' })).json().id;
  const spaceId = (await call(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await call(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Held' })).json().id;
});

afterAll(async () => {
  await app.close();
});

/** A held delete: gate policy on, an agent-origin token deletes a record, returns the approval + the record. */
async function held(name: string): Promise<{ approvalId: string; recordId: string }> {
  const policy = await call(admin.token, 'POST', `/workspaces/${wsId}/action-gates`, { action_class: 'delete_records', approver_id: adminId });
  expect(policy.statusCode, policy.body).toBeLessThan(300);
  const rec = (await call(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name } })).json().id as string;
  const agent = (await tokens.create(adminId, wsId, `proposer-${name}`, 'admin', true, 'agent')).token;
  const res = await call(agent, 'DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${rec}`);
  expect(res.json().pending_approval, res.body).toBe(true);
  await call(admin.token, 'DELETE', `/workspaces/${wsId}/action-gates/${policy.json().id}`);
  return { approvalId: res.json().approval_id as string, recordId: rec };
}

describe('#869 — a decided approval cannot be decided the other way', () => {
  it('Reject AFTER Approve: refused with a reason; the approval stays approved; what it approved really happened (the record is gone)', async () => {
    const { approvalId, recordId } = await held('approve then reject');
    expect((await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();
    expect(await alive(recordId), 'the approved delete was applied').toBe(false);

    const late = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'changed my mind' });
    expect(late.statusCode, `must be refused, not a silent success: ${late.body}`).toBeGreaterThanOrEqual(400);
    expect(late.statusCode).toBeLessThan(500);
    expect(late.json().error.message, 'names the reason').toMatch(/already approved/i);
    const row = await status(approvalId);
    expect(row.status, 'stored: still approved, the reject did not rewrite history').toBe('approved');
    expect(row.reason, 'and the late reason was not recorded').toBeNull();
  });

  it('Approve AFTER Reject: refused with a reason; stays rejected; the record is NOT deleted, even after a job tick', async () => {
    const { approvalId, recordId } = await held('reject then approve');
    expect((await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`, { reason: 'no' })).statusCode).toBeLessThan(300);
    const late = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(late.statusCode, late.body).toBeGreaterThanOrEqual(400);
    expect(late.statusCode).toBeLessThan(500);
    expect(late.json().error.message).toMatch(/already rejected/i);
    await jobs.tick();
    expect((await status(approvalId)).status, 'stored: still rejected').toBe('rejected');
    expect(await alive(recordId), 'the rejected delete must never run').toBe(true);
  });

  it('the SAME decision twice stays idempotent (a double click is not an error), and runs the action once', async () => {
    const { approvalId, recordId } = await held('double approve');
    const first = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    const second = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(second.statusCode, second.body).toBeLessThan(300);
    expect(second.json().status).toBe('approved');
    await jobs.tick();
    expect(await alive(recordId)).toBe(false);
    const again = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`);
    expect(again.statusCode, 'and a late opposite decision is still refused after the double approve').toBeGreaterThanOrEqual(400);
  });

  it('an EXPIRED approval refuses both decisions with the reason', async () => {
    const { approvalId, recordId } = await held('expired');
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, approvalId));
    const a = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/approve`);
    expect(a.statusCode, a.body).toBeGreaterThanOrEqual(400);
    const r = await call(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approvalId}/reject`);
    expect(r.statusCode, r.body).toBeGreaterThanOrEqual(400);
    expect(r.json().error.message).toMatch(/expired/i);
    expect(await alive(recordId)).toBe(true);
  });
});
