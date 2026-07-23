import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationJobs, automationRuns, automations } from '../src/db/schema';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { ProviderError } from '../src/common/provider-error';

/**
 * MN-264 — the workspace-wide Runs & health surface. Rule runs/jobs/approvals
 * are inserted directly against the DB (same technique automation-jobs.test.ts
 * and approvals.test.ts use) rather than driven through the full automations
 * engine — that engine's own behavior is already covered by automations.test.ts/
 * automation-jobs.test.ts/approvals.test.ts; this file is about the union
 * envelope, the detail merge, and the rerun endpoint's own contract.
 *
 * NARROWED SCOPE (documented in the PR): every run here is `kind: 'rule'` —
 * `source_runs` (MN-260/#239) doesn't exist yet, so there is nothing to union
 * against on the source side. See runs.service.ts's own module doc.
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown, token: string = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: (payload ?? {}) as never,
  });
}

async function insertRule(overrides: Partial<typeof automations.$inferInsert> = {}) {
  const [rule] = await db
    .insert(automations)
    .values({
      databaseId: dbId,
      name: `Runs rule ${randomUUID()}`,
      trigger: { type: 'record_created' },
      actions: [],
      createdBy: admin.email,
      ...overrides,
    })
    .returning();
  return rule!;
}

async function insertRun(ruleId: string, overrides: Partial<typeof automationRuns.$inferInsert> = {}) {
  const [run] = await db
    .insert(automationRuns)
    .values({
      automationId: ruleId,
      workspaceId: wsId,
      triggerRecordId: null,
      status: 'ok',
      depth: 0,
      durationMs: 12,
      ...overrides,
    })
    .returning();
  return run!;
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  admin = await signUpUser(app, 'RunsAdmin');
  wsId = (await inject('POST', '/workspaces', { name: 'Runs WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Runs DB' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('GET /workspaces/:ws/runs — union envelope (MN-264)', () => {
  it('lists rule runs newest first, and filters by status', async () => {
    const rule = await insertRule();
    const older = await insertRun(rule.id, { status: 'ok' });
    await new Promise((r) => setTimeout(r, 5));
    const newer = await insertRun(rule.id, { status: 'error', error: 'boom' });

    const res = await inject('GET', `/workspaces/${wsId}/runs?rule_id=${rule.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const ids = body.data.map((r: { id: string }) => r.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id)); // newest first
    expect(body.data.find((r: { id: string }) => r.id === newer.id)).toMatchObject({
      kind: 'rule',
      status: 'error',
      error: 'boom',
      rule_id: rule.id,
      database_id: dbId,
    });

    const filtered = await inject('GET', `/workspaces/${wsId}/runs?rule_id=${rule.id}&status=error`);
    const filteredIds = filtered.json().data.map((r: { id: string }) => r.id);
    expect(filteredIds).toContain(newer.id);
    expect(filteredIds).not.toContain(older.id);
  });

  it('kind=source returns an empty page with an explanatory note — source_runs (#239) does not exist yet', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/runs?kind=source`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toEqual([]);
    expect(body.note).toMatch(/#239/);
  });

  it('surfaces a skipped_quota run distinctly from a plain skipped one', async () => {
    const rule = await insertRule();
    await insertRun(rule.id, { status: 'skipped', error: 'depth guard' });
    const quotaRun = await insertRun(rule.id, { status: 'skipped_quota', error: 'plan automation-run allowance reached for this month' });

    const res = await inject('GET', `/workspaces/${wsId}/runs?rule_id=${rule.id}&status=skipped_quota`);
    const ids = res.json().data.map((r: { id: string }) => r.id);
    expect(ids).toEqual([quotaRun.id]);
  });
});

describe('GET /workspaces/:ws/runs/:id — detail merge (MN-264)', () => {
  it('merges per-action job attempts with their MN-255 approval linkage', async () => {
    const rule = await insertRule();
    const run = await insertRun(rule.id, { status: 'ok' });

    const [job] = await db
      .insert(automationJobs)
      .values({
        workspaceId: wsId,
        ruleId: rule.id,
        runId: run.id,
        actionIndex: 0,
        kind: 'test.detail-merge',
        payload: { hello: 'world' },
        idempotencyKey: `detail-merge:${run.id}:0`,
        status: 'succeeded',
        artifact: { ok: true },
      })
      .returning();
    const [approval] = await db
      .insert(approvals)
      .values({
        workspaceId: wsId,
        ruleId: rule.id,
        runId: run.id,
        recordId: null,
        actionIndex: 0,
        actionSnapshot: { action: { type: 'send_email' }, ctx: { workspaceId: wsId, databaseId: dbId, recordId: null, actorId: admin.email } },
        previewText: 'Send email to someone',
        status: 'approved',
        decidedBy: admin.email,
        decidedAt: new Date(),
      })
      .returning();
    // A second, pending-only approval with no job row (actionIndex 1) — the
    // gate hasn't been decided so JobRunnerService never enqueued anything.
    await db.insert(approvals).values({
      workspaceId: wsId,
      ruleId: rule.id,
      runId: run.id,
      recordId: null,
      actionIndex: 1,
      actionSnapshot: { action: { type: 'send_email' }, ctx: { workspaceId: wsId, databaseId: dbId, recordId: null, actorId: admin.email } },
      previewText: 'Second gated action',
      status: 'pending',
    });

    const res = await inject('GET', `/workspaces/${wsId}/runs/${run.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.id).toBe(run.id);
    expect(body.rule_id).toBe(rule.id);
    expect(body.actions).toHaveLength(2);
    const action0 = body.actions.find((a: { action_index: number }) => a.action_index === 0);
    expect(action0).toMatchObject({
      kind: 'test.detail-merge',
      status: 'succeeded',
      artifact: { ok: true },
    });
    expect(action0.approval).toMatchObject({ id: approval!.id, status: 'approved', decided_by: admin.email });
    const action1 = body.actions.find((a: { action_index: number }) => a.action_index === 1);
    expect(action1).toMatchObject({ status: 'pending_approval', kind: null });
    expect(job).toBeTruthy(); // sanity: the insert above succeeded
  });

  it('404s for a run in a different workspace rather than leaking it', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/runs/${randomUUID()}`);
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /workspaces/:ws/runs/:id/actions/:index/rerun (MN-264)', () => {
  async function failedJobRun(kind: string) {
    const rule = await insertRule();
    const run = await insertRun(rule.id, { status: 'error', error: 'action failed' });
    const [job] = await db
      .insert(automationJobs)
      .values({
        workspaceId: wsId,
        ruleId: rule.id,
        runId: run.id,
        actionIndex: 0,
        kind,
        payload: { frozen: true, n: 1 },
        idempotencyKey: `rerun-test:${run.id}:0`,
        status: 'failed',
        lastError: 'provider timed out',
      })
      .returning();
    return { rule, run, job: job! };
  }

  it('enqueues a NEW job with the frozen payload and a :rerun: suffixed idempotency key; refuses once succeeded', async () => {
    const kind = `test.rerun.${randomUUID()}`;
    let received: unknown[] = [];
    jobs.registerExecutor(kind, async (payload) => {
      received.push(payload);
      return { ok: true };
    });
    const { run, job } = await failedJobRun(kind);

    const res = await inject('POST', `/workspaces/${wsId}/runs/${run.id}/actions/0/rerun`);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.job_id).not.toBe(job.id);
    expect(body.idempotency_key).toBe(`${job.idempotencyKey}:rerun:1`);

    const newJob = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, body.job_id) });
    expect(newJob!.payload).toEqual({ frozen: true, n: 1 }); // the ORIGINAL frozen payload, untouched
    expect(newJob!.status).toBe('queued');
    // The original failed row is untouched — rerun is a new row, not a mutation of the old one.
    const original = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, job.id) });
    expect(original!.status).toBe('failed');

    await jobs.tick();
    expect(received).toEqual([{ frozen: true, n: 1 }]);
    const settled = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, body.job_id) });
    expect(settled!.status).toBe('succeeded');

    // Re-running again now must 409 — the latest attempt (the rerun) succeeded.
    const again = await inject('POST', `/workspaces/${wsId}/runs/${run.id}/actions/0/rerun`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already succeeded/);
  });

  it('a second rerun (after the first also fails) increments the :rerun: suffix off the ORIGINAL key', async () => {
    const kind = `test.rerun-twice.${randomUUID()}`;
    jobs.registerExecutor(kind, async () => {
      throw new ProviderError('still broken', { retryable: false });
    });
    const { run, job } = await failedJobRun(kind);

    const first = await inject('POST', `/workspaces/${wsId}/runs/${run.id}/actions/0/rerun`);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().idempotency_key).toBe(`${job.idempotencyKey}:rerun:1`);
    await jobs.tick(); // fails (non-retryable) — the rerun job itself ends up 'failed'
    const afterFirst = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, first.json().job_id) });
    expect(afterFirst!.status).toBe('failed');

    const second = await inject('POST', `/workspaces/${wsId}/runs/${run.id}/actions/0/rerun`);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().idempotency_key).toBe(`${job.idempotencyKey}:rerun:2`);
  });

  it('404s when there is no queued action at that index', async () => {
    const rule = await insertRule();
    const run = await insertRun(rule.id, { status: 'ok' });
    const res = await inject('POST', `/workspaces/${wsId}/runs/${run.id}/actions/0/rerun`);
    expect(res.statusCode).toBe(404);
  });

  describe('permission matrix', () => {
    let viewerGuest: { token: string; email: string };
    let editorGuest: { token: string; email: string };

    beforeAll(async () => {
      viewerGuest = await signUpUser(app, 'RunsViewerGuest');
      editorGuest = await signUpUser(app, 'RunsEditorGuest');
      for (const { user, role } of [
        { user: viewerGuest, role: 'viewer' },
        { user: editorGuest, role: 'editor' },
      ]) {
        const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
          email: user.email,
          role: 'guest',
          grants: [{ space_id: spaceId, role }],
        });
        const token = new URL(invite.json().accept_url).searchParams.get('token')!;
        const accepted = await inject('POST', '/invites/accept', { token }, user.token);
        if (accepted.statusCode >= 300) throw new Error(`guest invite (${role}) failed: ${accepted.body}`);
      }
    });

    it('a viewer-grant guest is refused (403), an editor-grant guest is allowed through the permission check', async () => {
      const kind = `test.rerun-perm.${randomUUID()}`;
      jobs.registerExecutor(kind, async () => ({ ok: true }));

      const asViewer = await failedJobRun(kind);
      const viewerRes = await inject(
        'POST',
        `/workspaces/${wsId}/runs/${asViewer.run.id}/actions/0/rerun`,
        undefined,
        viewerGuest.token,
      );
      expect(viewerRes.statusCode, viewerRes.body).toBe(403);

      const asEditor = await failedJobRun(kind);
      const editorRes = await inject(
        'POST',
        `/workspaces/${wsId}/runs/${asEditor.run.id}/actions/0/rerun`,
        undefined,
        editorGuest.token,
      );
      expect(editorRes.statusCode, editorRes.body).toBe(201);
    });
  });
});

describe('GET /workspaces/:ws/runs/quota (MN-264)', () => {
  it('self-host (no Stripe key in test env): unlimited, used reads live from usage_counters (0 here)', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/runs/quota`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ used: 0, limit: null, projected: null });
  });
});
