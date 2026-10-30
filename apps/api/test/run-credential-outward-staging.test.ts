import 'reflect-metadata';
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { connections } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { EmailService } from '../src/mail/email.service';
import { ConnectionsService } from '../src/connections/connections.service';
import { SlackService } from '../src/integrations/slack.service';
import { WebhooksService } from '../src/webhooks/webhooks.service';import { JobRunnerService } from '../src/automations/job-runner.service';
import { AutomationsService } from '../src/automations/automations.service';
import { AutomationActionsService } from '../src/automations/actions.service';
import { BulkRecordJobsService } from '../src/records/bulk-record-jobs.service';
import { WriteBackSubscriber } from '../src/sources/write-back.subscriber';
import { DomainEventsService } from '../src/events/domain-events.service';
import { currentEventOrigin } from '../src/common/credential-context';
import { agentOriginHoldsAction, OUTWARD_AUTOMATION_ACTION_TYPES } from '../src/action-gates/action-classes';
import type { ConnectionFetcher } from '../src/connections/providers';

/**
 * #1174 — an agent's writes (a RUN CREDENTIAL, #1132) must not fire an admin-configured OUTWARD automation action with no person
 * approving it (ADR-0021 §7). Found by the #1135 audit (docs/architecture/runner-outward-tool-audit.md, finding F1).
 *
 * Every test uses the audit's REAL fixture (a Runner paired and a wake claimed over HTTP: the credential is the one production
 * mints) and watches the real sinks: the Resend/Slack/webhook/http seams and the rows an outward effect would leave. A person
 * making the same write is the CONTROL in each case, so a "nothing was sent" cannot be a fixture that could not have seen it.
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
const { db, pool } = connectTestDb();

const sinks = { mails: [] as Array<{ kind?: string; to?: string }>, resend: [] as Array<{ to: string[]; subject: string }>, slack: [] as Array<Record<string, unknown>>, webhook: [] as string[], http: [] as string[] };

beforeAll(async () => {
  app = await createTestApp();
  app.get(EmailService).driver = { name: 'spy', send: async (m) => { sinks.mails.push(m as never); } };
  (app.get(ConnectionsService) as { fetcher: unknown }).fetcher = async (url: string, init: { body?: string }) => {
    if (url.endsWith('/emails')) { sinks.resend.push(JSON.parse(init.body ?? '{}')); return { status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' }; }
    return { status: 200, json: async () => ({ data: [] }), text: async () => '' };
  };
  vi.spyOn(SlackService.prototype, 'sendMessage') // the prototype: CommentsService and ActionsService may each hold their own instance
  .mockImplementation((async (_ws: string, msg: Record<string, unknown>) => { sinks.slack.push(msg); return { channel: 'C1', ts: '1' }; }) as never);
  vi.spyOn(app.get(WebhooksService), 'sendNow').mockImplementation((async (id: string) => { sinks.webhook.push(id); return { ok: true, statusCode: 200 }; }) as never);
  for (const lib of [http, https]) vi.spyOn(lib, 'request').mockImplementation(((...a: unknown[]) => { sinks.http.push(String(a[0])); throw new Error('blocked'); }) as never);
  w = await buildRunCredentialWorld(app, pool, 'Staging1174');
}, 180_000);

afterAll(async () => {
  // the webhook scan and flush are GLOBAL across the shared test database: leave no subscription behind for another file's tick
  await pool.query("delete from webhook_subscriptions where url like 'https://staging-1174.invalid/%'");
  vi.restoreAllMocks();
  await app.close();
  await pool.end();
});

async function resendConnection(): Promise<string> {
  const adminRow = await pool.query('select id from "user" where email = $1', [w.admin.email]);
  const [conn] = await db
    .insert(connections)
    .values({ workspaceId: w.ws, provider: 'resend', name: `Resend ${randomUUID()}`, authSealed: seal(JSON.stringify({ api_key: 're_test', from_address: 'a@example.com' })), scopes: ['domain:example.com', 'from:a@example.com'], status: 'active', createdBy: adminRow.rows[0].id })
    .returning();
  return conn!.id;
}

/** A fresh database with an Email field, one rule on record_updated with `actions`, and one record. */
async function world(actions: (conn: string) => unknown[]) {
  const dbRes = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: `Leads ${randomUUID()}` });
  const dbId = dbRes.json().id as string;
  const emailApi = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, { display_name: 'Email', type: 'text', config: {} })).json().apiName as string;
  const conn = await resendConnection();
  const list = actions(conn);
  // no actions = no rule at all (a rule needs at least one action): a world for the destinations that need none
  const rule = list.length ? await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, { name: 'notify', trigger: { type: 'record_updated' }, actions: list }) : { statusCode: 201, body: '', json: () => ({ id: '' }) };
  expect(rule.statusCode, rule.body).toBe(201);
  const rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/records`, { values: { name: 'Lead' } })).json().id as string;
  return { dbId, emailApi, ruleId: rule.json().id as string, rec, conn };
}
const patch = (token: string, wd: { dbId: string; rec: string; emailApi: string }, email: string) =>
  w.as(token, 'PATCH', `/workspaces/${w.ws}/databases/${wd.dbId}/records/${wd.rec}`, { values: { [wd.emailApi]: email } });
const settle = async (rec: string) => { await app.get(AutomationsService).settle(rec); await app.get(JobRunnerService).tick(); };
const approvalsOf = async (ruleId: string) => (await pool.query("select id, status, preview_text, action_snapshot from approvals where rule_id = $1 order by created_at", [ruleId])).rows as Array<{ id: string; status: string; preview_text: string; action_snapshot: { action: Record<string, unknown>; ctx: { origin?: Record<string, unknown> } } }>;
const emailAction = (conn: string, to = '{Email}', extra: Record<string, unknown> = {}) => ({ type: 'send_email', connection_id: conn, to, subject: 'Hello', body_markdown: 'Body', require_approval: false, ...extra });

describe('1. the audit repro: a run credential write no longer fires an ungated send_email to an outsider', () => {
  it('stages an approval naming the agent and the run; nothing is sent until a person approves; then it is sent', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;

    const agent = await patch(w.credential, wd, 'outsider@external.example');
    expect(agent.statusCode, agent.body).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend, 'no mail left StoryOS on the agent\'s write').toHaveLength(0);
    const rows = await approvalsOf(wd.ruleId);
    expect(rows, 'one pending approval').toHaveLength(1);
    expect(rows[0]!.status).toBe('pending');
    expect(rows[0]!.preview_text, 'the card names the agent').toContain('Staging1174 bot');
    expect(rows[0]!.preview_text, 'the card names the run').toMatch(/run/i);
    expect(rows[0]!.action_snapshot.ctx.origin).toMatchObject({ agentId: w.agentId, agentName: 'Staging1174 bot', runnerName: 'audit machine' });
    const card = (await w.as(w.admin.token, 'GET', `/workspaces/${w.ws}/approvals`)).json();
    const listed = (card.data ?? card).find((a: { id: string }) => a.id === rows[0]!.id);
    expect(listed.action_snapshot.ctx.origin, 'the API card names the agent, the run and the Runner').toMatchObject({ agent_id: w.agentId, agent_name: 'Staging1174 bot', runner_name: 'audit machine' });
    expect(listed.action_snapshot.ctx.origin.run_id).toBeTruthy();

    // the credential cannot decide it, a member who is not its approver cannot either, the admin can
    expect((await w.as(w.credential, 'POST', `/workspaces/${w.ws}/approvals/${rows[0]!.id}/approve`, {})).statusCode).toBe(403);
    expect((await w.as(w.owner.token, 'POST', `/workspaces/${w.ws}/approvals/${rows[0]!.id}/approve`, {})).statusCode).toBeGreaterThanOrEqual(403);
    await settle(wd.rec);
    expect(sinks.resend).toHaveLength(0);
    const ok = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${rows[0]!.id}/approve`, {});
    expect(ok.statusCode, ok.body).toBeLessThan(300);
    await settle(wd.rec);
    expect(sinks.resend, 'after a person approves, it is sent').toHaveLength(1);
    expect(sinks.resend[0]!.to).toEqual(['outsider@external.example']);
  });

  it('CONTROL: the same rule and the same write by a person sends, as the admin configured', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    expect((await patch(w.admin.token, wd, 'outsider@external.example')).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend).toHaveLength(1);
    expect(await approvalsOf(wd.ruleId)).toHaveLength(0);
  });
});

const jobsOf = async (ruleId: string, kind: string) => (await pool.query('select id, status, payload from automation_jobs where rule_id = $1 and kind = $2', [ruleId, kind])).rows as Array<{ id: string; status: string; payload: { ctx?: { origin?: Record<string, unknown> } } }>;
const approve = async (id: string) => { const r = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${id}/approve`, {}); expect(r.statusCode, r.body).toBeLessThan(300); };
const waitFor = async <T,>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> => {
  for (let i = 0; i < 40; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${label}`);
};
const outwardLog = async (type: string, agentId: string) => (await pool.query("select source, agent_id, agent_name, run_id, runner_id, runner_name, payload from activity_events where type = $1 and agent_id = $2 order by created_at desc", [type, agentId])).rows as Array<Record<string, unknown>>;
const optionId = async (label: string) => (await pool.query("select o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'approval_policy' and o.label = $2", [w.agentsDbId, label])).rows[0].id as string;
const setPolicy = async (labels: string[]) => {
  const ids = await Promise.all(labels.map(optionId));
  const r = await w.as(w.owner.token, 'PATCH', `/workspaces/${w.ws}/databases/${w.agentsDbId}/records/${w.agentId}`, { values: { approval_policy: ids } });
  expect(r.statusCode, r.body).toBe(200);
};

describe('2. member-only email is unchanged, and the origin survives the job queue', () => {
  it('an email to workspace members only is sent as configured; its queued job carries the agent origin', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    expect((await patch(w.credential, wd, w.admin.email)).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend, 'a member-only email is not held').toHaveLength(1);
    expect(await approvalsOf(wd.ruleId)).toHaveLength(0);
    const jobs = await jobsOf(wd.ruleId, 'send_email');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload.ctx?.origin, 'the persisted job payload (what a retry re-reads) names the agent run').toMatchObject({ agentId: w.agentId, runnerName: 'audit machine' });
  });

  it('a job payload origin is made ambient around the executor, and a job without one runs with none', async () => {
    const jobs = app.get(JobRunnerService);
    const seen: Array<unknown> = [];
    jobs.registerExecutor('probe_1174', async () => { seen.push(currentEventOrigin()); return {}; });
    const origin = { agentId: w.agentId, agentName: 'A', runId: null, runnerId: randomUUID(), runnerName: 'R' };
    await jobs.enqueue({ workspaceId: w.ws, ruleId: null, runId: null, connectionId: null, actionIndex: 0, kind: 'probe_1174', payload: { action: {}, ctx: { workspaceId: w.ws, origin } }, idempotencyKey: randomUUID() });
    await jobs.enqueue({ workspaceId: w.ws, ruleId: null, runId: null, connectionId: null, actionIndex: 0, kind: 'probe_1174', payload: { action: {}, ctx: { workspaceId: w.ws } }, idempotencyKey: randomUUID() });
    await jobs.tick(); await jobs.tick();
    expect(seen).toContainEqual(origin);
    expect(seen).toContainEqual(null);
  });
});

describe('3. the other outward kinds are staged too, and run after a person approves', () => {
  it('send_slack_message and send_webhook: staged naming the agent; nothing leaves; approving sends the frozen snapshot', async () => {
    const wd = await world(() => [
      { type: 'send_slack_message', text: 'New email {Email}', require_approval: false },
      { type: 'send_webhook', url: 'https://hooks.example.com/{Email}', require_approval: false },
    ]);
    sinks.slack.length = 0; sinks.webhook.length = 0;
    expect((await patch(w.credential, wd, 'a@b.example')).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.slack).toHaveLength(0);
    expect(sinks.webhook).toHaveLength(0);
    const rows = await approvalsOf(wd.ruleId);
    expect(rows.map((r) => r.action_snapshot.action['type']).sort()).toEqual(['send_slack_message', 'send_webhook']);
    for (const r of rows) expect(r.preview_text).toContain('Caused by agent "Staging1174 bot"');
    // the frozen webhook body is what the approver sees (no template: the default envelope, rendered NOW)
    expect(String(rows.find((r) => r.action_snapshot.action['type'] === 'send_webhook')!.action_snapshot.action['body_template'])).toContain('"record"');
    for (const r of rows) await approve(r.id);
    await settle(wd.rec);
    expect(sinks.slack, 'approving a gated Slack message sends it (it had no executor before)').toHaveLength(1);
    expect(String(sinks.slack[0]!['text'])).toContain('a@b.example');
    expect(sinks.webhook, 'approving a gated webhook sends it').toHaveLength(1);
  });

  it('CONTROL: the same rule fired by a person sends both inline, as configured', async () => {
    const wd = await world(() => [
      { type: 'send_slack_message', text: 'New email {Email}', require_approval: false },
      { type: 'send_webhook', url: 'https://hooks.example.com/x', require_approval: false },
    ]);
    sinks.slack.length = 0; sinks.webhook.length = 0;
    expect((await patch(w.admin.token, wd, 'a@b.example')).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.slack).toHaveLength(1);
    expect(sinks.webhook).toHaveLength(1);
    expect(await approvalsOf(wd.ruleId)).toHaveLength(0);
  });

  it('http_request: staged; approving enqueues its job from the snapshot', async () => {
    const wd = await world(() => [{ type: 'http_request', method: 'POST', url: 'https://api.example.com/x?e={Email}', require_approval: false }]);
    expect((await patch(w.credential, wd, 'a@b.example')).statusCode).toBe(200);
    await settle(wd.rec);
    const rows = await approvalsOf(wd.ruleId);
    expect(rows).toHaveLength(1);
    expect(await jobsOf(wd.ruleId, 'http_request'), 'no job before approval').toHaveLength(0);
    await approve(rows[0]!.id);
    expect(await jobsOf(wd.ruleId, 'http_request'), 'the approval enqueued it').toHaveLength(1);
  });

  it('send_email to a FIXED outside address is staged (not only a recipient taken from a field); one outsider among members holds the whole email', async () => {
    const wd = await world((conn) => [emailAction(conn, 'sales@external.example')]);
    sinks.resend.length = 0;
    expect((await patch(w.credential, wd, 'whatever@x.example')).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend).toHaveLength(0);
    expect(await approvalsOf(wd.ruleId)).toHaveLength(1);
    const mixed = await world((conn) => [emailAction(conn, `${w.admin.email}, outsider@external.example`)]);
    expect((await patch(w.credential, mixed, 'x@y.example')).statusCode).toBe(200);
    await settle(mixed.rec);
    expect(await approvalsOf(mixed.ruleId)).toHaveLength(1);
  });

  it('the staging rule itself, for all five outward kinds and the non-outward ones (pure)', () => {
    expect([...OUTWARD_AUTOMATION_ACTION_TYPES].sort()).toEqual(['http_request', 'post_social', 'send_email', 'send_slack_message', 'send_webhook']);
    const none = new Set<string>();
    for (const t of ['send_slack_message', 'send_webhook', 'http_request', 'post_social']) {
      expect(agentOriginHoldsAction(t, { recipientsAllMembers: false, policy: none }), t).toBe(true);
      expect(agentOriginHoldsAction(t, { recipientsAllMembers: true, policy: none }), `${t}: the member-only exception is for email only`).toBe(true);
    }
    expect(agentOriginHoldsAction('send_email', { recipientsAllMembers: false, policy: none })).toBe(true);
    expect(agentOriginHoldsAction('send_email', { recipientsAllMembers: true, policy: none })).toBe(false);
    for (const t of ['set_values', 'create_record', 'add_comment', 'notify_user', 'update_linked', 'run_agent']) expect(agentOriginHoldsAction(t, { recipientsAllMembers: false, policy: none }), t).toBe(false);
  });
});

describe('4. the agent\'s own approval_policy is honoured on the Runner path', () => {
  it('policy [email]: even a member-only email is staged; policy [webhook]: it is not (the class does not match)', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    await setPolicy(['webhook']);
    expect((await patch(w.credential, wd, w.admin.email)).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend, 'policy [webhook] does not hold an email').toHaveLength(1);
    expect(await approvalsOf(wd.ruleId)).toHaveLength(0);

    await setPolicy(['email']);
    const wd2 = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    expect((await patch(w.credential, wd2, w.admin.email)).statusCode).toBe(200);
    await settle(wd2.rec);
    expect(sinks.resend).toHaveLength(0);
    expect(await approvalsOf(wd2.ruleId), 'policy [email] holds it').toHaveLength(1);
    await setPolicy([]);
  });
});

describe('5. who is NOT held: a person, a server-run agent, an ordinary token', () => {
  it('an ordinary (non run-credential) personal token is not an agent run: out of scope for the ruling, fires as configured', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    const pat = await w.as(w.admin.token, 'POST', '/me/tokens', { name: 'ordinary', workspace_id: w.ws, scope: 'write' });
    expect(pat.statusCode, pat.body).toBeLessThan(300);
    expect((await patch(pat.json().token, wd, 'outsider@external.example')).statusCode).toBe(200);
    await settle(wd.rec);
    expect(sinks.resend).toHaveLength(1);
  });

  it('a server-run agent applies through the shared executor with NO origin: it is not staged a second time; a person\'s event has origin null', async () => {
    const wd = await world(() => []);
    const effects = await app.get(AutomationActionsService).execute([emailAction(wd.conn, 'outsider@external.example') as never], { workspaceId: w.ws, databaseId: wd.dbId, record: null, actorId: w.admin.email, source: 'agent', ruleId: null, runId: randomUUID() });
    expect(effects.map((e) => e.type), 'queued, not held: agents.service already staged it by approval_policy').toEqual(['queued_job']);
    let seen: unknown = 'unset';
    app.get(DomainEventsService).subscribe((e) => { if (e.recordId === wd.rec) seen = e.origin; });
    await w.as(w.admin.token, 'PATCH', `/workspaces/${w.ws}/databases/${wd.dbId}/records/${wd.rec}`, { values: { name: 'by a person' } });
    expect(seen, 'a person\'s event has origin null').toBeNull();
  });
});

describe('6. the origin survives a cascade and a bulk job', () => {
  it('a rule an agent write fires whose action writes a field that fires a SECOND rule: the second rule\'s email is held too', async () => {
    const dbRes = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: `Chain ${randomUUID()}` });
    const dbId = dbRes.json().id as string;
    const f = async (n: string) => (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, { display_name: n, type: 'text', config: {} })).json() as { id: string; apiName: string };
    const notes = await f('Notes'); const email = await f('Email');
    const conn = await resendConnection();
    const r1 = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, { name: 'copy', trigger: { type: 'record_updated', field_id: notes.id }, actions: [{ type: 'set_values', values: { [email.apiName]: '{Notes}' } }] });
    expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, { name: 'mail', trigger: { type: 'record_updated', field_id: email.id }, actions: [emailAction(conn)] });
    expect(r2.statusCode, r2.body).toBe(201);
    const rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/records`, { values: { name: 'Chain' } })).json().id as string;
    const agentAddr = `agent-${randomUUID()}@external.example`;
    const humanAddr = `human-${randomUUID()}@external.example`;
    const sentTo = (a: string) => sinks.resend.filter((m) => m.to.includes(a));
    expect((await w.as(w.credential, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [notes.apiName]: agentAddr } })).statusCode).toBe(200);
    const held = await waitFor(async () => { await settle(rec); const a = await approvalsOf(r2.json().id); return a.length ? a : null; }, 'the chained rule\'s approval');
    expect(held).toHaveLength(1);
    expect(sentTo(agentAddr), 'the agent only wrote Notes, but its chain reached an outsider: nothing was sent').toHaveLength(0);
    // control: a person writing Notes lets the same chain run as configured
    expect((await w.as(w.admin.token, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [notes.apiName]: humanAddr } })).statusCode).toBe(200);
    await waitFor(async () => { await settle(rec); return sentTo(humanAddr).length ? true : null; }, 'the person\'s chain to send');
    expect(await approvalsOf(r2.json().id), 'no second approval').toHaveLength(1);
  });

  it('a bulk record job a run credential enqueues keeps the origin on the events its timer-run chunk emits', async () => {
    const wd = await world((conn) => [emailAction(conn)]);
    sinks.resend.length = 0;
    const job = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${wd.dbId}/records/batch-jobs`, { op: 'update', record_ids: [wd.rec], values: { [wd.emailApi]: 'outsider@external.example' } });
    expect(job.statusCode, job.body).toBeLessThan(300);
    expect((await pool.query('select origin from bulk_record_jobs order by created_at desc limit 1')).rows[0].origin).toMatchObject({ agentId: w.agentId });
    for (let i = 0; i < 5; i++) await app.get(BulkRecordJobsService).tick(); // the queue is shared: older jobs go first
    await settle(wd.rec);
    expect(sinks.resend).toHaveLength(0);
    expect(await approvalsOf(wd.ruleId), 'held, though the write happened on a timer with no request around it').toHaveLength(1);
    // control: a person's bulk job fires as configured
    const wd2 = await world((conn) => [emailAction(conn)]);
    await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${wd2.dbId}/records/batch-jobs`, { op: 'update', record_ids: [wd2.rec], values: { [wd2.emailApi]: 'outsider@external.example' } });
    for (let i = 0; i < 5; i++) await app.get(BulkRecordJobsService).tick();
    await settle(wd2.rec);
    expect(sinks.resend).toHaveLength(1);
  });
});

describe('7. destinations an admin fixed run as configured, and are LOGGED with the agent', () => {
  it('an outbound webhook subscription: delivered as configured, the delivery names the agent and the run', async () => {
    const sub = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/webhooks`, { url: 'https://staging-1174.invalid/hook-a', events: ['record.updated'] });
    expect(sub.statusCode, sub.body).toBe(201);
    const wd = await world(() => []);
    expect((await patch(w.credential, wd, 'a@b.example')).statusCode).toBe(200);
    await app.get(WebhooksService).scan();
    const row = await waitFor(async () => (await pool.query("select payload from webhook_deliveries where subscription_id = $1 and payload->'record'->>'id' = $2", [sub.json().id, wd.rec])).rows[0], 'the delivery');
    expect(row.payload.caused_by).toMatchObject({ source: 'agent', agent_id: w.agentId, agent_name: 'Staging1174 bot', runner_name: 'audit machine' });
    expect(row.payload.caused_by.run_id).toBeTruthy();
  });

  it('a person\'s write to a subscribed record is delivered with NO caused_by (control)', async () => {
    const sub = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/webhooks`, { url: 'https://staging-1174.invalid/hook-b', events: ['record.updated'] });
    const wd = await world(() => []);
    expect((await patch(w.admin.token, wd, 'c@d.example')).statusCode).toBe(200);
    await app.get(WebhooksService).scan();
    const row = await waitFor(async () => (await pool.query("select payload from webhook_deliveries where subscription_id = $1 and payload->'record'->>'id' = $2", [sub.json().id, wd.rec])).rows[0], 'the delivery');
    expect(row.payload.caused_by).toBeUndefined();
  });

  it('a watcher email: sent to the member, and logged with the agent and the run', async () => {
    const wd = await world(() => []);
    expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${wd.dbId}/records/${wd.rec}/watch`)).statusCode).toBeLessThan(300);
    sinks.mails.length = 0;
    expect((await patch(w.credential, wd, 'a@b.example')).statusCode).toBe(200);
    const log = await waitFor(async () => (await outwardLog('outward.watcher_email', w.agentId)).find((r) => (r['payload'] as { object: { id: string } }).object.id === wd.rec), 'the watcher-email log row');
    expect(sinks.mails.length, 'the watcher was mailed as configured').toBeGreaterThan(0);
    expect(log).toMatchObject({ source: 'agent', agent_name: 'Staging1174 bot', runner_name: 'audit machine' });
    expect(log['run_id']).toBeTruthy();
  });

  it('an @mention comment: the Slack mirror and the member email run as configured, and both are logged', async () => {
    const adminId = (await pool.query('select id from "user" where email = $1', [w.admin.email])).rows[0].id as string;
    sinks.slack.length = 0;
    const c = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records/${w.ticketId}/comments`, { body: { format: 'blocknote', doc: [{ type: 'paragraph', content: [{ type: 'mention', props: { kind: 'user', id: adminId, label: 'Admin' } }, { type: 'text', text: ' please look', styles: {} }] }] } });
    expect(c.statusCode, c.body).toBe(201);
    const mirror = await waitFor(async () => (await outwardLog('outward.slack_mention_mirror', w.agentId))[0], 'the Slack mirror log row');
    expect(sinks.slack.length, 'the mirror was sent as configured').toBeGreaterThan(0);
    expect(mirror).toMatchObject({ source: 'agent', agent_name: 'Staging1174 bot' });
    await waitFor(async () => (await outwardLog('outward.mention_email', w.agentId))[0], 'the mention-email log row');
  });

  it('write-back on a source the admin opted OUT of approval: pushed as configured, the run row names the agent; opted IN: held, the card names it', async () => {
    const conn = (await db.insert(connections).values({ workspaceId: w.ws, provider: 'shopify', name: 'Shopify', authSealed: seal(JSON.stringify({ shop_domain: 'acme.myshopify.com', access_token: 'shpat_x' })), createdBy: w.admin.email, status: 'active' }).returning())[0]!.id;
    const calls: unknown[] = [];
    const fetcher: ConnectionFetcher = async (_u, init) => { calls.push(JSON.parse(String(init?.body ?? '{}'))); return { status: 200, json: async () => ({ data: { productUpdate: { product: { id: 'gid://shopify/Product/1' }, userErrors: [] } } }), text: async () => '{}' }; };
    app.get(WriteBackSubscriber).fetcher = fetcher;
    for (const requireApproval of [false, true]) {
      const dbId = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: `Products ${randomUUID()}` })).json().id as string;
      const fld = async (n: string) => (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, { display_name: n, type: 'text', config: {} })).json() as { id: string; apiName: string };
      const pid = await fld('Product Id'); const title = await fld('Title');
      const rec = (await pool.query("insert into records (database_id, title, values) values ($1, 'P', $2::jsonb) returning id", [dbId, JSON.stringify({ [pid.id]: `gid://shopify/Product/${requireApproval ? 2 : 1}`, [title.id]: 'old' })])).rows[0].id as string;
      const src = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/sources`, { name: 'Shopify', connection_id: conn, provider_source: 'shopify.products', config: { write_back: true, require_approval_for_push: requireApproval }, field_mapping: { product_id: pid.id, title: { field_id: title.id, direction: 'out' } }, external_key_field_id: pid.id, schedule: 'day' });
      expect(src.statusCode, src.body).toBe(201);
      calls.length = 0;
      expect((await w.as(w.credential, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [title.apiName]: 'new' } })).statusCode).toBe(200);
      if (!requireApproval) {
        const run = await waitFor(async () => (await pool.query("select stats from source_runs where source_id = $1 and status = 'ok'", [src.json().id])).rows[0], 'the push run row');
        expect(calls.length, 'pushed as configured').toBe(1);
        expect(run.stats.caused_by).toMatchObject({ source: 'agent', agent_id: w.agentId, agent_name: 'Staging1174 bot' });
      } else {
        const card = await waitFor(async () => (await pool.query("select preview_text from approvals where record_id = $1 and status = 'pending'", [rec])).rows[0], 'the held push');
        expect(calls).toHaveLength(0);
        expect(card.preview_text).toContain('Caused by agent "Staging1174 bot"');
      }
    }
  });
});
