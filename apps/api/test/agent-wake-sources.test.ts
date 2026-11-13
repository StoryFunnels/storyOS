import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { agentWakeSourcesResponseSchema } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { BUILT_IN_WAKE_SOURCES, CONFIGURED_WAKE_REASONS, WAKE_REASONS } from '../src/runners/wake.constants';

/**
 * ticket #1289 (Otto's ruling of 2026-11-12) — GET /workspaces/{ws}/agents/{agent}/wake-sources lists EVERYTHING that can start an
 * agent: its agent triggers and every automation rule with a run_agent action for it. Readable by the agent's MANAGER and by admins.
 *
 * Fixtures: an ADMIN, the agent's MANAGER (a member, `created_by` of the agent), another MEMBER who manages nothing, a GUEST (only
 * guests and restricted databases can have partial access, so a test without them proves nothing), and an admin of a SECOND workspace.
 * Every refusal is compared on the BODY as well as the status: a refusal must not tell an unknown agent from a forbidden one.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let admin: { token: string };
let manager: Person;
let other: Person;
let guest: Person;
let stranger: { token: string };
let aiMode = '';
let ticketsDb = '', secretDb = '', membersNamedDb = '', viewerDb = '', creatorDb = '';
let stateField = '', todoOpt = '', reviewOpt = '', teamField = '';
let secretStateField = '';
const { pool } = connectTestDb();

const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const url = (agent: string, w = ws) => `/workspaces/${w}/agents/${agent}/wake-sources`;
const SECRET_RULE = 'Payroll alarm rule';
const SECRET_DB_NAME = 'Payroll vault';

async function mkAgent(token: string, name: string): Promise<{ id: string; number: number }> {
  const res = await as(token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name, enabled: true, ai_mode: aiMode } });
  expect(res.statusCode, res.body).toBe(201);
  return { id: res.json().id as string, number: res.json().number as number };
}
async function mkTrigger(agent: string, body: Record<string, unknown>): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/agents/triggers`, { agent, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
async function mkRule(db: string, name: string, trigger: unknown, agent: string, extraActions: unknown[] = []): Promise<string> {
  const res = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/automations`, {
    name,
    trigger,
    actions: [...extraActions, { type: 'run_agent', agent, target: 'trigger_record' }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}
const refusal = (res: { json: () => { error: Record<string, unknown> } }) => ({ ...res.json().error, request_id: undefined });
const read = async (token: string | null, agent: string, w = ws) => as(token, 'GET', url(agent, w));
const sourcesOf = async (token: string, agent: string) => {
  const res = await read(token, agent);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { agent_id: string; sources: Array<Record<string, any>>; withheld_count: number };
};

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'WakeSrcAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Wake sources WS' })).json().id;
  agentsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json().agentsDb.id;
  aiMode = (await pool.query("select o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = 'ai_mode' and o.label = 'Your own AI'", [agentsDbId])).rows[0].id;
  const space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;

  ticketsDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tickets' })).json().id;
  const state = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDb}/fields`, { display_name: 'Status', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'In review' }] })).json();
  stateField = state.id;
  todoOpt = state.options.find((o: { label: string }) => o.label === 'Todo').id;
  reviewOpt = state.options.find((o: { label: string }) => o.label === 'In review').id;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/relations`, { database_a_id: ticketsDb, database_b_id: agentsDbId, cardinality: 'many_to_many', field_a_name: 'Assigned agent', field_b_name: 'Tickets' })).statusCode).toBe(201);
  teamField = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${ticketsDb}`)).json().fields.find((f: { displayName: string }) => f.displayName === 'Assigned agent').id;

  secretDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: SECRET_DB_NAME })).json().id;
  const secretState = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${secretDb}/fields`, { display_name: 'Salary band', type: 'select', config: {}, options: [{ label: 'Band A' }, { label: 'Band B' }] })).json();
  secretStateField = secretState.id;
  await setRestricted(app, admin.token, ws, 'database', secretDb); // the manager holds no grant on it

  membersNamedDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Members' })).json().id; // a USER database that merely has the name
  await as(admin.token, 'POST', `/workspaces/${ws}/databases/${membersNamedDb}/fields`, { display_name: 'Tier', type: 'select', config: {}, options: [{ label: 'Gold' }] });

  manager = await joinAs(app, admin.token, ws, 'WakeSrcManager', 'member');
  // #1289 rule-name gate: two RESTRICTED databases, the manager holds only `viewer` on one and `creator` on the other.
  viewerDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Ops board' })).json().id;
  creatorDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Build board' })).json().id;
  await setRestricted(app, admin.token, ws, 'database', viewerDb);
  await setRestricted(app, admin.token, ws, 'database', creatorDb);
  await grant(app, admin.token, ws, manager.id, { database_id: viewerDb }, 'viewer');
  await grant(app, admin.token, ws, manager.id, { database_id: creatorDb }, 'creator');
  other = await joinAs(app, admin.token, ws, 'WakeSrcOther', 'member');
  guest = await joinAs(app, admin.token, ws, 'WakeSrcGuest', 'guest', [{ database_id: ticketsDb, role: 'viewer' }]);
  stranger = await signUpUser(app, 'WakeSrcStranger');
  expect((await as(stranger.token, 'POST', '/workspaces', { name: 'Elsewhere WS' })).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('#1289 what an agent is woken by', () => {
  let agent: { id: string; number: number };
  let trigState: string, trigRelation: string, trigGated: string, trigOff: string;
  let ruleCreated: string, ruleUpdated: string, ruleLinked: string, ruleSchedule: string, ruleByNumber: string;

  beforeAll(async () => {
    agent = await mkAgent(manager.token, 'Wake source agent');
    const rival = await mkAgent(other.token, 'Somebody else agent');
    trigState = await mkTrigger(agent.id, { database_id: ticketsDb, state_field_id: stateField, state_option_id: todoOpt, enabled: true });
    trigGated = await mkTrigger(agent.id, { database_id: ticketsDb, state_field_id: stateField, state_option_id: reviewOpt, human_gate: true, enabled: true });
    trigOff = await mkTrigger(agent.id, { database_id: membersNamedDb, state_field_id: (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${membersNamedDb}`)).json().fields.find((f: { displayName: string }) => f.displayName === 'Tier').id, state_option_id: (await pool.query("select o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and o.label = 'Gold'", [membersNamedDb])).rows[0].id, enabled: false });
    trigRelation = await mkTrigger(agent.id, { database_id: ticketsDb, relation_field_id: teamField, enabled: true });
    ruleCreated = await mkRule(ticketsDb, 'On new ticket', { type: 'record_created' }, agent.id);
    ruleUpdated = await mkRule(ticketsDb, 'On status change', { type: 'record_updated', field_id: stateField }, agent.id, [{ type: 'add_comment', body_template: 'hi' }]);
    ruleLinked = await mkRule(ticketsDb, 'On link', { type: 'record_linked', relation_field_id: teamField, direction: 'link' }, agent.id);
    ruleSchedule = await mkRule(ticketsDb, 'Every morning', { type: 'schedule', every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Kyiv' }, agent.id);
    ruleByNumber = await mkRule(ticketsDb, 'Named by number', { type: 'record_created' }, String(agent.number));
    // What must be KEPT OUT: another agent's trigger and rule, and a rule that has no run_agent action at all.
    await mkTrigger(rival.id, { database_id: ticketsDb, state_field_id: stateField, state_option_id: todoOpt, enabled: true });
    await mkRule(ticketsDb, 'Rival rule', { type: 'record_created' }, rival.id);
    const plain = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDb}/automations`, { name: 'No agent here', trigger: { type: 'record_created' }, actions: [{ type: 'add_comment', body_template: 'x' }] });
    expect(plain.statusCode, plain.body).toBe(201);
    // A rule only an admin can see the database of.
    await mkRule(secretDb, SECRET_RULE, { type: 'record_updated', field_id: secretStateField }, agent.id);
    await mkTrigger(agent.id, { database_id: secretDb, state_field_id: secretStateField, state_option_id: (await pool.query("select o.id from select_options o where o.field_id = $1 and o.label = 'Band A'", [secretStateField])).rows[0].id, enabled: true });
  }, 120_000);

  it('an admin sees every source: triggers (state and relation, on and off, gated) and every kind of rule', async () => {
    const out = await sourcesOf(admin.token, agent.id);
    expect(out.agent_id).toBe(agent.id);
    expect(out.withheld_count).toBe(0);
    // the contract the SDK and the agent page are built on
    expect(() => agentWakeSourcesResponseSchema.parse(out)).not.toThrow();
    const byId = new Map(out.sources.map((s) => [s.id, s]));
    expect(out.sources.length).toBe(11 + Object.keys(BUILT_IN_WAKE_SOURCES).length); // 5 triggers + 6 rules, the secret database's trigger and rule included (an admin opens it), then the built-in entries

    expect(byId.get(trigState)).toMatchObject({ kind: 'agent_trigger', binding: 'state', enabled: true, human_gate: false, database: { id: ticketsDb, name: 'Tickets', exists: true, is_system: false }, state_field: { id: stateField, name: 'Status' }, state_option: { id: todoOpt, name: 'Todo' }, relation_field: null });
    expect(byId.get(trigGated)).toMatchObject({ binding: 'state', human_gate: true, state_option: { name: 'In review' } });
    expect(byId.get(trigOff)).toMatchObject({ enabled: false, database: { name: 'Members' } });
    expect(byId.get(trigRelation)).toMatchObject({ binding: 'relation', relation_field: { id: teamField, name: 'Assigned agent' }, state_field: null, state_option: null });

    expect(byId.get(ruleCreated)).toMatchObject({ kind: 'automation', name: 'On new ticket', enabled: true, database: { name: 'Tickets' }, trigger: { type: 'record_created', field: null, relation_field: null, direction: null, schedule: null } });
    expect(byId.get(ruleUpdated)).toMatchObject({ trigger: { type: 'record_updated', field: { id: stateField, name: 'Status' } } }); // wakes among other actions
    expect(byId.get(ruleLinked)).toMatchObject({ trigger: { type: 'record_linked', relation_field: { name: 'Assigned agent' }, direction: 'link' } });
    expect(byId.get(ruleSchedule)).toMatchObject({ trigger: { type: 'schedule', schedule: { every: 'day', at: '09:00', weekdays: [1, 2, 3, 4, 5], timezone: 'Europe/Kyiv' } } });
    expect(byId.get(ruleByNumber)).toMatchObject({ name: 'Named by number' }); // run_agent names the agent by public number too
  });

  it('a disabled rule is listed as off, not hidden', async () => {
    const off = await mkRule(ticketsDb, 'Switched off rule', { type: 'record_created' }, agent.id);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/databases/${ticketsDb}/automations/${off}`, { enabled: false })).statusCode).toBe(200);
    const row = (await sourcesOf(admin.token, agent.id)).sources.find((s) => s.id === off);
    expect(row).toMatchObject({ kind: 'automation', enabled: false });
    await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${ticketsDb}/automations/${off}`);
  });

  it('what must be KEPT OUT: another agent\'s triggers and rules, and a rule with no run_agent action', async () => {
    const out = await sourcesOf(admin.token, agent.id);
    expect(out.sources.some((s) => s.name === 'Rival rule' || s.name === 'No agent here')).toBe(false);
    const rival = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/query`, { filter: { and: [{ field: 'name', op: 'eq', value: 'Somebody else agent' }] }, limit: 1 })).json().data?.[0];
    const rivalOut = await sourcesOf(admin.token, rival.id);
    expect(rivalOut.sources.map((s) => s.kind).sort()).toEqual(['agent_trigger', 'automation', ...Object.keys(BUILT_IN_WAKE_SOURCES).map(() => 'built_in')]);
  });

  it('the manager reads it too, narrowed by what the MANAGER can open: a hidden database is counted, never named', async () => {
    const res = await read(manager.token, agent.id);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.withheld_count).toBe(2); // the secret database's trigger and rule
    expect(out.sources.length).toBe(9 + Object.keys(BUILT_IN_WAKE_SOURCES).length);
    expect(res.body).not.toContain(SECRET_RULE);
    expect(res.body).not.toContain(SECRET_DB_NAME);
    expect(res.body).not.toContain('Salary band');
    expect(res.body).not.toContain('Band A');
    expect(out.sources.find((s: { id: string }) => s.id === ruleCreated)).toMatchObject({ name: 'On new ticket' });
  });

  it('refuses everyone else with the SAME 404 an unknown agent gets', async () => {
    const unknownUuid = await read(manager.token, '11111111-2222-4333-8444-555555555555');
    const unknownNumber = await read(manager.token, '987654');
    expect(unknownUuid.statusCode).toBe(404);
    expect(unknownNumber.statusCode).toBe(404);

    const otherMember = await read(other.token, agent.id); // a member who does not manage THIS agent
    expect(otherMember.statusCode).toBe(404);
    expect(refusal(otherMember)).toEqual(refusal(unknownUuid));
    expect((await read(other.token, String(agent.number))).statusCode).toBe(404);

    // the same member does read the agent he manages (what the refusal above is NOT)
    const rivalOwn = (await as(other.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records/query`, { limit: 50 })).json().data.find((r: { title: string }) => r.title === 'Somebody else agent');
    expect((await read(other.token, rivalOwn.id)).statusCode).toBe(200);
  });

  it('a guest is refused outright (403 for every id, so it says nothing about any agent), as is a stranger and an anonymous call', async () => {
    const real = await read(guest.token, agent.id);
    const fake = await read(guest.token, '11111111-2222-4333-8444-555555555555');
    expect(real.statusCode).toBe(403);
    expect(fake.statusCode).toBe(403);
    expect(refusal(real)).toEqual(refusal(fake));
    expect(real.body).not.toContain('Tickets');

    expect((await read(stranger.token, agent.id)).statusCode).toBe(404); // not a member of this workspace
    expect((await read(null, agent.id)).statusCode).toBe(401);
  });

  it('another workspace cannot read it, by uuid or by number, even as an admin of its own', async () => {
    const wsB = (await as(stranger.token, 'GET', '/workspaces')).json()[0].id as string;
    await as(stranger.token, 'POST', `/workspaces/${wsB}/agents/ensure`);
    expect((await read(stranger.token, agent.id, wsB)).statusCode).toBe(404);
    expect((await read(stranger.token, String(agent.number), wsB)).statusCode).toBe(404);
  });

  it('an agent with nothing wired answers an empty list, not an error', async () => {
    const bare = await mkAgent(manager.token, 'Bare agent');
    // nothing configured, yet never an empty list: the built-in ways to start any agent are always there
    const out = await sourcesOf(manager.token, bare.id);
    expect(out.withheld_count).toBe(0);
    expect(out.sources.every((s) => s.kind === 'built_in')).toBe(true);
    expect(out.sources.map((s) => s.reason)).toEqual(Object.keys(BUILT_IN_WAKE_SOURCES));
  });
});

describe('#1289 what a source may reveal', () => {
  let agent: { id: string; number: number };
  beforeAll(async () => { agent = await mkAgent(manager.token, 'Reveal agent'); });

  it('a SYSTEM database is named but never described; identity is the flag, not the name', async () => {
    const sysDb = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Roster internals' })).json().id as string;
    const f = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${sysDb}/fields`, { display_name: 'Private column', type: 'select', config: {}, options: [{ label: 'Private option' }] })).json();
    const t = await mkTrigger(agent.id, { database_id: sysDb, state_field_id: f.id, state_option_id: f.options[0].id, enabled: true });
    const rule = await mkRule(sysDb, 'System rule', { type: 'record_updated', field_id: f.id }, agent.id);
    await pool.query('update databases set is_system = true where id = $1', [sysDb]);
    const res = await read(admin.token, agent.id);
    const body = res.body;
    expect(body).not.toContain('Private column');
    expect(body).not.toContain('Private option');
    const out = res.json();
    expect(out.sources.find((s: { id: string }) => s.id === t)).toMatchObject({ database: { id: sysDb, name: 'Roster internals', is_system: true }, state_field: { id: f.id, name: null }, state_option: { name: null } });
    expect(out.sources.find((s: { id: string }) => s.id === rule)).toMatchObject({ trigger: { field: { id: f.id, name: null } } });

    // KEPT: a user database that is merely CALLED "Members" is still described in full
    const tier = (await as(admin.token, 'GET', `/workspaces/${ws}/databases/${membersNamedDb}`)).json().fields.find((x: { displayName: string }) => x.displayName === 'Tier').id;
    const named = await mkRule(membersNamedDb, 'Tier rule', { type: 'record_updated', field_id: tier }, agent.id);
    const again = (await read(admin.token, agent.id)).json();
    expect(again.sources.find((s: { id: string }) => s.id === named)).toMatchObject({ database: { name: 'Members', is_system: false }, trigger: { field: { name: 'Tier' } } });
  });

  it('a deleted field, option or database comes back with a null name, never an id standing in for one', async () => {
    const db = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id, name: 'Short lived' })).json().id as string;
    const f = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Phase', type: 'select', config: {}, options: [{ label: 'Kickoff' }, { label: 'Wrap' }] })).json();
    const t = await mkTrigger(agent.id, { database_id: db, state_field_id: f.id, state_option_id: f.options[0].id, enabled: true });
    const del = await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${db}/fields/${f.id}/options/${f.options[0].id}`, { confirm: true });
    expect(del.statusCode, del.body).toBeLessThan(300);
    let row = (await sourcesOf(admin.token, agent.id)).sources.find((s) => s.id === t)!;
    expect(row.state_field).toMatchObject({ name: 'Phase' });
    expect(row.state_option).toMatchObject({ id: f.options[0].id, name: null });

    const gone = await as(admin.token, 'DELETE', `/workspaces/${ws}/databases/${db}`, { confirm: 'Short lived' });
    expect(gone.statusCode, gone.body).toBeLessThan(300);
    row = (await sourcesOf(admin.token, agent.id)).sources.find((s) => s.id === t)!;
    expect(row.database).toEqual({ id: db, name: null, exists: false, is_system: false });
    expect(row.state_field.name).toBeNull();
  });

  it('a field id from ANOTHER database never resolves to that database\'s label', async () => {
    const rule = await mkRule(ticketsDb, 'Forged field rule', { type: 'record_updated', field_id: stateField }, agent.id);
    await pool.query("update automations set trigger = jsonb_set(trigger, '{field_id}', to_jsonb($2::text)) where id = $1", [rule, secretStateField]);
    await mkRule(secretDb, 'Forged-neighbour rule', { type: 'record_updated', field_id: secretStateField }, agent.id); // so the other database's labels ARE loaded
    // as an ADMIN, who can open both databases, so both databases' labels are loaded and only the scoping keeps them apart
    const row = (await sourcesOf(admin.token, agent.id)).sources.find((s) => s.id === rule)!;
    expect(row.trigger.field).toEqual({ id: secretStateField, name: null });
    expect((await read(manager.token, agent.id)).body).not.toContain('Salary band');
  });
});


/**
 * #1289 (Otto, 2026-11-13) - the rule-name gate. A rule's name, id, on/off state and trigger are readable only by whoever may read that
 * database's automations (creator on it, the check GET .../automations enforces; rule-visibility.ts, shared with /approvals and My work).
 * Everyone else gets the entry, so the list stays complete, as "A rule in <database>". The manager here is a MEMBER holding only `viewer`
 * on one restricted database and `creator` on another; before this, the viewer saw the rule's name, on/off state and trigger type.
 */
describe('#1289 a rule is named only for someone who may read its database automations', () => {
  let agent: { id: string; number: number };
  let viewerRule = '', creatorRule = '';
  const VIEWER_RULE = 'Quarterly close alarm';
  beforeAll(async () => {
    agent = await mkAgent(manager.token, 'Gate agent');
    viewerRule = await mkRule(viewerDb, VIEWER_RULE, { type: 'schedule', every: 'day', at: '08:15', timezone: 'Europe/Kyiv' }, agent.id);
    creatorRule = await mkRule(creatorDb, 'Build watcher', { type: 'record_created' }, agent.id);
  }, 60_000);

  it('a manager with only VIEWER on the database sees the entry, labelled by the database, with no name, id, state or trigger', async () => {
    const res = await read(manager.token, agent.id);
    expect(res.statusCode, res.body).toBe(200);
    expect((await as(manager.token, 'GET', `/workspaces/${ws}/databases/${viewerDb}/automations`)).statusCode).toBe(403); // the gate this follows
    const rows = (res.json() as { sources: Array<Record<string, any>> }).sources.filter((x) => x.kind === 'automation' && x.database.id === viewerDb);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ kind: 'automation', id: null, name: null, label: 'A rule in Ops board', enabled: null, database: { id: viewerDb, name: 'Ops board', exists: true, is_system: false }, trigger: null });
    expect(res.body).not.toContain(VIEWER_RULE);
    expect(res.body).not.toContain(viewerRule);
    expect(res.body).not.toContain('08:15');
    expect(res.body).not.toContain('Europe/Kyiv');
    expect(() => agentWakeSourcesResponseSchema.parse(res.json())).not.toThrow();
  });

  it('KEPT: the same manager with CREATOR on another database gets that rule in full, and an admin gets both', async () => {
    expect((await as(manager.token, 'GET', `/workspaces/${ws}/databases/${creatorDb}/automations`)).statusCode).toBe(200);
    const mine = (await sourcesOf(manager.token, agent.id)).sources.find((x) => x.id === creatorRule);
    expect(mine).toMatchObject({ kind: 'automation', name: 'Build watcher', label: 'Build watcher', enabled: true, trigger: { type: 'record_created' } });
    const all = (await sourcesOf(admin.token, agent.id)).sources;
    expect(all.find((x) => x.id === viewerRule)).toMatchObject({ name: VIEWER_RULE, label: VIEWER_RULE, enabled: true, trigger: { type: 'schedule', schedule: { every: 'day', at: '08:15' } } });
    expect(all.find((x) => x.id === creatorRule)).toMatchObject({ name: 'Build watcher' });
  });

  it('the gate is the automations gate: the name is shown exactly when GET .../automations answers 200', async () => {
    const listed = async (db: string) => (await as(manager.token, 'GET', `/workspaces/${ws}/databases/${db}/automations`)).statusCode === 200;
    const sources = (await sourcesOf(manager.token, agent.id)).sources.filter((x) => x.kind === 'automation');
    const shown = (db: string) => sources.find((x) => x.database.id === db)?.name != null;
    expect(shown(viewerDb)).toBe(await listed(viewerDb));
    expect(shown(creatorDb)).toBe(await listed(creatorDb));
    expect(await listed(viewerDb)).toBe(false);
    expect(await listed(creatorDb)).toBe(true);
  });
});

/**
 * #1289 (Otto, 2026-11-13) - "everything that can start an agent" has to be true: the built-in ways are listed as fixed entries, and they
 * come from the wake code's own reason list rather than a second copy that can drift from it.
 */
describe('#1289 every way to wake an agent has an entry', () => {
  it('every wake reason the runtime knows is either configured (listed per source) or has exactly one built-in entry, never both, never neither', () => {
    const configured: string[] = [...CONFIGURED_WAKE_REASONS];
    const builtIn = Object.keys(BUILT_IN_WAKE_SOURCES);
    expect(builtIn.filter((r) => configured.includes(r)), 'a reason is either configured or built in').toEqual([]);
    expect([...configured, ...builtIn].sort()).toEqual([...WAKE_REASONS].sort());
    for (const entry of Object.values(BUILT_IN_WAKE_SOURCES)) {
      expect(entry.title.length).toBeGreaterThan(3);
      expect(entry.description.length).toBeGreaterThan(20);
    }
  });

  it('the endpoint lists every built-in way, the same for an admin and for the manager, after the configured sources', async () => {
    const bare = await mkAgent(manager.token, 'Built-in agent');
    for (const who of [admin, manager]) {
      const out = await sourcesOf(who.token, bare.id);
      expect(out.sources.map((x) => x.reason)).toEqual(Object.keys(BUILT_IN_WAKE_SOURCES));
      expect(out.sources.map((x) => x.reason)).toEqual(expect.arrayContaining(['mention', 'manual', 'approval_decided', 'catch_up', 'must_comment', 'retry']));
      expect(() => agentWakeSourcesResponseSchema.parse(out)).not.toThrow();
    }
    const withConfig = await sourcesOf(admin.token, (await mkAgent(manager.token, 'Mixed agent')).id);
    expect(withConfig.sources.at(-1)!.kind).toBe('built_in');
  });

  it('a wake the runtime really emits (an @mention in a comment) is one the endpoint lists', async () => {
    const mentioned = await mkAgent(manager.token, 'Mentioned agent');
    const rec = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDb}/records`, { values: { name: 'Please look' } })).json().id as string;
    const posted = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDb}/records/${rec}/comments`, {
      body: { format: 'blocknote', doc: [{ type: 'paragraph', content: [{ type: 'mention', props: { kind: 'agent', id: mentioned.id, label: 'agent' } }] }] },
    });
    expect(posted.statusCode, posted.body).toBe(201);
    const emitted = (await pool.query('select distinct reason from agent_wakes where agent_id = $1', [mentioned.id])).rows.map((r) => r.reason as string);
    expect(emitted).toEqual(['mention']); // a real wake exists; if the mention path stopped waking, this fails rather than passing vacuously
    const listed = (await sourcesOf(admin.token, mentioned.id)).sources.filter((x) => x.kind === 'built_in').map((x) => x.reason);
    for (const reason of emitted) expect(listed).toContain(reason);
  });
});
