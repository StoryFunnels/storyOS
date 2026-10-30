import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { joinAs } from './helpers/members';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { makeLinearFetcher } from './helpers/linear-fake';
import { connections } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { DomainEventsService } from '../src/events/domain-events.service';
import { CalendarSyncService, CALENDAR_INVITE_KEYS, assertNoInvitees } from '../src/calendar-sync/calendar-sync.service';
import { LinearService } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';
import { LinearWriteBackService, COMMENT_CREATE_MUTATION } from '../src/integrations/linear-write-back.service';
import { AiFieldSubscriber } from '../src/records/ai-field.subscriber';

/**
 * #1179 — the three paths #1174's review found that an agent's write still reached outward, plus the two Inbox/approval findings:
 *
 *  1. calendar-sync: the calendar is the admin's, so an agent's write runs and is LOGGED; an event can never carry guests (a tripwire);
 *  2. the Linear comment outbox: an agent's comment is posted as the AGENT, logged, and held when the admin asked for approval;
 *  3. an AI field: recomputes as configured, logged with the agent, and writes its value without an event (no wake loop);
 *  4. the Inbox: the notification and the approval name the agent and the run, not the rule author;
 *  5. a second approve answers 200 + `already_decided`, never a 201.
 *
 * Every test uses the audit's REAL run credential (a Runner paired and a wake claimed over HTTP) and a person making the same write as
 * the CONTROL, so "nothing happened" cannot be a fixture that could not have seen it.
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
const { db, pool } = connectTestDb();
const BOT = 'Part21179 bot';

beforeAll(async () => {
  app = await createTestApp();
  w = await buildRunCredentialWorld(app, pool, 'Part21179');
}, 180_000);
afterAll(async () => {
  // the job scan is GLOBAL across the shared test database: leave no queued job of ours for another file's tick
  await pool.query("delete from automation_jobs where payload::text like '%part2-1179.invalid%'");
  vi.restoreAllMocks();
  await app.close();
  await pool.end();
});

const waitFor = async <T,>(fn: () => Promise<T | null | undefined | false>, label: string): Promise<T> => {
  for (let i = 0; i < 60; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error(`timed out waiting for ${label}`);
};
const outwardLog = async (type: string, recordId?: string) =>
  (await pool.query("select source, agent_id, agent_name, run_id, runner_id, runner_name, payload from activity_events where type = $1 and agent_id = $2 order by created_at", [type, w.agentId])).rows.filter(
    (r: { payload: { object: { id: string } } }) => !recordId || r.payload.object.id === recordId,
  ) as Array<{ source: string; agent_name: string; run_id: string | null; runner_name: string; payload: { object: { id: string }; summary: string } }>;
const newDb = async (name: string) => (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases`, { space_id: w.spaceId, name: `${name} ${randomUUID()}` })).json().id as string;

// ---- 1. calendar --------------------------------------------------------------------------------------------------------------------
describe('1. calendar-sync: agent-caused pushes run as configured and are logged; an event can never carry guests', () => {
  const sent: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  let calDb: string;
  let startId: string;

  beforeAll(async () => {
    const template = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/templates/calendar/apply`, { space_id: w.spaceId, include_samples: false });
    expect(template.statusCode, template.body).toBe(201);
    calDb = template.json().databases.calendar as string;
    const fields = template.json().fields as Record<string, string>;
    startId = fields['calendar.start']!;
    const adminRow = await pool.query('select id from "user" where email = $1', [w.admin.email]);
    const [conn] = await db.insert(connections).values({ workspaceId: w.ws, provider: 'google-calendar', name: 'Cal', authSealed: seal(JSON.stringify({ access_token: 'cal-token' })), scopes: ['https://www.googleapis.com/auth/calendar'], status: 'active', createdBy: adminRow.rows[0].id }).returning();
    app.get(CalendarSyncService).fetcher = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' || method === 'PATCH') {
        sent.push({ url: String(url), method, body: JSON.parse(String(init?.body ?? '{}')) });
        return new Response(JSON.stringify({ id: `g-${sent.length}`, updated: new Date().toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const binding = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/google-calendar/bindings`, { connection_id: conn!.id, database_id: calDb, calendar_id: 'team', calendar_name: 'Team calendar', start_field_id: startId, direction: 'push' });
    expect(binding.statusCode, binding.body).toBe(201);
  });

  const create = (token: string, title: string) => w.as(token, 'POST', `/workspaces/${w.ws}/databases/${calDb}/records`, { values: { name: title, start: '2026-11-03T10:00:00.000Z' } });

  it('an agent-created event is pushed to the admin\'s calendar, with no guests, and logged with the agent and the run', async () => {
    sent.length = 0;
    const res = await create(w.credential, 'Agent event');
    expect(res.statusCode, res.body).toBe(201);
    const recId = res.json().id as string;
    await waitFor(async () => sent.length > 0, 'the push');
    expect(sent[0]!.body.summary).toBe('Agent event');
    expect(Object.keys(sent[0]!.body).filter((k) => (CALENDAR_INVITE_KEYS as readonly string[]).includes(k)), 'no guest list on the wire').toEqual([]);
    expect(sent[0]!.url, 'Google is never asked to send invitations').not.toMatch(/sendUpdates|sendNotifications/);
    const log = await waitFor(async () => (await outwardLog('outward.calendar_sync', recId))[0], 'the log row');
    expect(log).toMatchObject({ source: 'agent', agent_name: BOT, runner_name: 'audit machine' });
    expect(log.run_id).toBeTruthy();
    expect(log.payload.summary).toContain('Team calendar');
  });

  it('CONTROL: the same event created by a person is pushed identically and logs nothing', async () => {
    sent.length = 0;
    const res = await create(w.admin.token, 'Person event');
    expect(res.statusCode, res.body).toBe(201);
    await waitFor(async () => sent.length > 0, 'the push');
    expect(sent[0]!.body.summary).toBe('Person event');
    await new Promise((r) => setTimeout(r, 150));
    expect(await outwardLog('outward.calendar_sync', res.json().id as string)).toHaveLength(0);
  });

  it('TRIPWIRE: every guest-carrying key is refused for any cause, and a normal body passes', () => {
    for (const key of CALENDAR_INVITE_KEYS) expect(() => assertNoInvitees({ summary: 'x', [key]: [{ email: 'outsider@external.example' }] }), key).toThrow(/approval/);
    expect(() => assertNoInvitees({ summary: 'x', description: 'y', start: {}, end: {}, extendedProperties: {} })).not.toThrow();
    expect(CALENDAR_INVITE_KEYS).toContain('attendees');
  });
});

// ---- 2. Linear comment write-back -------------------------------------------------------------------------------------------------
describe('2. Linear comment write-back: posted as the agent, logged, and held when the admin asked for approval', () => {
  const KEY = 'lin_api_part2_key';
  const mutations: Array<{ issueId: string; body: string }> = [];
  let issuesDb: string;
  let rec: string;
  let wb: LinearWriteBackService;

  beforeAll(async () => {
    wb = app.get(LinearWriteBackService);
    expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/linear`, { api_key: KEY, team_keys: ['WB'] })).statusCode).toBe(201);
    const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
    const base = makeLinearFetcher([{ id: 'team-w', key: 'WB', name: 'WriteBack', data: { ...empty, issues: { nodes: [] }, comments: [] } }]).fetcher;
    const f: LinearFetcher = async (query, variables, apiKey) => {
      if (query.includes('mutation')) {
        const input = variables['input'] as { issueId: string; body: string };
        mutations.push(input);
        return { commentCreate: { success: true, comment: { id: `lc-${mutations.length}`, url: `https://linear.app/acme/issue/WB-1#comment-lc-${mutations.length}` } } };
      }
      return base(query, variables, apiKey);
    };
    app.get(LinearService).fetcher = f;
    issuesDb = await newDb('Issues');
    const fld = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${issuesDb}/fields`, { display_name: 'Linear Id', type: 'text', config: {} })).json() as { id: string; apiName: string };
    expect(fld.apiName).toBe('linear_id');
    rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${issuesDb}/records`, { values: { name: 'Mirrored issue', linear_id: 'issue-uuid-1' } })).json().id as string;
    expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/linear`, { write_back: { enabled: true } })).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 25)); // only comments written AFTER the switch are considered
  });

  const comment = async (token: string, text: string) => {
    const r = await w.as(token, 'POST', `/workspaces/${w.ws}/databases/${issuesDb}/records/${rec}/comments`, { body: [{ type: 'text', text }] });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  const pushStatus = async (id: string) => (await pool.query('select status, last_error from linear_comment_pushes where comment_id = $1', [id])).rows[0] as { status: string; last_error: string | null } | undefined;
  const setRequire = async (on: boolean) => expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/linear`, { write_back: { require_approval_for_agent_comments: on } })).statusCode).toBe(201);
  const approvalFor = async (id: string) => (await pool.query("select id, status, preview_text, action_snapshot from approvals where action_snapshot #>> '{action,comment_id}' = $1 order by created_at desc", [id])).rows[0] as { id: string; status: string; preview_text: string; action_snapshot: { ctx: { origin: { agentId: string } } } } | undefined;

  it('default (no approval asked): the agent\'s comment is posted signed with the AGENT\'s name, and logged with the agent and the run', async () => {
    mutations.length = 0;
    const id = await comment(w.credential, 'Root cause found: the cache key ignores locale.');
    await wb.tick();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.body.split('\n')[0], 'never attributed to the person who owns the agent').toBe(`**${BOT} · via StoryOS**`);
    expect((await pushStatus(id))?.status).toBe('sent');
    const log = await waitFor(async () => (await outwardLog('outward.linear_comment', rec)).at(-1), 'the log row');
    expect(log).toMatchObject({ source: 'agent', agent_name: BOT, runner_name: 'audit machine' });
    expect(log.run_id).toBeTruthy();
    expect(await approvalFor(id)).toBeUndefined();
  });

  it('CONTROL: a person\'s comment is posted as the person and logs nothing', async () => {
    mutations.length = 0;
    const before = (await outwardLog('outward.linear_comment', rec)).length;
    const id = await comment(w.admin.token, 'A person says hello.');
    await wb.tick();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]!.body.split('\n')[0]).not.toContain(BOT);
    expect((await pushStatus(id))?.status).toBe('sent');
    expect((await outwardLog('outward.linear_comment', rec)).length).toBe(before);
  });

  it('require_approval_for_agent_comments ON: the agent\'s comment is HELD (nothing sent), the card names the agent and run, only an admin releases it', async () => {
    await setRequire(true);
    mutations.length = 0;
    const id = await comment(w.credential, 'Please confirm before this reaches the Linear team.');
    await wb.tick();
    expect(mutations, 'nothing reached Linear').toHaveLength(0);
    expect((await pushStatus(id))?.status).toBe('held');
    const approval = (await approvalFor(id))!;
    expect(approval.status).toBe('pending');
    expect(approval.preview_text).toContain(`Caused by agent "${BOT}"`);
    expect(approval.preview_text).toContain('Please confirm');
    expect(approval.action_snapshot.ctx.origin.agentId).toBe(w.agentId);
    await wb.tick(); // a second tick must not stage a second approval nor send
    expect(mutations).toHaveLength(0);
    expect((await pool.query("select count(*)::int n from approvals where action_snapshot #>> '{action,comment_id}' = $1", [id])).rows[0].n).toBe(1);
    // the credential cannot release it; a plain member cannot; the admin can
    expect((await w.as(w.credential, 'POST', `/workspaces/${w.ws}/approvals/${approval.id}/approve`, {})).statusCode).toBe(403);
    expect((await w.as(w.owner.token, 'POST', `/workspaces/${w.ws}/approvals/${approval.id}/approve`, {})).statusCode).toBeGreaterThanOrEqual(403);
    expect(mutations).toHaveLength(0);
    const ok = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${approval.id}/approve`, {});
    expect(ok.statusCode, ok.body).toBe(201);
    await app.get(JobRunnerService).tick();
    await wb.tick();
    expect(mutations, 'after approval it is posted, once').toHaveLength(1);
    expect(mutations[0]!.body.split('\n')[0]).toBe(`**${BOT} · via StoryOS**`);
    expect((await pushStatus(id))?.status).toBe('sent');
    // approving again posts nothing more
    await wb.tick();
    expect(mutations).toHaveLength(1);
  });

  it('ON: rejecting fails the push and says so on the comment; and a PERSON\'s comment is never held (control)', async () => {
    await setRequire(true);
    mutations.length = 0;
    const id = await comment(w.credential, 'This one the admin will decline.');
    await wb.tick();
    const approval = (await approvalFor(id))!;
    const rej = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${approval.id}/reject`, { reason: 'too chatty' });
    expect(rej.statusCode, rej.body).toBeLessThan(300);
    await app.get(JobRunnerService).tick();
    await wb.tick();
    expect(mutations, 'a rejected comment never goes out').toHaveLength(0);
    expect(await pushStatus(id)).toMatchObject({ status: 'failed' });
    expect((await pushStatus(id))!.last_error).toContain('too chatty');
    const personId = await comment(w.admin.token, 'A person is not held.');
    await wb.tick();
    expect(mutations).toHaveLength(1);
    expect((await pushStatus(personId))?.status).toBe('sent');
    expect(await approvalFor(personId)).toBeUndefined();
    await setRequire(false);
  });
});

// ---- 3. AI fields -------------------------------------------------------------------------------------------------------------------
describe('3. AI fields: an agent\'s write recomputes as configured, logged with the agent, and cannot wake an agent', () => {
  let aiDb: string;
  let aiFieldId: string;
  let noteApi: string;
  const prompts: string[] = [];

  beforeAll(async () => {
    app.get(AiFieldSubscriber).client = { complete: async (p: string) => { prompts.push(p); return { text: 'summary', tokensIn: 1, tokensOut: 1 }; } };
    aiDb = await newDb('AiLeads');
    const note = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${aiDb}/fields`, { display_name: 'Note', type: 'text', config: {} })).json() as { apiName: string };
    noteApi = note.apiName;
    const ai = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${aiDb}/fields`, { display_name: 'Summary', type: 'ai', config: { prompt: 'Summarize {Note}', output: { kind: 'text' } } });
    expect(ai.statusCode, ai.body).toBe(201);
    aiFieldId = ai.json().id as string;
  });
  const tickJobs = async (recordId: string) => {
    await waitFor(async () => (await pool.query("select 1 from automation_jobs where kind = 'ai_field_recompute' and status = 'queued' and payload->>'recordId' = $1", [recordId])).rows[0], 'the recompute job');
    await app.get(JobRunnerService).tick();
  };
  const recordCount = async () => (await pool.query('select count(*)::int n from records r join databases d on d.id = r.database_id where d.workspace_id = $1', [w.ws])).rows[0].n as number;

  it('an agent write: the prompt is sent (as configured), the log row names the agent and run, no event is emitted and no record (no wake) appears', async () => {
    const rec = (await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${aiDb}/records`, { values: { name: 'Lead', [noteApi]: 'big deal' } })).json().id as string;
    const emitted: string[] = [];
    const emit = vi.spyOn(app.get(DomainEventsService), 'emit').mockImplementation(((e: { type: string }) => { emitted.push(e.type); }) as never);
    const before = await recordCount();
    prompts.length = 0;
    await tickJobs(rec);
    emit.mockRestore();
    expect(prompts, 'the model was called with the record\'s prompt').toHaveLength(1);
    expect(prompts[0]).toContain('big deal');
    const log = (await outwardLog('outward.ai_field', rec))[0];
    expect(log, 'logged with the agent').toMatchObject({ source: 'agent', agent_name: BOT, runner_name: 'audit machine' });
    expect(log!.run_id).toBeTruthy();
    expect(emitted, 'the recompute writes its value WITHOUT a domain event: nothing for an agent trigger or a rule to wake on').toEqual([]);
    expect(await recordCount(), 'no wake / run record was created').toBe(before);
    const stored = (await pool.query('select computed_values from records where id = $1', [rec])).rows[0].computed_values as Record<string, unknown>;
    expect(stored[aiFieldId]).toBe('summary');
  });

  it('CONTROL: a person\'s write recomputes identically and logs nothing', async () => {
    const rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${aiDb}/records`, { values: { name: 'Lead 2', [noteApi]: 'small deal' } })).json().id as string;
    prompts.length = 0;
    await tickJobs(rec);
    expect(prompts).toHaveLength(1);
    expect(await outwardLog('outward.ai_field', rec)).toHaveLength(0);
  });
});

// ---- 4 + 5. The Inbox names the agent; a repeat approve is not a second send -------------------------------------------------------------
describe('4/5. the Inbox row and card name the agent and the run; a repeat decision is 200 and already_decided', () => {
  let rec: string;
  let ruleId: string;
  let approvalId: string;
  let dbId: string;
  let emailApi: string;

  beforeAll(async () => {
    dbId = await newDb('Hooks');
    emailApi = ((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/fields`, { display_name: 'Target', type: 'text', config: {} })).json() as { apiName: string }).apiName;
    // an ungated http_request rule: an agent's write stages it (ticket #1174)
    const rule = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, { name: 'ping', trigger: { type: 'record_updated' }, actions: [{ type: 'http_request', method: 'POST', url: 'https://part2-1179.invalid/hook', require_approval: false }] });
    expect(rule.statusCode, rule.body).toBe(201);
    ruleId = rule.json().id as string;
    rec = (await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/records`, { values: { name: 'R' } })).json().id as string;
    expect((await w.as(w.credential, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [emailApi]: 'x' } })).statusCode).toBe(200);
    const row = await waitFor(async () => (await pool.query("select id from approvals where rule_id = $1 and status = 'pending'", [ruleId])).rows[0], 'the staged approval');
    approvalId = row.id as string;
  });

  it('the approvals list and the Inbox notification carry caused_by: agent name, run number, label', async () => {
    const list = (await w.as(w.admin.token, 'GET', `/workspaces/${w.ws}/approvals`)).json();
    const card = (list.data ?? list).find((a: { id: string }) => a.id === approvalId);
    expect(card.caused_by).toMatchObject({ agent_id: w.agentId, agent_name: BOT, runner_name: 'audit machine' });
    expect(card.caused_by.run_number, 'the run\'s public number, not its uuid').toEqual(expect.any(Number));
    expect(card.caused_by.label).toBe(`${BOT} (run ${card.caused_by.run_number})`);
    const inbox = (await w.as(w.admin.token, 'GET', `/workspaces/${w.ws}/notifications`)).json();
    const row = inbox.data.find((n: { ref_id: string }) => n.ref_id === approvalId);
    expect(row, 'the approver\'s Inbox row exists').toBeTruthy();
    expect(row.caused_by.label, 'the row header can say who, instead of the rule author').toBe(card.caused_by.label);
    expect(row.actor.name, 'actor is still the rule author, unchanged').not.toBe(BOT);
  });

  it('CONTROL: an approval a person caused has caused_by null, in the list and in the Inbox', async () => {
    expect((await w.as(w.admin.token, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [emailApi]: 'by a person' } })).statusCode).toBe(200);
    // a person's write to an UNGATED rule runs; use a require_approval rule for a person-caused approval instead
    const rule2 = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${dbId}/automations`, { name: 'gated', trigger: { type: 'record_updated' }, actions: [{ type: 'http_request', method: 'POST', url: 'https://part2-1179.invalid/gated', require_approval: true }] });
    expect(rule2.statusCode, rule2.body).toBe(201);
    expect((await w.as(w.admin.token, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [emailApi]: 'again by a person' } })).statusCode).toBe(200);
    const mine = await waitFor(async () => (await pool.query("select id from approvals where rule_id = $1", [rule2.json().id])).rows[0], 'the person-caused approval');
    const list = (await w.as(w.admin.token, 'GET', `/workspaces/${w.ws}/approvals`)).json();
    expect((list.data ?? list).find((a: { id: string }) => a.id === mine.id).caused_by).toBeNull();
    const inbox = (await w.as(w.admin.token, 'GET', `/workspaces/${w.ws}/notifications`)).json();
    expect(inbox.data.find((n: { ref_id: string }) => n.ref_id === mine.id).caused_by).toBeNull();
  });

  it('GUEST (no grant): sees no approval and so no agent name', async () => {
    const guest = await joinAs(app, w.admin.token, w.ws, 'Part21179Guest', 'guest', [{ database_id: w.ticketsDbId, role: 'viewer' }]);
    const list = (await w.as(guest.token, 'GET', `/workspaces/${w.ws}/approvals`)).json();
    expect(JSON.stringify(list)).not.toContain(BOT);
  });

  it('approving twice: the first is the decision, the second is 200 + already_decided and enqueues nothing', async () => {
    const jobsBefore = async () => Number((await pool.query('select count(*)::int n from automation_jobs where approval_id = $1', [approvalId])).rows[0].n);
    const first = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${approvalId}/approve`, {});
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().already_decided).toBe(false);
    expect(await jobsBefore()).toBe(1);
    const again = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${approvalId}/approve`, {});
    expect(again.statusCode, 'not a 201 that looks like a second send').toBe(200);
    expect(again.json()).toMatchObject({ already_decided: true, status: 'approved', id: approvalId });
    expect(await jobsBefore(), 'no second job, so no second send').toBe(1);
  });

  it('rejecting twice is 200 + already_decided too; the OPPOSITE decision is still a 409 (#869)', async () => {
    expect((await w.as(w.credential, 'PATCH', `/workspaces/${w.ws}/databases/${dbId}/records/${rec}`, { values: { [emailApi]: 'again' } })).statusCode).toBe(200);
    const row = await waitFor(async () => (await pool.query("select id from approvals where rule_id = $1 and status = 'pending' and id <> $2", [ruleId, approvalId])).rows[0], 'a second staged approval');
    const first = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${row.id}/reject`, { reason: 'no' });
    expect(first.statusCode, first.body).toBe(201);
    const again = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${row.id}/reject`, { reason: 'no' });
    expect(again.statusCode).toBe(200);
    expect(again.json().already_decided).toBe(true);
    expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/approvals/${row.id}/approve`, {})).statusCode).toBe(409);
  });
});
