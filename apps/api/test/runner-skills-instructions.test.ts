import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * ticket #1184 — a Runner run gets each attached skill's INSTRUCTIONS, not a list of names. Same people the rules name, real
 * claims over HTTP: a MEMBER who owns the agent and a Runner, a SECOND member whose personal skill must never travel, an ADMIN
 * (who can READ everyone's skills and so is the dangerous owner), and a guest-turned owner.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let ticketsDbId: string;
let notesApi: string;
let admin: { token: string; email: string };
let alice: Person; // owns the agent under test, and a Runner
let bob: Person; // another member: his personal skill is the secret
let aliceRunner: { token: string; id: string };
let adminRunner: { token: string; id: string };
let scopeIds: Record<string, string> = {};
let aiOwn = '';
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = () => ({ machine_name: 'Test machine', tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const claim = (token: string) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
/** A claim with nothing to hand over answers 204 with no body. */
const expectNoWakes = (res: { statusCode: number; body: string }) => {
  expect(res.statusCode, res.body).toBe(204);
};
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;

async function mkAgent(who: { token: string }, name: string, skills: string | null): Promise<string> {
  const res = await as(who.token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...(skills !== null ? { skills } : {}) } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function mkSkill(who: { token: string }, name: string, instructions: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await as(who.token, 'POST', `/workspaces/${ws}/skills`, { name, description: `${name} description`, when_to_use: `when ${name} applies`, instructions, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function pairRunner(who: { token: string }, agentIds: string[]) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(who.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  for (const agent of agentIds) expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
  return { token, id: r.id };
}

interface SkillText {
  name: string;
  when_to_use: string;
  instructions: string;
  truncated: { chars: number; kept: number } | null;
}
type Claimed = { id: string; agent: { id: string; skills: string | null; skill_instructions?: SkillText[] }; credential: { token: string } };

/** Delegates a fresh wake to `agent` (as the admin) and returns its id. */
async function delegate(agent: string): Promise<{ ticket: string; wake: string }> {
  const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: `T ${agent.slice(0, 4)}`, [notesApi]: 'x' } })).json().id as string;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const wake = (await pool.query("select id from agent_wakes where agent_id = $1 order by created_at desc limit 1", [agent])).rows[0].id as string;
  return { ticket, wake };
}

async function claimFor(runner: { token: string }, agent: string): Promise<Claimed> {
  await delegate(agent);
  const res = await claim(runner.token);
  expect(res.statusCode, res.body).toBe(200);
  const wakes = res.json().wakes as Claimed[];
  expect(wakes.length, res.body).toBe(1);
  return wakes[0]!;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SkillsAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Skills WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  notesApi = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json().apiName;
  alice = await joinAs(app, admin.token, ws, 'SkillsAlice', 'member');
  bob = await joinAs(app, admin.token, ws, 'SkillsBob', 'member');
  aliceRunner = await pairRunner(alice, []);
  adminRunner = await pairRunner(admin, []);
}, 180_000);

beforeEach(async () => {
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const assign = async (who: { token: string }, runnerId: string, agent: string) =>
  expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: runnerId })).statusCode).toBe(200);

describe('the claim carries each attached skill\'s instructions, not just its name', () => {
  it('names in order, with the body and when-to-use, resolved when the run is claimed; the raw names stay as they were', async () => {
    await mkSkill(admin, 'Lead triage', 'STEP-ONE: read the lead. STEP-TWO: score it 1-5.');
    await mkSkill(alice, 'My own habit', 'ALWAYS-SIGN-OFF-WITH-A-HAIKU.', { visibility: 'personal' });
    const agent = await mkAgent(alice, 'Triage bot', 'Lead triage\nMy own habit');
    await assign(alice, aliceRunner.id, agent);
    const c = await claimFor(aliceRunner, agent);
    expect(c.agent.skills).toBe('Lead triage\nMy own habit');
    expect(c.agent.skill_instructions?.map((s) => s.name)).toEqual(['Lead triage', 'My own habit']);
    expect(c.agent.skill_instructions![0]).toEqual({ name: 'Lead triage', when_to_use: 'when Lead triage applies', instructions: 'STEP-ONE: read the lead. STEP-TWO: score it 1-5.', truncated: null });
    expect(c.agent.skill_instructions![1]!.instructions).toBe('ALWAYS-SIGN-OFF-WITH-A-HAIKU.');
  });

  it('an edit between runs is what the next claim carries (resolved by name at claim, never copied)', async () => {
    const id = await mkSkill(admin, 'Editable skill', 'VERSION-ONE');
    const agent = await mkAgent(alice, 'Edit bot', 'Editable skill');
    await assign(alice, aliceRunner.id, agent);
    expect((await claimFor(aliceRunner, agent)).agent.skill_instructions![0]!.instructions).toBe('VERSION-ONE');
    await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/skills/${id}`, { instructions: 'VERSION-TWO' })).statusCode).toBe(200);
    expect((await claimFor(aliceRunner, agent)).agent.skill_instructions![0]!.instructions).toBe('VERSION-TWO');
  });

  it('an agent with no skills gets an empty list and a null names field (it runs as before)', async () => {
    const agent = await mkAgent(alice, 'No-skills bot', null);
    await assign(alice, aliceRunner.id, agent);
    const c = await claimFor(aliceRunner, agent);
    expect(c.agent.skills).toBeNull();
    expect(c.agent.skill_instructions).toEqual([]);
  });
});

describe('what the owner cannot read is never sent, and the run fails naming it', () => {
  it('a skill that stopped being readable by the owner between the dispatch and the claim: no payload, wake and Run Failed, skill named', async () => {
    const id = await mkSkill(admin, 'Soon hidden', 'HIDDEN-BODY-ZZZ');
    const agent = await mkAgent(alice, 'Hidden bot', 'Soon hidden');
    await assign(alice, aliceRunner.id, agent);
    const { wake } = await delegate(agent);
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}/skills/${id}`, { visibility: 'personal' })).statusCode).toBe(200);
    const res = await claim(aliceRunner.token);
    expectNoWakes(res);
    expect(res.body).not.toContain('HIDDEN-BODY-ZZZ');
    expect((await pool.query('select status from agent_wakes where id = $1', [wake])).rows[0].status).toBe('failed');
    const run = (await pool.query("select r.values::text as v from agent_wakes w join records r on r.id = w.run_id where w.id = $1", [wake])).rows[0].v as string;
    expect(run).toContain('skills.missing');
    expect(run).toContain('Soon hidden');
    // (The dispatch-time step log, written while the owner could still read the skill, is older than this and not what this test is about.)
    expect(run).toContain('wake.failed');
  });

  it('no credential is left behind for a wake that failed on a skill', async () => {
    const id = await mkSkill(admin, 'Hidden two', 'HIDDEN-TWO');
    const agent = await mkAgent(alice, 'Hidden bot two', 'Hidden two');
    await assign(alice, aliceRunner.id, agent);
    const { wake } = await delegate(agent);
    await as(admin.token, 'PATCH', `/workspaces/${ws}/skills/${id}`, { visibility: 'personal' });
    await claim(aliceRunner.token);
    const creds = (await pool.query("select count(*)::int as n from api_tokens where wake_id = $1 and revoked_at is null", [wake])).rows[0].n;
    expect(creds).toBe(0);
  });
});

describe('a personal skill is private: only its own author\'s agent, on its own author\'s Runner, may receive it', () => {
  it('ADMIN-owned agent naming BOB\'s personal skill: the admin can read it, the Runner is still never sent it', async () => {
    await mkSkill(bob, 'Bob private notes', 'BOBS-SECRET-BODY', { visibility: 'personal' });
    // The control: the admin really can read it (ticket #841), so the refusal below is the Runner rule and not an access gap.
    const list = (await as(admin.token, 'GET', `/workspaces/${ws}/skills`)).json().data as Array<{ name: string }>;
    expect(list.map((s) => s.name)).toContain('Bob private notes');
    const agent = await mkAgent(admin, 'Admin bot', 'Bob private notes');
    await assign(admin, adminRunner.id, agent);
    const { wake } = await delegate(agent);
    // The dispatch (server path) may or may not have queued a wake for it; either way nothing carries the body.
    const res = await claim(adminRunner.token);
    expectNoWakes(res);
    expect(res.body).not.toContain('BOBS-SECRET-BODY');
    const status = (await pool.query('select status from agent_wakes where id = $1', [wake])).rows[0]?.status;
    expect(['failed', 'canceled', undefined]).toContain(status);
  });

  it('ALICE\'s agent naming BOB\'s personal skill (Alice cannot read it): not sent', async () => {
    await mkSkill(bob, 'Bob other secret', 'BOBS-OTHER-SECRET', { visibility: 'personal' });
    const agent = await mkAgent(alice, 'Alice nosy bot', 'Bob other secret');
    await assign(alice, aliceRunner.id, agent);
    await delegate(agent);
    const res = await claim(aliceRunner.token);
    expect(res.body).not.toContain('BOBS-OTHER-SECRET');
    expectNoWakes(res);
  });

  it('a personal skill of the owner is not sent to a Runner that belongs to someone else', async () => {
    await mkSkill(alice, 'Alice private', 'ALICES-PRIVATE-BODY', { visibility: 'personal' });
    const agent = await mkAgent(alice, 'Alice private bot', 'Alice private');
    await assign(alice, aliceRunner.id, agent);
    const { wake } = await delegate(agent);
    // Re-point the assignment at the ADMIN's Runner directly (the route may refuse; the claim rule must hold regardless).
    await pool.query('update runner_agents set runner_id = $1 where agent_id = $2', [adminRunner.id, agent]);
    const res = await claim(adminRunner.token);
    expect(res.body).not.toContain('ALICES-PRIVATE-BODY');
    expectNoWakes(res);
    expect((await pool.query('select status from agent_wakes where id = $1', [wake])).rows[0].status).toBe('failed');
  });
});

describe('a skill\'s text is capped, and the cut is said, never silent', () => {
  it('one long skill: cut at the per-skill cap with the original size stated', async () => {
    await mkSkill(admin, 'Long skill', `${'a'.repeat(6000)}${'b'.repeat(1000)}`);
    const agent = await mkAgent(alice, 'Long bot', 'Long skill');
    await assign(alice, aliceRunner.id, agent);
    const s = (await claimFor(aliceRunner, agent)).agent.skill_instructions![0]!;
    expect(s.instructions).toBe('a'.repeat(6000));
    expect(s.truncated).toEqual({ chars: 7000, kept: 6000 });
  });

  it('many long skills: a total budget, and every skill past it is still NAMED with what was cut', async () => {
    const names: string[] = [];
    for (let i = 0; i < 6; i++) {
      names.push(`Big ${i}`);
      await mkSkill(admin, `Big ${i}`, `${String(i)}`.repeat(6000));
    }
    const agent = await mkAgent(alice, 'Many bot', names.join('\n'));
    await assign(alice, aliceRunner.id, agent);
    const list = (await claimFor(aliceRunner, agent)).agent.skill_instructions!;
    expect(list.map((s) => s.name)).toEqual(names);
    const kept = list.reduce((n, s) => n + s.instructions.length, 0);
    expect(kept).toBeLessThanOrEqual(24_000);
    const cut = list.filter((s) => s.truncated);
    expect(cut.length).toBeGreaterThan(0);
    for (const s of cut) expect(s.truncated).toEqual({ chars: 6000, kept: s.instructions.length });
  });
});

describe('a guest never owns a run, and the server-run path is unchanged', () => {
  it('an agent whose owner became a guest is not claimed at all', async () => {
    await mkSkill(admin, 'Guest skill', 'GUEST-BODY');
    const agent = await mkAgent(alice, 'Soon guest bot', 'Guest skill');
    await assign(alice, aliceRunner.id, agent);
    await delegate(agent);
    await pool.query("update memberships set role = 'guest' where workspace_id = $1 and user_id = $2", [ws, alice.id]);
    try {
      const res = await claim(aliceRunner.token);
      // The Runner of a person who is now a guest is refused outright; nothing at all is handed over.
      expect(res.statusCode, res.body).toBe(401);
      expect(res.body).not.toContain('GUEST-BODY');
    } finally {
      await pool.query("update memberships set role = 'member' where workspace_id = $1 and user_id = $2", [ws, alice.id]);
    }
  });
});
