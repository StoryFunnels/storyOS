import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automationJobs, automationRuns, automations } from '../src/db/schema';

/**
 * #474 phase 12 — automation run history for a guest whose only access to a
 * database is one or more record-scoped grants (#472).
 *
 * `RunsService` used to carry its OWN, independent copy of guest-visibility
 * (a hand-rolled space->database walk, database granularity only, never
 * consulting a record-scoped grant at all) — so a record-scoped-only guest
 * saw NO runs whatsoever, not even for their own granted record's
 * automation (under-widening, same class phase 4 fixed for search/my-work/
 * recent). `detail()` also returned `record_ref` (a run's trigger record's
 * title/number) with only a DATABASE-level check, and `rerun()`'s access
 * check (`DatabasesService.assertAccess`'s record-scoped fallback) only
 * verified the guest held ANY record grant in the database, never that it
 * covered the SPECIFIC run's trigger record — the same over-widening class
 * backlinks' target-record gate had (phase 5).
 *
 * THIS IS A SECURITY BOUNDARY: every assertion uses a real guest with a
 * real record-scoped grant.
 */
let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let dbId: string;
let recGranted: string;
let recDenied: string;
let ruleId: string;
let runGranted: string;
let runDenied: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'RunScopeOwner');
  guest = await signUpUser(app, 'RunScopeGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p12 Runs WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Briefs' })).json().id;

  recGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Granted Brief' } })).json().id;
  recDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Denied Brief' } })).json().id;

  const [rule] = await db
    .insert(automations)
    .values({
      databaseId: dbId,
      name: '474p12 rule',
      trigger: { type: 'record_created' },
      actions: [],
      createdBy: admin.email,
    })
    .returning();
  ruleId = rule!.id;

  const [runG] = await db
    .insert(automationRuns)
    .values({ automationId: ruleId, workspaceId: wsId, triggerRecordId: recGranted, status: 'ok', depth: 0, durationMs: 5 })
    .returning();
  runGranted = runG!.id;
  const [runD] = await db
    .insert(automationRuns)
    .values({ automationId: ruleId, workspaceId: wsId, triggerRecordId: recDenied, status: 'ok', depth: 0, durationMs: 5 })
    .returning();
  runDenied = runD!.id;

  // Record-scoped-only: no space/database grant anywhere.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: recGranted, role: 'editor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

async function failedJob(runId: string, kind: string) {
  const [job] = await db
    .insert(automationJobs)
    .values({
      workspaceId: wsId,
      ruleId,
      runId,
      actionIndex: 0,
      kind,
      payload: { frozen: true },
      idempotencyKey: `474p12:${runId}:0`,
      status: 'failed',
      lastError: 'boom',
    })
    .returning();
  return job!;
}

describe('#474 phase 12 — run list for a record-scoped-only guest', () => {
  it('includes the run triggered by the granted record, never the sibling', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/runs?rule_id=${ruleId}`);
    expect(res.statusCode, res.body).toBe(200);
    const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(runGranted);
    expect(ids).not.toContain(runDenied);
  });

  it('the admin (unrestricted) sees both runs', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/runs?rule_id=${ruleId}`);
    const ids = (res.json().data as Array<{ id: string }>).map((r) => r.id);
    // Inclusion, not a closed-set equality: this runs inside the full suite,
    // where the workspace-wide `automations` tick (setInterval, 60s) can be
    // mid-flight against other files' fixtures at the same instant — nothing
    // to do with per-record scoping, so asserting admin sees AT LEAST both
    // (same style runs.test.ts's own admin assertions use) is the real claim.
    expect(ids).toEqual(expect.arrayContaining([runGranted, runDenied]));
  });
});

describe('#474 phase 12 — run detail for a record-scoped-only guest', () => {
  it("reads the granted record's run, with the correct record_ref", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/runs/${runGranted}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().record_ref).toMatchObject({ id: recGranted });
  });

  it("CANNOT read the denied sibling's run in the same otherwise-invisible database", async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/runs/${runDenied}`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the admin (unrestricted) still reads both unchanged', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/runs/${runDenied}`);
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe('#474 phase 12 — rerun is gated on the run\'s OWN trigger record, not just "any grant in this database"', () => {
  it('the guest can re-run a failed action on their own granted record\'s run', async () => {
    const job = await failedJob(runGranted, `test.474p12.${runGranted}`);
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/runs/${runGranted}/actions/0/rerun`);
    expect(res.statusCode, res.body).toBe(201);
    expect(job.status).toBe('failed'); // sanity: the insert above succeeded
  });

  it("the guest CANNOT re-run the denied sibling's failed action, despite holding an editor grant elsewhere in the same database", async () => {
    await failedJob(runDenied, `test.474p12.${runDenied}`);
    const res = await as(guest.token, 'POST', `/workspaces/${wsId}/runs/${runDenied}/actions/0/rerun`);
    expect(res.statusCode, res.body).toBe(404);
  });

  it('the admin (unrestricted) can still re-run the denied run\'s failed action', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/runs/${runDenied}/actions/0/rerun`);
    expect(res.statusCode, res.body).toBe(201);
  });
});
