import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * Ticket #1227 — a Runner is a colleague's own computer. Which machine, and which tool, is for the people who work with the
 * Runner; a GUEST is told THAT a Runner served the work ("a Runner") and nothing that identifies it. The wake list already said
 * so (ticket #1215); this file holds every other surface that carries the Runner's identity to the same rule.
 *
 * Two kinds of surface carry it:
 *   1. the Run record's own `runner` / `tool` / `tool_version` fields and the Steps log line that names them, read through every
 *      path that serves a record (get, by-number, list, query, aggregates, export, history, activity);
 *   2. the Runner stamp on what a run WROTE somewhere else: a comment on a ticket, a record version (`runner_id` / `runner_name`).
 *
 * The Runs database is a system database and is closed to a guest at the access layer (ticket #1331), so (1) is also asserted
 * through the service seam a guest could still reach if that door ever opened. A guest fixture is the whole point of the file:
 * every assertion below that is "absent" is paired with the same read by an owner/admin/member that DOES see the name.
 */
const SECRET = 'SECRET-MACHINE-7';
const SECRET_TOOL = 'claude-code';

let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;
let admin: { token: string; email: string };
let owner: Person;
let member: Person;
let guest: Person;
let runId: string;
let runNumber: number;
let ticket: string;
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const body = (res: { body: string }) => res.body;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'IdAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Runner identity WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  runsDbId = ensured.runsDb.id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  owner = await joinAs(app, admin.token, ws, 'IdOwner', 'member');
  member = await joinAs(app, admin.token, ws, 'IdMember', 'member');
  // The guest holds viewer grants on the Agents pack AND the Runs database (the ticket's repro) plus the tickets.
  guest = await joinAs(app, admin.token, ws, 'IdGuest', 'guest', [
    { database_id: ticketsDbId, role: 'commenter' },
    { database_id: agentsDbId, role: 'viewer' },
    { database_id: runsDbId, role: 'viewer' },
  ]);

  const aiOpts = await pool.query("select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode'", [agentsDbId]);
  const ownAi = aiOpts.rows.find((r: { label: string }) => r.label === 'Your own AI').id;
  const agent = (await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name: 'Identity bot', enabled: true, ai_mode: ownAi } })).json().id as string;
  ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: 'Delegated' } })).json().id;

  // A paired, activated Runner whose machine is called SECRET, assigned to the agent; a delegated ticket is claimed and completed.
  const code = (await as(owner.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const tools = [{ id: SECRET_TOOL, name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, machine_name: SECRET, tools, runner_version: '0.1.0', protocol_version: 1 });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token: runnerToken, runner } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(owner.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: SECRET_TOOL })).statusCode).toBe(200);
  expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runner.id })).statusCode).toBe(200);
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const claimed = await asRunner(runnerToken, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const got = (claimed.json() as { wakes: Array<{ id: string; nonce: string }> }).wakes[0]!;
  const wake = (await pool.query('select record_id, run_id, agent_id from agent_wakes where id = $1', [got.id])).rows[0];
  runId = wake.run_id;
  // The agent "comments" on its record (the must-comment backstop), stamped with the Runner it ran on, as a run credential does.
  await pool.query(
    "insert into comments (record_id, author_id, body, source, agent_id, agent_name, run_id, runner_id, runner_name) values ($1, 'test-author', '[]'::jsonb, 'agent', $2, 'Identity bot', $3, $4, $5)",
    [wake.record_id, wake.agent_id, wake.run_id, runner.id, SECRET],
  );
  const done = await asRunner(runnerToken, 'POST', `/runner/v1/wakes/${got.id}/complete`, { nonce: got.nonce, exit: 'ok', summary: 'Triaged it', tool_version: '2.1.104' });
  expect(done.statusCode, done.body).toBe(200);
  // A record version the same run wrote on the ticket.
  await pool.query(
    "insert into record_versions (workspace_id, record_id, actor_id, source, agent_id, agent_name, run_id, runner_id, runner_name, values, title) values ($1, $2, $3, 'agent', $4, 'Identity bot', $5, $6, $7, '{}'::jsonb, 'Delegated')",
    [ws, ticket, owner.id, wake.agent_id, runId, runner.id, SECRET],
  );
  runNumber = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${runsDbId}/records/${runId}`)).json().number;
}, 180_000);

afterAll(async () => {
  await app.close();
  await pool.end();
});

const runUrl = (suffix = '') => `/workspaces/${ws}/databases/${runsDbId}/records/${runId}${suffix}`;
const runsUrl = (suffix = '') => `/workspaces/${ws}/databases/${runsDbId}/records${suffix}`;

describe('fixture sanity: the people who work with the Runner DO see it (what must be KEPT)', () => {
  for (const [who, get] of [
    ['an admin', () => admin],
    ['a member', () => member],
    ['the Runner owner', () => owner],
  ] as const) {
    it(`${who} reads the machine name and tool on the Run record`, async () => {
      const res = await as(get().token, 'GET', runUrl());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().values).toMatchObject({ runner: SECRET, tool: SECRET_TOOL });
      const list = await as(get().token, 'GET', runsUrl('?limit=50'));
      expect(body(list)).toContain(SECRET);
    });
  }

  it('a member reads the Runner stamp on a comment and on a version, and the Steps log line that names the machine', async () => {
    const comments = (await as(member.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/comments`)).json();
    expect(comments.data.find((c: { runner_name: string | null }) => c.runner_name)?.runner_name).toBe(SECRET);
    const versions = (await as(member.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/versions`)).json();
    expect(versions.data.find((v: { runner_name: string | null }) => v.runner_name)?.runner_name).toBe(SECRET);
    const run = (await as(member.token, 'GET', runUrl())).json();
    expect(JSON.stringify(run.values.steps)).toContain(SECRET);
  });
});

describe('a guest never reads which machine or tool a Runner is (ticket #1227)', () => {
  it('the Run record: get, by number, list, query and the search of its values answer without the machine name or tool', async () => {
    const responses = [
      await as(guest.token, 'GET', runUrl()),
      await as(guest.token, 'GET', runsUrl(`/by-number/${runNumber}`)),
      await as(guest.token, 'GET', runsUrl('?limit=50')),
      await as(guest.token, 'POST', runsUrl('/query'), { limit: 50 }),
    ];
    for (const res of responses) {
      expect(res.body, `${res.statusCode}`).not.toContain(SECRET);
      expect(res.body).not.toContain(SECRET_TOOL);
    }
  });

  it('the Run record read through the service a guest-bound request uses: runner is "a Runner", tool and tool_version are absent, and so is the machine in the Steps log', async () => {
    // Direct seam: RecordsService.get with a GUEST membership, the exit every record read shares (attachLinks). This is the layer
    // the access door (#1331) sits in front of, so the rule holds even where a grant on a system database is ever honoured again.
    const { RecordsService } = await import('../src/records/records.service');
    const records = app.get(RecordsService);
    const memberships = (await pool.query("select * from memberships where user_id = $1 and workspace_id = $2", [guest.id, ws])).rows[0];
    const guestMembership = { id: memberships.id, userId: guest.id, workspaceId: ws, role: 'guest', bound: false } as never;
    const seen = await records.get(runsDbId, runId, guestMembership);
    expect(seen.values['runner']).toBe('a Runner');
    expect(seen.values['tool']).toBeUndefined();
    expect(seen.values['tool_version']).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).not.toContain(SECRET_TOOL);
    // What must be KEPT: the fields that do not identify the Runner are untouched, and a non-guest membership sees everything.
    expect(seen.values['summary']).toBe('Triaged it');
    const asMember = await records.get(runsDbId, runId, { ...guestMembership, role: 'member' });
    expect(asMember.values).toMatchObject({ runner: SECRET, tool: SECRET_TOOL });
    // A query that names the hidden field is refused as an unknown field, the same as a field that does not exist (no oracle).
    await expect(
      records.query(runsDbId, { limit: 10, sorts: [], filter: { and: [{ field: 'runner', op: 'contains', value: 'SECRET' }] } } as never, guest.id, guestMembership),
    ).rejects.toThrow(/runner/);
    await expect(records.query(runsDbId, { limit: 10, sorts: [{ field: 'tool', direction: 'asc' }] } as never, guest.id, guestMembership)).rejects.toThrow(/tool/);
    // KEPT: a member's identical filter and grouping work, so the refusal above is the mask and not a broken field.
    const hit = await records.query(runsDbId, { limit: 10, sorts: [], filter: { and: [{ field: 'runner', op: 'contains', value: 'SECRET' }] } } as never, guest.id, { ...guestMembership, role: 'member' });
    expect(hit.data).toHaveLength(1);
    const grouped = await records.groupedAggregate(runsDbId, { group_by: 'runner', op: 'count' }, guest.id, { ...guestMembership, role: 'member' });
    expect(JSON.stringify(grouped)).toContain(SECRET);
    // Counting by the field is refused too (one group per distinct machine would list them).
    await expect(records.groupedAggregate(runsDbId, { group_by: 'runner', op: 'count' } as never, guest.id, guestMembership)).rejects.toThrow(/runner/);
  });

  it("the Run record's history and activity name no machine or tool either (field changes, versions, the activity feed)", async () => {
    const { RecordsService } = await import('../src/records/records.service');
    const records = app.get(RecordsService);
    const memberships = (await pool.query("select * from memberships where user_id = $1 and workspace_id = $2", [guest.id, ws])).rows[0];
    const guestMembership = { id: memberships.id, userId: guest.id, workspaceId: ws, role: 'guest', bound: false } as never;
    const changes = await records.listFieldChanges(runsDbId, runId, 100, undefined, guestMembership);
    expect(JSON.stringify(changes)).not.toContain(SECRET);
    expect(JSON.stringify(changes)).not.toContain(SECRET_TOOL);
    // KEPT: the same read by a member does carry the change to the Runner field (the guard is not "no history").
    const asMember = await records.listFieldChanges(runsDbId, runId, 100, undefined, { ...guestMembership, role: 'member' });
    expect(JSON.stringify(asMember)).toContain(SECRET);
    const { ActivityService } = await import('../src/activity/activity.service');
    const activity = await app.get(ActivityService).listForRecord(guestMembership, runsDbId, runId, 100);
    expect(JSON.stringify(activity)).not.toContain(SECRET);
    expect(JSON.stringify(activity)).not.toContain(SECRET_TOOL);
    const memberActivity = await app.get(ActivityService).listForRecord({ ...(guestMembership as object), role: 'member' } as never, runsDbId, runId, 100);
    expect(JSON.stringify(memberActivity)).toContain(SECRET);
  });

  it('the preview of restoring an old version of a Run names no machine or tool (the diff against the current record)', async () => {
    const { RecordsService } = await import('../src/records/records.service');
    const records = app.get(RecordsService);
    const memberships = (await pool.query("select * from memberships where user_id = $1 and workspace_id = $2", [guest.id, ws])).rows[0];
    const guestMembership = { id: memberships.id, userId: guest.id, workspaceId: ws, role: 'guest', bound: false } as never;
    const version = (await pool.query("insert into record_versions (workspace_id, record_id, actor_id, source, values, title) values ($1, $2, $3, 'human', '{}'::jsonb, 'older') returning id", [ws, runId, owner.id])).rows[0];
    const seen = await records.getVersion(runsDbId, runId, version.id, guestMembership);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).not.toContain(SECRET_TOOL);
    // KEPT: the preview still lists the other fields that differ (it is not emptied), and a member sees the machine in it.
    expect(seen.preview.some((p) => p.field_name === 'Summary')).toBe(true);
    const asMember = await records.getVersion(runsDbId, runId, version.id, { ...guestMembership, role: 'member' });
    expect(JSON.stringify(asMember)).toContain(SECRET);
  });

  it('a comment a run wrote on a ticket the guest can read carries no Runner id or machine name; agent and run stay', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/comments`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const stamped = res.json().data.find((c: { agent_name: string | null }) => c.agent_name === 'Identity bot');
    expect(stamped).toMatchObject({ agent_name: 'Identity bot', source: 'agent', runner_name: 'a Runner', runner_id: null });
    expect(stamped.run_id).toBe(runId);
  });

  it('a record version a run wrote on a ticket carries no Runner id or machine name', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/versions`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const stamped = res.json().data.find((v: { agent_name: string | null }) => v.agent_name === 'Identity bot');
    expect(stamped).toMatchObject({ agent_name: 'Identity bot', runner_name: 'a Runner', runner_id: null });
  });

  it('a version or comment with NO Runner stamp is unchanged (the mask does not invent a Runner)', async () => {
    const res = await as(guest.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/comments`, { body: { format: 'blocknote', doc: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello', styles: {} }] }] } });
    expect(res.statusCode, res.body).toBe(201);
    const list = (await as(guest.token, 'GET', `/workspaces/${ws}/databases/${ticketsDbId}/records/${ticket}/comments`)).json();
    const mine = list.data.find((c: { author: { id: string } }) => c.author.id === guest.id);
    expect(mine.runner_name).toBeNull();
    expect(mine.runner_id).toBeNull();
  });
});
