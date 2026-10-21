import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationRuns } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';

/**
 * ticket #1009 — three things the Automation runs page needs from the API:
 *  1. a run that is waiting for a person says so. The run row is closed as `ok` the moment its actions are queued, so a run with an
 *     undecided approval read "ok" (the page would say Succeeded about something that has not happened);
 *  2. the number waiting is exact: `GET /approvals` is capped at 100 rows and says nothing when it was cut;
 *  3. "Run again" for a whole run (the only re-run before was one FAILED action).
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let owner: { token: string };
let ws: string, dbA: string, dbB: string;
const as = (t: string, method: string, url: string, payload?: unknown) => call(app, t, method, url, payload);
const own = (method: string, url: string, payload?: unknown) => as(owner.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  owner = await signUpUser(app, 'Runs Owner');
  ws = (await own('POST', '/workspaces', { name: 'Runs WS' })).json().id;
  const space = (await own('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  dbA = (await own('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tickets' })).json().id;
  dbB = (await own('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Other' })).json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

async function rule(database: string, over: Record<string, unknown> = {}) {
  const res = await own('POST', `/workspaces/${ws}/databases/${database}/automations`, {
    name: `Gated ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'add_comment', body_template: 'Hello {Name}', require_approval: true }],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string };
}
async function newRecord(database: string, name: string) {
  const rec = (await own('POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name } })).json() as { id: string };
  await engine.settle(rec.id);
  return rec.id;
}
const runsOf = async (ruleId: string, query = '') => ((await own('GET', `/workspaces/${ws}/runs?rule_id=${ruleId}${query}`)).json().data as Array<{ id: string; status: string; awaiting_approval_count: number }>);
const approvalOf = async (recordId: string, ruleId: string) => (await db.query.approvals.findMany({ where: eq(approvals.recordId, recordId) })).find((a) => a.ruleId === ruleId)!;

describe('#1009 a run waiting for approval says so', () => {
  it('REPRODUCTION: the run is stored ok, but it reads awaiting_approval (list and detail) until the approval is decided', async () => {
    const r = await rule(dbA);
    const rec = await newRecord(dbA, 'Widget');
    const [run] = await runsOf(r.id);
    expect(run).toMatchObject({ status: 'awaiting_approval', awaiting_approval_count: 1 });
    expect((await db.query.automationRuns.findFirst({ where: eq(automationRuns.id, run!.id) }))!.status, 'stored as ok: the status is derived').toBe('ok');
    const detail = (await own('GET', `/workspaces/${ws}/runs/${run!.id}`)).json();
    expect(detail).toMatchObject({ status: 'awaiting_approval', awaiting_approval_count: 1 });
    // decided: it is an ordinary ok run again
    const approval = await approvalOf(rec, r.id);
    expect((await own('POST', `/workspaces/${ws}/approvals/${approval.id}/approve`)).statusCode).toBe(201);
    expect((await runsOf(r.id))[0]).toMatchObject({ status: 'ok', awaiting_approval_count: 0 });
    expect((await own('GET', `/workspaces/${ws}/runs/${run!.id}`)).json()).toMatchObject({ status: 'ok', awaiting_approval_count: 0 });
  });

  it('rejecting it also ends the waiting; an approval past its expiry no longer counts as waiting', async () => {
    const r = await rule(dbA);
    const rec = await newRecord(dbA, 'Rejected one');
    expect((await runsOf(r.id))[0]!.status).toBe('awaiting_approval');
    const approval = await approvalOf(rec, r.id);
    expect((await own('POST', `/workspaces/${ws}/approvals/${approval.id}/reject`, { reason: 'no' })).statusCode).toBe(201);
    expect((await runsOf(r.id))[0]!.status).toBe('ok');

    const r2 = await rule(dbA);
    const rec2 = await newRecord(dbA, 'Stale one');
    const a2 = await approvalOf(rec2, r2.id);
    await db.update(approvals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, a2.id)); // still 'pending' in the table, not yet swept
    expect((await runsOf(r2.id))[0], 'nobody can decide it any more').toMatchObject({ status: 'ok', awaiting_approval_count: 0 });
  });

  it('the status filter agrees: awaiting_approval returns only waiting runs, ok returns the rest, and an ungated run is plain ok', async () => {
    const gated = await rule(dbA);
    const plain = await rule(dbA, { actions: [{ type: 'add_comment', body_template: 'no gate' }] });
    await newRecord(dbA, 'Mixed');
    const waiting = (await own('GET', `/workspaces/${ws}/runs?status=awaiting_approval&limit=200`)).json().data as Array<{ id: string; rule_id: string; status: string }>;
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((x) => x.status === 'awaiting_approval')).toBe(true);
    expect(waiting.some((x) => x.rule_id === gated.id)).toBe(true);
    expect(waiting.some((x) => x.rule_id === plain.id)).toBe(false);
    const ok = (await own('GET', `/workspaces/${ws}/runs?status=ok&limit=200`)).json().data as Array<{ rule_id: string; status: string }>;
    expect(ok.every((x) => x.status === 'ok')).toBe(true);
    expect(ok.some((x) => x.rule_id === plain.id)).toBe(true);
    expect(ok.some((x) => x.rule_id === gated.id), 'a waiting run is NOT an ok run').toBe(false);
  });
});

describe('#1009 the waiting count is exact', () => {
  it('GET /approvals/count counts past the 100-row cap the list stops at, and agrees with status=pending', async () => {
    const w = (await own('POST', '/workspaces', { name: 'Count WS' })).json().id as string;
    const space = (await own('GET', `/workspaces/${w}/spaces`)).json()[0].id;
    const d = (await own('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'T' })).json().id as string;
    const snapshot = { type: 'add_comment', ctx: { databaseId: d, workspaceId: w } };
    await db.insert(approvals).values(Array.from({ length: 105 }, (_, i) => ({ workspaceId: w, actionIndex: i, actionSnapshot: snapshot, previewText: `p${i}`, status: 'pending' })));
    await db.insert(approvals).values({ workspaceId: w, actionIndex: 0, actionSnapshot: snapshot, previewText: 'done', status: 'approved' });
    await db.insert(approvals).values({ workspaceId: w, actionIndex: 0, actionSnapshot: snapshot, previewText: 'stale', status: 'pending', expiresAt: new Date(Date.now() - 1000) });
    expect((await own('GET', `/workspaces/${w}/approvals?status=pending`)).json()).toHaveLength(100);
    expect((await own('GET', `/workspaces/${w}/approvals/count?status=pending`)).json()).toEqual({ total: 105 });
    expect((await own('GET', `/workspaces/${w}/approvals/count?status=approved`)).json()).toEqual({ total: 1 });
    expect((await own('GET', `/workspaces/${w}/approvals/count`)).json().total, 'no filter: every status').toBe(107);
  });

  it('a guest is counted only on the databases they can see', async () => {
    const w = (await own('POST', '/workspaces', { name: 'Count Guest WS' })).json().id as string;
    const space = (await own('GET', `/workspaces/${w}/spaces`)).json()[0].id;
    const seen = (await own('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Seen' })).json().id as string;
    const hidden = (await own('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Hidden' })).json().id as string;
    const empty = (await own('POST', `/workspaces/${w}/databases`, { space_id: space, name: 'Empty' })).json().id as string;
    const mk = (d: string, n: number) => Array.from({ length: n }, (_, i) => ({ workspaceId: w, actionIndex: i, actionSnapshot: { type: 'add_comment', ctx: { databaseId: d, workspaceId: w } }, previewText: 'x', status: 'pending' }));
    await db.insert(approvals).values([...mk(seen, 3), ...mk(hidden, 5)]);
    const guest = await joinAs(app, owner.token, w, 'Count Guest', 'guest', [{ database_id: seen, role: 'viewer' }]);
    expect((await as(guest.token, 'GET', `/workspaces/${w}/approvals/count?status=pending`)).json()).toEqual({ total: 3 });
    expect((await as(guest.token, 'GET', `/workspaces/${w}/approvals?status=pending`)).json()).toHaveLength(3);
    const nobody = await joinAs(app, owner.token, w, 'Count Nobody', 'guest', [{ database_id: empty, role: 'viewer' }]);
    expect((await as(nobody.token, 'GET', `/workspaces/${w}/approvals/count?status=pending`)).json()).toEqual({ total: 0 });
    expect((await own('GET', `/workspaces/${w}/approvals/count?status=pending`)).json()).toEqual({ total: 8 });
  });
});

describe('#1009 Run again', () => {
  it('runs the rule once more on the same record as a NEW run; the original is untouched and the new one is awaiting approval too', async () => {
    const r = await rule(dbA);
    await newRecord(dbA, 'Again');
    const [original] = await runsOf(r.id);
    const res = await own('POST', `/workspaces/${ws}/runs/${original!.id}/rerun`);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'awaiting_approval', awaiting_approval_count: 1, original_run_id: original!.id });
    expect(body.run_id).not.toBe(original!.id);
    const runs = await runsOf(r.id);
    expect(runs).toHaveLength(2);
    expect(runs.map((x) => x.id).sort()).toEqual([original!.id, body.run_id].sort());
    expect((await db.query.automationRuns.findFirst({ where: eq(automationRuns.id, original!.id) }))!.status).toBe('ok');
    const record = (await db.query.approvals.findMany({ where: eq(approvals.ruleId, r.id) }));
    expect(record).toHaveLength(2); // one approval per run: the second run asks again
  });

  it('refuses what cannot be replayed honestly: no trigger record (422), a record_linked rule (422), a disabled rule (409), a condition that no longer matches (409)', async () => {
    // no trigger record: a webhook-style run row
    const r = await rule(dbA);
    const webhookRun = randomUUID();
    await db.insert(automationRuns).values({ id: webhookRun, automationId: r.id, workspaceId: ws, triggerRecordId: null, status: 'ok', depth: 0, durationMs: 1 });
    const noRecord = await own('POST', `/workspaces/${ws}/runs/${webhookRun}/rerun`);
    expect(noRecord.statusCode, noRecord.body).toBe(422);
    expect(noRecord.json().error.message).toMatch(/no trigger record/);

    const relation = (await own('POST', `/workspaces/${ws}/relations`, { database_a_id: dbA, database_b_id: dbB, cardinality: 'one_to_many', field_a_name: 'Others', field_b_name: 'Ticket' })).json();
    const linked = await rule(dbA, { trigger: { type: 'record_linked', relation_field_id: relation.field_a.id, direction: 'link' }, actions: [{ type: 'add_comment', body_template: 'l' }] });
    const linkedRun = randomUUID();
    const host = await newRecord(dbA, 'Linked host');
    await db.insert(automationRuns).values({ id: linkedRun, automationId: linked.id, workspaceId: ws, triggerRecordId: host, status: 'ok', depth: 0, durationMs: 1 });
    const linkedRes = await own('POST', `/workspaces/${ws}/runs/${linkedRun}/rerun`);
    expect(linkedRes.statusCode, linkedRes.body).toBe(422);
    expect(linkedRes.json().error.message).toMatch(/record linked/);

    const off = await rule(dbA);
    await newRecord(dbA, 'Disabled later');
    const [offRun] = await runsOf(off.id);
    expect((await own('PATCH', `/workspaces/${ws}/databases/${dbA}/automations/${off.id}`, { enabled: false })).statusCode).toBe(200);
    expect((await own('POST', `/workspaces/${ws}/runs/${offRun!.id}/rerun`)).statusCode).toBe(409);

    const picky = await rule(dbA, { condition: { and: [{ field: 'name', op: 'contains', value: 'Widgetry' }] } });
    const rec = await newRecord(dbA, 'Widgetry one');
    const [pickyRun] = await runsOf(picky.id);
    expect(pickyRun).toBeTruthy();
    await own('PATCH', `/workspaces/${ws}/databases/${dbA}/records/${rec}`, { values: { name: 'Renamed' } });
    const gone = await own('POST', `/workspaces/${ws}/runs/${pickyRun!.id}/rerun`);
    expect(gone.statusCode, gone.body).toBe(409);
    expect(gone.json().error.message).toMatch(/no longer matches/);
    expect(await runsOf(picky.id), 'nothing ran, nothing was recorded').toHaveLength(1);
  });

  it('needs editor on the trigger record and the write scope; another workspace\'s run is 404', async () => {
    const r = await rule(dbB);
    await newRecord(dbB, 'Guarded');
    const [run] = await runsOf(r.id);
    const viewer = await joinAs(app, owner.token, ws, 'Runs Viewer', 'guest', [{ database_id: dbB, role: 'viewer' }]);
    expect([403, 404]).toContain((await as(viewer.token, 'POST', `/workspaces/${ws}/runs/${run!.id}/rerun`)).statusCode);
    const stranger = await signUpUser(app, 'Runs Stranger');
    expect((await as(stranger.token, 'POST', `/workspaces/${ws}/runs/${run!.id}/rerun`)).statusCode).toBe(404);
    const pat = (await own('POST', '/me/tokens', { name: 'ro', workspace_id: ws, scope: 'read' })).json().token as string;
    expect((await as(pat, 'POST', `/workspaces/${ws}/runs/${run!.id}/rerun`)).statusCode).toBe(403);
    expect(await runsOf(r.id), 'none of the refused calls ran anything').toHaveLength(1);
  });
});

describe('#1011 one status vocabulary: the rule page\'s history and the runs page agree', () => {
  const ruleRuns = async (ruleId: string) => ((await own('GET', `/workspaces/${ws}/databases/${dbA}/automations/${ruleId}/runs`)).json().data as Array<{ id: string; status: string; awaitingApprovalCount: number; effects: unknown }>);

  it('GET /automations/:id/runs reads the same status as GET /runs for the same run, before and after the approval is decided', async () => {
    const r = await rule(dbA);
    const rec = await newRecord(dbA, 'Rule page');
    const [fromList] = await runsOf(r.id);
    const [fromRule] = await ruleRuns(r.id);
    expect(fromRule!.id).toBe(fromList!.id);
    expect(fromRule).toMatchObject({ status: 'awaiting_approval', awaitingApprovalCount: 1 });
    expect(fromRule!.status).toBe(fromList!.status);
    const approval = await approvalOf(rec, r.id);
    expect((await own('POST', `/workspaces/${ws}/approvals/${approval.id}/approve`)).statusCode).toBe(201);
    const [afterList] = await runsOf(r.id);
    const [afterRule] = await ruleRuns(r.id);
    expect(afterRule).toMatchObject({ status: 'ok', awaitingApprovalCount: 0 });
    expect(afterRule!.status).toBe(afterList!.status);
  });

  it('every other status is as stored, the stored columns are still there, and it is one derivation for both endpoints', async () => {
    const r = await rule(dbA, { actions: [{ type: 'add_comment', body_template: 'plain' }] });
    await newRecord(dbA, 'Plain rule page');
    const [run] = await ruleRuns(r.id);
    expect(run).toMatchObject({ status: 'ok', awaitingApprovalCount: 0 });
    expect(Object.keys(run!)).toEqual(expect.arrayContaining(['id', 'automationId', 'triggerRecordId', 'effects', 'durationMs', 'createdAt']));
    const errored = randomUUID();
    await db.insert(automationRuns).values({ id: errored, automationId: r.id, workspaceId: ws, triggerRecordId: null, status: 'error', error: 'boom', depth: 0, durationMs: 1 });
    expect((await ruleRuns(r.id)).find((x) => x.id === errored)!.status).toBe('error');
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/automations/automations.service.ts', import.meta.url), 'utf8');
    expect(src, 'the rule history must use the shared derivation').toContain("from './run-status'");
    expect(src).not.toMatch(/AWAITING_APPROVAL|'awaiting_approval'/);
  });
});
