import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { AgentsService } from '../src/agents/agents.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import { AgentWakesService } from '../src/runners/agent-wakes.service';
import { RunnerSweeperService } from '../src/runners/runner-sweeper.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { WAKE_LEASE_SECONDS } from '../src/runners/wake.constants';

/**
 * #1130 / ADR-0021 §1, §2, §11 — the wake queue. Real fixtures for every kind of person the access rule names: the agent's OWNER (a
 * member who also owns a Runner), another member, an ADMIN, a GUEST who can read the records but NOT the Agents database, and a
 * guest who can read both. Every wake source is tested for "exactly one queued wake, and a repeat coalesces".
 */
let app: NestFastifyApplication;
let wakes: AgentWakesService;
let sweeper: RunnerSweeperService;
let subscriber: AgentTriggerSubscriber;
let jobs: JobRunnerService;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let stateFieldId: string;
let stateApi: string;
let reviewId: string;
let doneId: string;
let nextApi: string;
let nextFieldId: string;
let admin: { token: string; email: string };
let adminId: string;
let owner: Person; // a MEMBER: owns the agents and a Runner
let other: Person; // another member
let guestPartial: Person; // reads Tickets, has no grant on the Agents database
let guestFull: Person; // reads Tickets and the Agents database
let aiModeIds: Record<string, string> = {};
let runStatusIds: Record<string, string> = {};
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = () => ({ machine_name: "Owner's MacBook", tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

async function mkAgent(who: { token: string }, name: string, aiMode: string | null = 'Your own AI', enabled = true): Promise<string> {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
    values: { name, enabled, ...(aiMode ? { ai_mode: aiModeIds[aiMode] } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function mkTicket(name: string, values: Record<string, unknown> = {}, token = admin.token): Promise<string> {
  const res = await as(token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name, ...values } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

/** Pair a Runner for `who`, press Done, and (optionally) send `agentIds` to it. */
async function pairRunner(who: Person, agentIds: string[] = []) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner } = paired.json() as { token: string; runner: { id: string } };
  const done = await as(who.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' });
  expect(done.statusCode, done.body).toBe(200);
  for (const agent of agentIds) {
    const res = await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id });
    expect(res.statusCode, res.body).toBe(200);
  }
  return { token, id: runner.id };
}

/**
 * ticket #1133: a run that ends `ok` on a wake with a record must have commented on it, else the backstop wakes it once more. These
 * tests are about the queue, not the backstop (test/run-record.test.ts owns that), so the agent "says something" first.
 */
async function agentSaid(wakeId: string) {
  const w = (await pool.query('select record_id, run_id, agent_id from agent_wakes where id = $1', [wakeId])).rows[0];
  if (!w.record_id) return;
  await pool.query("insert into comments (record_id, author_id, body, source, agent_id, run_id) values ($1, 'test-author', '[]'::jsonb, 'agent', $2, $3)", [w.record_id, w.agent_id, w.run_id]);
}
const claim = (token: string, body: Record<string, unknown> = {}) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0, ...body });
const wakeRows = async (agentId: string) => (await pool.query('select * from agent_wakes where agent_id = $1 order by created_at', [agentId])).rows;
const openWakes = async (agentId: string) => (await wakeRows(agentId)).filter((w: { status: string }) => w.status === 'queued' || w.status === 'claimed');
const runRecord = async (runId: string) => (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${runId}`)).json() as { values: Record<string, unknown> };
const runStatus = async (runId: string) => {
  const id = (await runRecord(runId)).values.status as string;
  return Object.entries(runStatusIds).find(([, v]) => v === id)?.[0];
};
const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const agentMention = (id: string) => ({ type: 'mention', props: { kind: 'agent', id, label: 'agent' } });
const txt = (text: string) => ({ type: 'text', text, styles: {} });
const comment = (token: string, recordId: string, doc: unknown[]) =>
  as(token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${recordId}/comments`, { body: { format: 'blocknote', doc } });
const settle = (recordId: string) => subscriber.settle(recordId);

async function bindState(agentId: string, optionId: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent: agentId, database_id: ticketsDbId, state_field_id: stateFieldId, state_option_id: optionId });
  expect(res.statusCode, res.body).toBe(201);
}
async function bindRelation(agentId: string, body: Record<string, unknown> = {}) {
  return as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent: agentId, database_id: ticketsDbId, relation_field_id: nextFieldId, ...body });
}

beforeAll(async () => {
  app = await createTestApp();
  wakes = app.get(AgentWakesService);
  sweeper = app.get(RunnerSweeperService);
  subscriber = app.get(AgentTriggerSubscriber);
  jobs = app.get(JobRunnerService);
  admin = await signUpUser(app, 'WakeAdmin');
  adminId = (await as(admin.token, 'GET', '/me')).json().id;
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Wake WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const opts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  aiModeIds = Object.fromEntries(opts.rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  const st = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'status'", [runsDbId]);
  runStatusIds = Object.fromEntries(st.rows.map((r: { label: string; id: string }) => [r.label, r.id]));

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  const state = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'State', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'Review' }, { label: 'Done' }] })).json();
  stateFieldId = state.id;
  stateApi = state.apiName;
  reviewId = state.options.find((o: { label: string }) => o.label === 'Review').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;
  const rel = await as(admin.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: ticketsDbId, database_b_id: agentsDbId, cardinality: 'one_to_many', field_a_name: 'Next', field_b_name: 'Queue' });
  expect(rel.statusCode, rel.body).toBe(201);
  const detail = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}`)).json();
  const next = detail.fields.find((f: { displayName: string }) => f.displayName === 'Next');
  nextFieldId = next.id;
  nextApi = next.apiName;

  owner = await joinAs(app, admin.token, ws, 'WakeOwner', 'member');
  other = await joinAs(app, admin.token, ws, 'WakeOther', 'member');
  guestPartial = await joinAs(app, admin.token, ws, 'WakeGuestA', 'guest', [{ database_id: ticketsDbId, role: 'contributor' }]);
  guestFull = await joinAs(app, admin.token, ws, 'WakeGuestB', 'guest', [{ database_id: ticketsDbId, role: 'contributor' }, { database_id: agentsDbId, role: 'viewer' }]);
}, 180_000);

beforeEach(async () => {
  await pool.query('delete from runner_pairing_failures');
  await pool.query("update runner_pairing_codes set created_at = created_at - interval '3 hours'");
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('each wake source creates exactly one queued wake, and a repeat coalesces', () => {
  it('manual: Run now / delegate. A second press while one is queued is the SAME wake and the SAME Run', async () => {
    const agent = await mkAgent(owner, 'Manual bot');
    const ticket = await mkTicket('Delegated ticket');
    const first = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket });
    expect(first.statusCode, first.body).toBe(201);
    const second = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket });
    expect(second.statusCode, second.body).toBe(201);
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'manual', record_id: ticket, coalesced_count: 1 });
    expect(second.json().id).toBe(first.json().id); // one Run
    expect(rows[0].run_id).toBe(first.json().id);
    expect(await runStatus(first.json().id)).toBe('Queued');
    expect(rows[0].reasons).toEqual([expect.objectContaining({ reason: 'manual', count: 2 })]);
  });

  it('manual with no record: the agent-level wake coalesces on the agent alone', async () => {
    const agent = await mkAgent(owner, 'Manual no-record bot');
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).statusCode).toBe(201);
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).statusCode).toBe(201);
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].record_id).toBeNull();
  });

  it('state change: the existing binding enqueues a wake instead of a finished handoff Run; re-entering the state coalesces', async () => {
    const agent = await mkAgent(owner, 'State bot');
    await bindState(agent, reviewId);
    const ticket = await mkTicket('Needs review', { [stateApi]: doneId });
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [stateApi]: reviewId } });
    await settle(ticket);
    let rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'state_change', record_id: ticket, requested_by: adminId });
    // Out and back in again inside the old in-memory cooldown window: ONE wake, merged (not dropped, not doubled).
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [stateApi]: doneId } });
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [stateApi]: reviewId } });
    await settle(ticket);
    rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].coalesced_count).toBe(1);
  });

  it('assigned: a relation binding wakes the agent when the field links to it, and only that agent; unlinking wakes nothing', async () => {
    const agent = await mkAgent(owner, 'Assigned bot');
    const bystander = await mkAgent(owner, 'Bystander bot');
    expect((await bindRelation(agent)).statusCode).toBe(201);
    const ticket = await mkTicket('Hand it over');
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [nextApi]: [agent] } });
    await settle(ticket);
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'assigned', record_id: ticket });
    expect(await wakeRows(bystander)).toHaveLength(0);
    // Linking the SAME agent again while its wake is queued merges.
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [nextApi]: [bystander] } });
    await settle(ticket);
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [nextApi]: [agent] } });
    await settle(ticket);
    expect(await wakeRows(agent)).toHaveLength(1);
    expect((await wakeRows(agent))[0].coalesced_count).toBeGreaterThanOrEqual(1);
    // Clearing the field is an unlink: no new wake for anyone.
    const before = (await wakeRows(agent)).length + (await wakeRows(bystander)).length;
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [nextApi]: [] } });
    await settle(ticket);
    expect((await wakeRows(agent)).length + (await wakeRows(bystander)).length).toBe(before);
  });

  it('a relation binding is validated: not a relation, not pointing at Agents, and not mixed with a state', async () => {
    const agent = await mkAgent(owner, 'Validated relation bot');
    expect((await bindRelation(agent, { relation_field_id: stateFieldId })).statusCode).toBe(422);
    expect((await bindRelation(agent, { state_field_id: stateFieldId, state_option_id: reviewId })).statusCode).toBe(422);
    expect((await bindRelation(agent, { human_gate: true })).statusCode).toBe(422);
    const neither = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: ticketsDbId });
    expect(neither.statusCode).toBe(422);
    // The same state binding as before still works (existing behaviour, unchanged).
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, database_id: ticketsDbId, state_field_id: stateFieldId, state_option_id: reviewId })).statusCode).toBe(201);
  });

  it('automation (a run_agent rule or a schedule): one wake carrying the prompt override; a repeat coalesces', async () => {
    const agent = await mkAgent(owner, 'Rule bot');
    const ticket = await mkTicket('Rule ticket');
    const svc = app.get(AgentsService);
    const a = await svc.runFromAutomation({ workspaceId: ws, agentRef: agent, inputRecordId: ticket, prompt: 'Summarise it', requestedBy: adminId });
    const b = await svc.runFromAutomation({ workspaceId: ws, agentRef: agent, inputRecordId: ticket, requestedBy: null });
    expect(b.id).toBe(a.id);
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'automation', status: 'queued' });
    expect(rows[0].context).toEqual({ prompt: 'Summarise it' });
    expect(JSON.stringify((await runRecord(a.id)).values.steps)).toContain('Summarise it');
  });

  it('mention: an @-mention of the agent in a comment wakes it once; a second mention coalesces; a replay of the same comment is idempotent', async () => {
    const agent = await mkAgent(owner, 'Mention bot');
    const ticket = await mkTicket('Mention ticket');
    expect((await comment(admin.token, ticket, [para(txt('hey '), agentMention(agent), txt(' take a look'))])).statusCode).toBe(201);
    let rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'queued', reason: 'mention', record_id: ticket });
    expect(rows[0].source_key).toMatch(/^mention:/);
    expect(await runStatus(rows[0].run_id)).toBe('Queued');
    expect((await comment(other.token, ticket, [para(agentMention(agent), txt(' again'))])).statusCode).toBe(201);
    expect((await comment(admin.token, ticket, [para(agentMention(agent), txt(' and again'))])).statusCode).toBe(201);
    rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].coalesced_count).toBe(2);
    expect(rows[0].reasons).toEqual([expect.objectContaining({ reason: 'mention', count: 3 })]);
    // The same event delivered twice (a replay) never makes a second wake.
    const dup = await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'mention', recordId: ticket, requestedBy: null, sourceKey: rows[0].source_key });
    expect(dup.outcome).toBe('duplicate');
    expect(await wakeRows(agent)).toHaveLength(1);
  });

  it('a comment with no agent mention, or one that mentions a person, wakes nothing', async () => {
    const agent = await mkAgent(owner, 'Quiet bot');
    const ticket = await mkTicket('Quiet ticket');
    await comment(admin.token, ticket, [para(txt('just a note'))]);
    await comment(admin.token, ticket, [para({ type: 'mention', props: { kind: 'user', id: owner.id, label: 'o' } })]);
    expect(await wakeRows(agent)).toHaveLength(0);
  });

  it('approval decided: a held write the agent asked for, once decided, wakes it with the verdict (approve wakes AFTER the write applies; reject wakes at once)', async () => {
    const agent = await mkAgent(owner, 'Gated bot');
    const tok = await as(owner.token, 'POST', '/me/tokens', { name: 'gated bot token', workspace_id: ws, scope: 'write', agent_id: agent });
    expect(tok.statusCode, tok.body).toBe(201);
    const gate = await as(admin.token, 'POST', `/workspaces/${ws}/agent-write-gates`, { agent_id: agent, operations: ['update'], database_id: ticketsDbId });
    expect(gate.statusCode, gate.body).toBe(201);

    const approveTicket = await mkTicket('Approve me');
    const held = await as(tok.json().token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${approveTicket}`, { values: { name: 'Approved name' } });
    expect(held.statusCode, held.body).toBe(202);
    expect(await wakeRows(agent)).toHaveLength(0); // being held is not a wake
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/approvals/${held.json().approval_id}/approve`)).statusCode).toBeLessThan(300);
    await jobs.tick();
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'approval_decided', status: 'queued', record_id: approveTicket, source_key: `approval:${held.json().approval_id}` });
    expect(rows[0].context).toMatchObject({ approval: { id: held.json().approval_id, verdict: 'approved' } });

    const rejectTicket = await mkTicket('Reject me');
    const held2 = await as(tok.json().token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${rejectTicket}`, { values: { name: 'Nope' } });
    expect((await as(admin.token, 'POST', `/workspaces/${ws}/approvals/${held2.json().approval_id}/reject`, { reason: 'not that' })).statusCode).toBeLessThan(300);
    const rejected = (await wakeRows(agent)).find((w: { record_id: string }) => w.record_id === rejectTicket);
    expect(rejected).toMatchObject({ reason: 'approval_decided', status: 'queued' });
    expect(rejected.context).toMatchObject({ approval: { verdict: 'rejected', reason: 'not that' } });
  });
});

describe('a wake is NEVER created for something its author cannot see', () => {
  it('a guest who can read the record but not the Agents database cannot wake an agent by @-mention; a guest who can read both can', async () => {
    const agent = await mkAgent(owner, 'Guarded bot');
    const ticket = await mkTicket('Guest ticket');
    const denied = await comment(guestPartial.token, ticket, [para(agentMention(agent), txt(' please'))]);
    expect(denied.statusCode, denied.body).toBe(201); // the comment itself is fine...
    expect(await wakeRows(agent)).toHaveLength(0); // ...it just wakes nothing
    const allowed = await comment(guestFull.token, ticket, [para(agentMention(agent), txt(' please'))]);
    expect(allowed.statusCode, allowed.body).toBe(201);
    const rows = await wakeRows(agent);
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_by).toBe(guestFull.id);
  });

  it('a person who cannot see the RECORD cannot wake an agent on it, even one they can see (record-scoped refusal)', async () => {
    const agent = await mkAgent(owner, 'Record-scoped bot');
    const outcome = await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'mention', recordId: await mkTicket('Hidden from the guest'), requestedBy: guestPartial.id });
    // guestPartial reads Tickets, so the record is visible: the refusal here is the AGENT (no grant on the Agents database).
    expect(outcome).toMatchObject({ outcome: 'skipped', code: 'agent_not_visible' });
    const secret = await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Secret' });
    const secretDb = secret.json().id as string;
    const rec = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secretDb}/records`, { values: { name: 'Classified' } })).json().id as string;
    await setRestricted(app, admin.token, ws, 'database', secretDb);
    // The author (admin) can see it, the agent's OWNER (a member holding no grant on a restricted database) cannot: no wake.
    const ownerBlind = await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: rec, requestedBy: null });
    expect(ownerBlind).toMatchObject({ outcome: 'skipped', code: 'owner_cannot_read' });
    // ...and the author who cannot see the record: a member without a grant on the restricted database.
    const agentOfAdmin = await mkAgent(admin, 'Admin-owned bot');
    const authorBlind = await wakes.enqueue({ workspaceId: ws, agentId: agentOfAdmin, reason: 'mention', recordId: rec, requestedBy: other.id });
    expect(authorBlind).toMatchObject({ outcome: 'skipped', code: 'record_not_visible' });
    // And an admin author with an admin-owned agent can: the rule is not "never".
    expect((await wakes.enqueue({ workspaceId: ws, agentId: agentOfAdmin, reason: 'mention', recordId: rec, requestedBy: adminId })).outcome).toBe('created');
    expect(await wakeRows(agent)).toHaveLength(0);
  });

  it('personal content never wakes an agent: a record whose database sits in a personal space is refused at emit time', async () => {
    const agent = await mkAgent(owner, 'Personal bot');
    const space = await pool.query("insert into spaces (workspace_id, name, slug, personal, owner_user_id) values ($1, 'Personal', $2, true, $3) returning id", [ws, `personal-${owner.id}`, owner.id]);
    const db = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Moved into personal' })).json().id as string;
    const rec = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'Private note' } })).json().id as string;
    await pool.query('update databases set space_id = $1 where id = $2', [space.rows[0].id, db]);
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/records/${rec}/comments`, { body: { format: 'blocknote', doc: [para(agentMention(agent))] } });
    expect(res.statusCode, res.body).toBeLessThan(500);
    expect(await wakeRows(agent)).toHaveLength(0);
    expect(await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: rec, requestedBy: owner.id })).toMatchObject({ outcome: 'skipped', code: 'personal_content' });
  });

  it('a mention inside a DOCUMENT or a rich-text field wakes nothing (only a comment does), and an agent comment with no run behind it wakes nothing (run credentials: test/run-credentials.test.ts)', async () => {
    const agent = await mkAgent(owner, 'Doc bot');
    const ticket = await mkTicket('Doc ticket');
    const put = await as(admin.token, 'PUT', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/document`, { content: [para(agentMention(agent))], expected_version: 0 });
    expect(put.statusCode, put.body).toBeLessThan(300);
    expect(await wakeRows(agent)).toHaveLength(0);
    // An older agent token carries no run and so no depth: mention ping-pong would be unbounded, so it wakes nothing (#1132 covers a run credential).
    const otherAgent = await mkAgent(owner, 'Authoring bot');
    const tok = await as(owner.token, 'POST', '/me/tokens', { name: 'authoring token', workspace_id: ws, scope: 'write', agent_id: otherAgent });
    const res = await comment(tok.json().token, ticket, [para(agentMention(agent))]);
    expect(res.statusCode, res.body).toBe(201);
    expect(await wakeRows(agent)).toHaveLength(0);
  });

  it('a depth past the loop guard, a disabled agent, a non-Your-own-AI agent and a departed owner all create nothing, and say why', async () => {
    const ok = await mkAgent(owner, 'Rules bot');
    expect(await wakes.enqueue({ workspaceId: ws, agentId: ok, reason: 'state_change', requestedBy: null, depth: 3 })).toMatchObject({ code: 'loop_guard' });
    const off = await mkAgent(owner, 'Disabled bot', 'Your own AI', false);
    expect(await wakes.enqueue({ workspaceId: ws, agentId: off, reason: 'manual', requestedBy: null })).toMatchObject({ code: 'agent_disabled' });
    const managed = await mkAgent(owner, 'Managed bot', 'StoryOS AI');
    expect(await wakes.enqueue({ workspaceId: ws, agentId: managed, reason: 'manual', requestedBy: null })).toMatchObject({ code: 'not_own_ai' });
    expect(await wakes.enqueue({ workspaceId: ws, agentId: '00000000-0000-4000-8000-000000000000', reason: 'manual', requestedBy: null })).toMatchObject({ code: 'agent_not_found' });
    const stranger = await joinAs(app, admin.token, ws, 'WakeLeaver', 'member');
    const orphan = await mkAgent(stranger, 'Orphan bot');
    await pool.query('delete from memberships where workspace_id = $1 and user_id = $2', [ws, stranger.id]);
    expect(await wakes.enqueue({ workspaceId: ws, agentId: orphan, reason: 'manual', requestedBy: null })).toMatchObject({ code: 'owner_inactive' });
  });
});

describe('existing behaviour keeps working', () => {
  it('a Non-AI agent still runs at once on a state change and a manual run, with no wake', async () => {
    const nonAi = await mkAgent(owner, 'Plain bot', 'Non-AI');
    await bindState(nonAi, reviewId);
    const ticket = await mkTicket('Plain ticket');
    await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}`, { values: { [stateApi]: reviewId } });
    await settle(ticket);
    const manual = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${nonAi}/run`);
    expect(manual.statusCode, manual.body).toBe(201);
    expect(await runStatus(manual.json().id)).toBe('Succeeded');
    expect(await wakeRows(nonAi)).toHaveLength(0);
    const runs = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records`)).json().data as Array<{ values: Record<string, unknown> }>;
    const mine = runs.filter((r) => ((r.values.agent as Array<{ id: string }>) ?? []).some((l) => l.id === nonAi));
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine.every((r) => r.values.status === runStatusIds['Succeeded'])).toBe(true);
  });

  it('the Your-own-AI Run keeps its step log and class stamp (only its status word changed: Queued, not Succeeded)', async () => {
    const agent = await mkAgent(owner, 'Handoff bot');
    const run = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`)).json();
    const steps = JSON.stringify(run.values.steps);
    expect(steps).toContain('principal.resolve');
    expect(steps).toContain('wake.queued');
    expect(run.values.status).toBe(runStatusIds['Queued']);
    expect((await pool.query("select o.label from select_options o where o.id = $1", [run.values.run_class])).rows[0].label).toBe('Your own AI');
  });
});

describe('the queue is readable, with ONE derived run_state and honest waiting counts', () => {
  it('wakes are created for a Your-own-AI agent with NO Runner, and counted as waiting; the agent is one that cannot run', async () => {
    const agent = await mkAgent(owner, 'Homeless bot');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/run`);
    const list = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json();
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ status: 'queued', run_state: { state: 'waiting_for_runner' }, agent: { id: agent, name: 'Homeless bot' } });
    const summary = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json();
    const mine = summary.agents.find((a: { agent_id: string }) => a.agent_id === agent);
    expect(mine).toMatchObject({ can_run: false, waiting: 1, runner: null });
    expect(summary.waiting_total).toBeGreaterThanOrEqual(1);
    expect(summary.agents_that_cannot_run).toBeGreaterThanOrEqual(1);
  });

  it('the state follows the wake: waiting_for_runner -> running -> done, offline and limit are derived, nothing recomputed by the client', async () => {
    const agent = await mkAgent(owner, 'Stateful bot');
    const ticket = await mkTicket('Stateful ticket');
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket });
    const runner = await pairRunner(owner, [agent]);
    const state = async () => ((await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?record=${ticket}`)).json().data[0].run_state) as { state: string; runner_name?: string; until?: string; since?: string };
    expect(await state()).toMatchObject({ state: 'waiting_for_runner', runner_name: "Owner's MacBook" });
    // Silent past the offline gap: derived, not stored.
    await pool.query("update runners set last_seen_at = now() - interval '5 minutes' where id = $1", [runner.id]);
    expect(await state()).toMatchObject({ state: 'runner_offline' });
    await pool.query("update runners set last_seen_at = now() where id = $1", [runner.id]);
    const got = (await claim(runner.token)).json().wakes[0];
    expect(await state()).toMatchObject({ state: 'running', runner_name: "Owner's MacBook" });
    expect(await runStatus(got.run_id)).toBe('Running');
    await agentSaid(got.id);
    const done = await asRunner(runner.token, 'POST', `/runner/v1/wakes/${got.id}/complete`, { nonce: got.nonce, exit: 'ok', summary: 'Triaged it' });
    expect(done.statusCode, done.body).toBe(200);
    expect(await state()).toMatchObject({ state: 'done' });
    expect(await runStatus(got.run_id)).toBe('Succeeded');
  });

  it('a viewer sees only wakes they may read, and a hidden wake is not COUNTED (a count never reveals what a 404 would hide)', async () => {
    const agent = await mkAgent(owner, 'Visibility bot');
    const secret = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Quiet room' })).json().id as string;
    const hidden = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secret}/records`, { values: { name: 'Hidden record' } })).json().id as string;
    const shown = await mkTicket('Shown record');
    expect((await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: hidden, requestedBy: null })).outcome).toBe('created');
    expect((await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: shown, requestedBy: null })).outcome).toBe('created');
    const adminView = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json();
    expect(adminView.data).toHaveLength(2);
    // The full guest holds grants on Tickets and the Agents database, not on "Quiet room".
    const guestView = (await as(guestFull.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`)).json();
    expect(guestView.data.map((w: { record: { id: string } }) => w.record.id)).toEqual([shown]);
    expect((await as(guestFull.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json().agents.find((a: { agent_id: string }) => a.agent_id === agent).waiting).toBe(1);
    expect((await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json().agents.find((a: { agent_id: string }) => a.agent_id === agent).waiting).toBe(2);
    // A guest with no grant on the Agents database sees no agent and no wake at all.
    const blind = await as(guestPartial.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}`);
    expect(blind.json().data).toEqual([]);
    expect((await as(guestPartial.token, 'GET', `/workspaces/${ws}/agent-wakes/summary`)).json()).toMatchObject({ agents: [], waiting_total: 0 });
    expect((await as(null, 'GET', `/workspaces/${ws}/agent-wakes`)).statusCode).toBe(401);
  });

  it('paginates with a cursor', async () => {
    const agent = await mkAgent(owner, 'Paging bot');
    for (let i = 0; i < 3; i++) await wakes.enqueue({ workspaceId: ws, agentId: agent, reason: 'manual', recordId: await mkTicket(`Page ${i}`), requestedBy: null });
    const p1 = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}&limit=2`)).json();
    expect(p1.data).toHaveLength(2);
    expect(p1.next_cursor).toBeTruthy();
    const p2 = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agent}&limit=2&cursor=${p1.next_cursor}`)).json();
    expect(p2.data).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
  });
});

describe('the claim: atomic, leased, fenced', () => {
  let runnerA: { token: string; id: string };
  let agentA: string;
  let ticketA: string;

  beforeAll(async () => {
    agentA = await mkAgent(owner, 'Claim bot');
    runnerA = await pairRunner(owner, [agentA]);
  });

  async function freshWake() {
    // Settle whatever is open for the agent so each test starts from one new queued wake.
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1 and status in ('queued','claimed')", [agentA]);
    ticketA = await mkTicket('Claimed ticket');
    const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agentA}/delegate`, { record_id: ticketA });
    expect(res.statusCode, res.body).toBe(201);
    return (await openWakes(agentA))[0] as { id: string; run_id: string };
  }

  it('hands the wake out with a lease and a nonce, and NEVER record text; a pending or foreign Runner gets nothing', async () => {
    const w = await freshWake();
    const res = await claim(runnerA.token);
    expect(res.statusCode, res.body).toBe(200);
    const [got] = res.json().wakes;
    expect(got).toMatchObject({ id: w.id, reason: 'manual', lease_seconds: WAKE_LEASE_SECONDS, credential: { scope: 'read' }, agent: { id: agentA, name: 'Claim bot' }, record: { id: ticketA } });
    expect(got.nonce).toBeTruthy();
    expect(JSON.stringify(got)).not.toContain('Claimed ticket'); // an id and a reference, never the record's text
    const row = (await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id);
    expect(row).toMatchObject({ status: 'claimed', runner_id: runnerA.id });
    const lease = new Date(row.lease_expires_at).getTime() - Date.now();
    expect(lease).toBeGreaterThan(80_000);
    expect(lease).toBeLessThanOrEqual(90_000);
    // Nothing left: 204.
    expect((await claim(runnerA.token)).statusCode).toBe(204);
  });

  it('TWO CONCURRENT CLAIMS: exactly one gets the wake', async () => {
    await freshWake();
    const results = await Promise.all([claim(runnerA.token), claim(runnerA.token), claim(runnerA.token)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 204, 204]);
    const winner = results.find((r) => r.statusCode === 200)!.json();
    expect(winner.wakes).toHaveLength(1);
    expect((await openWakes(agentA)).filter((w: { status: string }) => w.status === 'claimed')).toHaveLength(1);
  });

  it('a second claim of a wake that is taken gets a clear refusal when it names the wake', async () => {
    const w = await freshWake();
    expect((await claim(runnerA.token, { wake_id: w.id })).statusCode).toBe(200);
    const again = await claim(runnerA.token, { wake_id: w.id });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('wake_already_claimed');
  });

  it("a Runner claims only wakes for agents assigned to IT: another member's Runner gets nothing, with the same empty answer", async () => {
    await freshWake();
    const runnerB = await pairRunner(other);
    const agentOfB = await mkAgent(other, 'Other bot');
    await as(other.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agentOfB}`, { runner_id: runnerB.id });
    expect((await claim(runnerB.token)).statusCode).toBe(204);
    const named = await claim(runnerB.token, { wake_id: (await openWakes(agentA))[0].id });
    expect(named.statusCode).toBe(204); // not even a hint that the wake exists
    expect((await openWakes(agentA))[0].status).toBe('queued');
    // A pending (not yet turned on) Runner does nothing.
    const code = (await as(owner.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json();
    const pending = (await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() })).json().token as string;
    const refused = await claim(pending);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('runner_not_active');
    // PAT / session on the Runner route: refused.
    expect((await as(owner.token, 'POST', '/runner/v1/claim', {})).statusCode).toBe(401);
  });

  it('an agent that is disabled, or whose owner left, is not claimable (and the wake waits)', async () => {
    const w = await freshWake();
    const field = (await pool.query("select id from fields where database_id = $1 and api_name = 'enabled'", [agentsDbId])).rows[0].id;
    await pool.query("update records set values = jsonb_set(values, ARRAY[$1], 'false'::jsonb) where id = $2", [field, agentA]);
    expect((await claim(runnerA.token)).statusCode).toBe(204);
    await pool.query("update records set values = jsonb_set(values, ARRAY[$1], 'true'::jsonb) where id = $2", [field, agentA]);
    expect((await claim(runnerA.token, { wake_id: w.id })).statusCode).toBe(200);
  });

  it('the lease is renewed by heartbeat and fenced by the nonce: a stale nonce, another Runner, or no wake is 409 lease_lost', async () => {
    await freshWake();
    const got = (await claim(runnerA.token)).json().wakes[0];
    await pool.query("update agent_wakes set lease_expires_at = now() + interval '10 seconds' where id = $1", [got.id]);
    const beat = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${got.id}/heartbeat`, { nonce: got.nonce });
    expect(beat.statusCode, beat.body).toBe(200);
    const lease = new Date((await wakeRows(agentA)).find((r: { id: string }) => r.id === got.id).lease_expires_at).getTime() - Date.now();
    expect(lease).toBeGreaterThan(80_000);
    const stale = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${got.id}/heartbeat`, { nonce: 'not-the-nonce' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('lease_lost');
    const runnerB = await pairRunner(other);
    expect((await asRunner(runnerB.token, 'POST', `/runner/v1/wakes/${got.id}/heartbeat`, { nonce: got.nonce })).statusCode).toBe(409);
    expect((await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/00000000-0000-4000-8000-000000000000/heartbeat`, { nonce: got.nonce })).statusCode).toBe(409);
  });

  it('an EXPIRED lease returns the wake to the queue (attempts + 1) and the next claim gets it with a NEW nonce; the old Runner is told lease_lost', async () => {
    const w = await freshWake();
    const first = (await claim(runnerA.token)).json().wakes[0];
    await pool.query("update agent_wakes set lease_expires_at = now() - interval '1 second' where id = $1", [w.id]);
    expect((await sweeper.sweep()).leasesReturned).toBeGreaterThanOrEqual(1); // the sweep is global: other tests' rows may be reaped too, so the row below is the proof
    const back = (await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id);
    expect(back).toMatchObject({ status: 'queued', runner_id: null, claim_nonce: null, attempts: 1 });
    expect(await runStatus(w.run_id)).toBe('Queued');
    expect((await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/heartbeat`, { nonce: first.nonce })).json().error.code).toBe('lease_lost');
    expect((await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: first.nonce, exit: 'ok' })).json().error.code).toBe('lease_lost');
    const second = (await claim(runnerA.token)).json().wakes[0];
    expect(second.id).toBe(w.id);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it('a wake that loses its lease three times FAILS: its Run says so and its owner is told once', async () => {
    const w = await freshWake();
    for (let i = 0; i < 3; i++) {
      expect((await claim(runnerA.token)).statusCode).toBe(200);
      await pool.query("update agent_wakes set lease_expires_at = now() - interval '1 second' where id = $1", [w.id]);
      await sweeper.sweep();
    }
    const failed = (await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id);
    expect(failed).toMatchObject({ status: 'failed', attempts: 3 });
    expect(await runStatus(w.run_id)).toBe('Failed');
    expect(JSON.stringify((await runRecord(w.run_id)).values.steps)).toContain('stopped answering');
    const notes = await pool.query("select count(*)::int n from notifications where type = 'agent_wake_failed' and user_id = $1 and record_id = $2", [owner.id, ticketA]);
    expect(notes.rows[0].n).toBe(1);
    expect((await claim(runnerA.token)).statusCode).toBe(204);
  });

  it('COMPLETION removes the wake from the queue, writes the Run, is idempotent on (id, nonce), and the next trigger is a NEW wake', async () => {
    const w = await freshWake();
    const got = (await claim(runnerA.token)).json().wakes[0];
    await agentSaid(w.id);
    const done = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit: 'ok', summary: 'Done it', usage: null, tool_version: '2.1.104' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json()).toMatchObject({ status: 'done', requeued: false, repeated: false });
    expect(await openWakes(agentA)).toHaveLength(0); // gone from the open queue
    expect(await runStatus(w.run_id)).toBe('Succeeded');
    const retry = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit: 'ok' });
    expect(retry.json()).toMatchObject({ status: 'done', repeated: true });
    expect((await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: 'wrong', exit: 'ok' })).statusCode).toBe(409);
    expect((await claim(runnerA.token)).statusCode).toBe(204);
    // The same agent and record can be woken again: a fresh wake, not a merge into the finished one.
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agentA}/delegate`, { record_id: ticketA });
    const open = await openWakes(agentA);
    expect(open).toHaveLength(1);
    expect(open[0].id).not.toBe(w.id);
  });

  it('a failed or timed-out run fails the wake and the Run; an aborted one cancels them', async () => {
    for (const [exit, wake, run] of [['error', 'failed', 'Failed'], ['timeout', 'failed', 'Failed'], ['aborted', 'canceled', 'Canceled']] as const) {
      const w = await freshWake();
      const got = (await claim(runnerA.token)).json().wakes[0];
      const res = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit, error: 'boom' });
      expect(res.json().status).toBe(wake);
      expect(await runStatus(w.run_id)).toBe(run);
    }
  });

  it('limit_reached pauses the Runner until the stated time and puts the wake back; the state is waiting_for_limit with that time', async () => {
    const w = await freshWake();
    const got = (await claim(runnerA.token)).json().wakes[0];
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const res = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit: 'limit_reached', limit_reached_until: until });
    expect(res.json()).toMatchObject({ status: 'queued', requeued: true });
    expect(await runStatus(w.run_id)).toBe('Queued');
    expect((await claim(runnerA.token)).statusCode).toBe(204); // paused
    const list = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agentA}`)).json().data.find((x: { id: string }) => x.id === w.id);
    expect(list.run_state).toMatchObject({ state: 'waiting_for_limit', tool: 'claude-code' });
    expect(new Date(list.run_state.until).toISOString()).toBe(until);
    await pool.query("update runners set paused_until = null, pause_reason = null where id = $1", [runnerA.id]);
    await pool.query("update agent_wakes set not_before = now() where id = $1", [w.id]);
  });

  it('a repeat that arrives while the wake is claimed sets rewake, and completion enqueues ONE fresh wake (nothing lost, nothing concurrent)', async () => {
    const w = await freshWake();
    const got = (await claim(runnerA.token)).json().wakes[0];
    expect((await comment(admin.token, ticketA, [para(agentMention(agentA), txt(' one more thing'))])).statusCode).toBe(201);
    expect((await comment(admin.token, ticketA, [para(agentMention(agentA), txt(' and another'))])).statusCode).toBe(201);
    const claimed = (await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id);
    expect(claimed).toMatchObject({ status: 'claimed', rewake: true });
    expect(await openWakes(agentA)).toHaveLength(1); // never a second concurrent one
    await agentSaid(w.id);
    const res = await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${w.id}/complete`, { nonce: got.nonce, exit: 'ok' });
    expect(res.statusCode).toBe(200);
    const open = await openWakes(agentA);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: 'queued', reason: 'mention', record_id: ticketA });
    expect(open[0].id).not.toBe(w.id);
    expect(open[0].run_id).toBeTruthy();
  });

  it("removing a Runner returns the wakes it had claimed to the queue, in the same step (ticket #1131's AC3, first half)", async () => {
    const w = await freshWake();
    const doomed = await pairRunner(owner, [agentA]);
    expect((await claim(doomed.token)).statusCode).toBe(200);
    expect((await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id)).toMatchObject({ status: 'claimed', runner_id: doomed.id });
    expect(await runStatus(w.run_id)).toBe('Running');
    const removed = await as(owner.token, 'DELETE', `/workspaces/${ws}/runners/${doomed.id}`);
    expect(removed.statusCode).toBe(204);
    const back = (await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id);
    expect(back).toMatchObject({ status: 'queued', runner_id: null, claim_nonce: null, attempts: 0 });
    expect(await runStatus(w.run_id)).toBe('Queued');
    // Its token is dead, and the agent (unassigned by the removal) waits for a Runner.
    expect((await claim(doomed.token)).statusCode).toBe(401);
    const state = (await as(admin.token, 'GET', `/workspaces/${ws}/agent-wakes?agent=${agentA}`)).json().data.find((x: { id: string }) => x.id === w.id);
    expect(state.run_state.state).toBe('waiting_for_runner');
    await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agentA}`, { runner_id: runnerA.id });
  });

  it('an admin cancelling the Run cancels its wake: nothing can claim it, and a Runner mid-run is told lease_lost', async () => {
    const queued = await freshWake();
    // The kill-switch is platform-admin only; the service method it calls is what matters here.
    await app.get(AgentsService).adminCancelRun(ws, queued.run_id, owner.id);
    expect((await wakeRows(agentA)).find((r: { id: string }) => r.id === queued.id)).toMatchObject({ status: 'canceled' });
    expect(await runStatus(queued.run_id)).toBe('Canceled');
    expect((await claim(runnerA.token)).statusCode).toBe(204);

    const running = await freshWake();
    const got = (await claim(runnerA.token)).json().wakes[0];
    await app.get(AgentsService).adminCancelRun(ws, running.run_id, owner.id);
    expect((await asRunner(runnerA.token, 'POST', `/runner/v1/wakes/${running.id}/heartbeat`, { nonce: got.nonce })).json().error.code).toBe('lease_lost');
  });

  it('a queued wake nobody serves for 7 days is cancelled with a reason on its Run', async () => {
    const w = await freshWake();
    await pool.query("update runner_agents set agent_id = agent_id where agent_id = $1", [agentA]);
    await pool.query("update agent_wakes set expires_at = now() - interval '1 minute' where id = $1", [w.id]);
    expect((await sweeper.sweep()).wakesExpired).toBeGreaterThanOrEqual(1);
    expect((await wakeRows(agentA)).find((r: { id: string }) => r.id === w.id)).toMatchObject({ status: 'canceled' });
    expect(await runStatus(w.run_id)).toBe('Canceled');
    expect(JSON.stringify((await runRecord(w.run_id)).values.steps)).toContain('7 days');
  });

  it('the long poll holds the request and answers as soon as a wake arrives', async () => {
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where agent_id = $1 and status in ('queued','claimed')", [agentA]);
    const ticket = await mkTicket('Late ticket');
    const started = Date.now();
    const poll = asRunner(runnerA.token, 'POST', '/runner/v1/claim', { wait_seconds: 5 });
    await new Promise((r) => setTimeout(r, 1200));
    await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agentA}/delegate`, { record_id: ticket });
    const res = await poll;
    expect(res.statusCode, res.body).toBe(200);
    expect(Date.now() - started).toBeGreaterThan(1000);
    expect(Date.now() - started).toBeLessThan(4500);
  });
});
