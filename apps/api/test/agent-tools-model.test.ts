import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MCP_TOOL_NAMES } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';

/**
 * ticket #1180 — the two settings a manager puts on an agent that runs on a Runner: `tools` (extra MCP tool names) and `model`.
 * Real fixtures for each kind of person the rules name: a MEMBER who owns the agent and a Runner, an ADMIN, a GUEST with only a
 * viewer grant on the Agents database, and THE AGENT ITSELF (its per-run credential, and an older agent-origin token). The claim is
 * the real thing: a Runner pairs, a wake is claimed over HTTP, and the payload is read back.
 */
let app: NestFastifyApplication;
let ws: string;
let agentsDbId: string;
let ticketsDbId: string;
let notesApi: string;
let admin: { token: string; email: string };
let owner: Person;
let guestViewer: Person;
let runner: { token: string; id: string };
let scopeIds: Record<string, string> = {};
let aiOwn = '';
const { pool } = connectTestDb();

const TOOLS = [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }];
const report = () => ({ machine_name: 'Test machine', tools: TOOLS, runner_version: '0.1.0', protocol_version: 1 });
const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const claim = (token: string) => asRunner(token, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
const agentsRecords = () => `/workspaces/${ws}/databases/${agentsDbId}/records`;

async function mkAgent(who: { token: string }, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await as(who.token, 'POST', agentsRecords(), { values: { name, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']], ...extra } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function pairRunner(who: Person, agentIds: string[]) {
  const code = (await as(who.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', { code: code.code, ...report() });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token, runner: r } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(who.token, 'POST', `/workspaces/${ws}/runners/${r.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  for (const agent of agentIds) expect((await as(who.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agent}`, { runner_id: r.id })).statusCode).toBe(200);
  return { token, id: r.id };
}

type Claimed = { id: string; agent: { id: string; tools: string[]; model: string | null }; credential: { token: string } };
/** Delegates a fresh wake to `agent` and claims it. */
async function claimFor(agent: string): Promise<Claimed & { ticket: string }> {
  const ticket = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: `T ${agent.slice(0, 4)}`, [notesApi]: 'x' } })).json().id as string;
  expect((await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agent}/delegate`, { record_id: ticket })).statusCode).toBe(201);
  const res = await claim(runner.token);
  expect(res.statusCode, res.body).toBe(200);
  return { ...(res.json().wakes[0] as Claimed), ticket };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ToolsAdmin');
  ws = (await as(admin.token, 'POST', '/workspaces', { name: 'Tools WS' })).json().id;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  agentsDbId = ensured.agentsDb.id;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries((await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map((r: { label: string; id: string }) => [r.label, r.id]));
  aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  scopeIds = await opt(agentsDbId, 'scopes');
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  notesApi = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json().apiName;
  owner = await joinAs(app, admin.token, ws, 'ToolsOwner', 'member');
  guestViewer = await joinAs(app, admin.token, ws, 'ToolsGuest', 'guest', [{ database_id: agentsDbId, role: 'viewer' }]);
  runner = await pairRunner(owner, []);
}, 180_000);

beforeEach(async () => {
  await pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const fieldRows = async () => (await pool.query("select api_name, type, display_name from fields where database_id = $1 and api_name in ('tools','model') and deleted_at is null order by api_name", [agentsDbId])).rows;

describe('the two fields exist, added by the ensure, with no migration', () => {
  it('a new workspace has Tools (text) and Model (text) on its Agents database', async () => {
    expect(await fieldRows()).toEqual([
      { api_name: 'model', type: 'text', display_name: 'Model' },
      { api_name: 'tools', type: 'text', display_name: 'Tools' },
    ]);
  });

  it('a workspace whose Agents database predates them gets them from the next ensure, once, and a second ensure adds nothing', async () => {
    const old = (await as(admin.token, 'POST', '/workspaces', { name: 'Old pack WS' })).json().id as string;
    const db = (await as(admin.token, 'POST', `/workspaces/${old}/agents/ensure`)).json().agentsDb.id as string;
    await pool.query("delete from fields where database_id = $1 and api_name in ('tools','model')", [db]);
    expect((await pool.query("select count(*)::int as n from fields where database_id = $1 and api_name in ('tools','model')", [db])).rows[0].n).toBe(0);
    expect((await as(admin.token, 'POST', `/workspaces/${old}/agents/ensure`)).statusCode).toBeLessThan(300);
    expect((await as(admin.token, 'POST', `/workspaces/${old}/agents/ensure`)).statusCode).toBeLessThan(300);
    const rows = (await pool.query("select api_name from fields where database_id = $1 and api_name in ('tools','model')", [db])).rows;
    expect(rows.map((r: { api_name: string }) => r.api_name).sort()).toEqual(['model', 'tools']);
  });
});

describe('who may set them, and what is accepted', () => {
  it('a member who may edit the Agents database sets both, on create and on PATCH, and an admin can too', async () => {
    const agent = await mkAgent(owner, 'Settings bot', { tools: 'link_records, unlink_records', model: 'claude-sonnet-4-5' });
    const got = (await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json();
    expect(got.values.tools).toBe('link_records, unlink_records');
    expect(got.values.model).toBe('claude-sonnet-4-5');
    expect((await as(owner.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { model: 'opus', tools: 'delete_record' } })).statusCode).toBe(200);
    expect((await as(admin.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { model: 'sonnet[1m]' } })).statusCode).toBe(200);
    // cleared = the defaults again
    const cleared = await as(owner.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { model: null, tools: null } });
    expect(cleared.statusCode, cleared.body).toBe(200);
  });

  it('an unknown tool name is refused with the valid names listed, on create, PATCH and batch, and nothing is written', async () => {
    const agent = await mkAgent(owner, 'Unknown tool bot', { tools: 'link_records' });
    const patch = await as(owner.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { tools: 'link_records, make_coffee' } });
    expect(patch.statusCode, patch.body).toBe(422);
    expect(patch.body).toContain('make_coffee');
    for (const name of ['get_record', 'create_record', 'update_record']) expect(patch.body).toContain(name);
    expect(patch.body.length).toBeGreaterThan(MCP_TOOL_NAMES.join(', ').length);
    expect((await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json().values.tools).toBe('link_records');

    const create = await as(owner.token, 'POST', agentsRecords(), { values: { name: 'Bad create', tools: 'nope' } });
    expect(create.statusCode, create.body).toBe(422);
    const batch = await as(owner.token, 'PATCH', `${agentsRecords()}/batch`, { ids: [agent], values: { tools: 'nope' } });
    expect(batch.json().failed?.length ?? 1).toBeGreaterThan(0);
    expect((await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json().values.tools).toBe('link_records');
  });

  it('a model that is a flag, has a space or a shell character, or is too long is refused', async () => {
    const agent = await mkAgent(owner, 'Model guard bot');
    for (const bad of ['--dangerously-skip-permissions', '-p', 'opus --permission-mode bypassPermissions', 'opus;id', '$(id)', 'a'.repeat(101)]) {
      const res = await as(owner.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { model: bad } });
      expect(res.statusCode, bad).toBe(422);
      expect(res.body).toContain('model name');
    }
    expect((await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json().values.model ?? null).toBeNull();
  });

  it('a guest with only a viewer grant on the Agents database cannot set them', async () => {
    const agent = await mkAgent(owner, 'Guest-proof bot');
    const res = await as(guestViewer.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { tools: 'link_records', model: 'opus' } });
    expect([403, 404]).toContain(res.statusCode);
    expect((await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json().values.tools ?? null).toBeNull();
  });

  it('a user database that merely has fields called Tools and Model is untouched by the rule', async () => {
    const space = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const db = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Gadgets' })).json().id as string;
    for (const n of ['Tools', 'Model']) await as(admin.token, 'POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: n, type: 'text', config: {} });
    const res = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'Drill', tools: 'make_coffee', model: '--not-a-flag' } });
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('an agent can never change its own (or another agent\'s) tools or model', () => {
  it('the per-run credential is refused on PATCH, create and a version restore of an agent record; its ordinary work still goes through', async () => {
    const agent = await mkAgent(owner, 'Self-escalation bot', { tools: 'link_records', model: 'haiku' });
    const rr = await pairRunner(owner, [agent]);
    runner = rr;
    const w = await claimFor(agent);
    const cred = w.credential.token;
    expect(w.agent).toMatchObject({ tools: ['link_records'], model: 'haiku' });

    for (const [label, values] of [['tools', { tools: 'delete_database' }], ['model', { model: 'opus' }]] as const) {
      const res = await as(cred, 'PATCH', `${agentsRecords()}/${agent}`, { values });
      expect(res.statusCode, `${label}: ${res.body}`).toBe(403);
      expect(res.body).toContain('cannot change');
    }
    expect((await as(cred, 'POST', agentsRecords(), { values: { name: 'Child agent', tools: 'delete_database' } })).statusCode).toBe(403);
    const other = await mkAgent(owner, 'Another agent');
    expect((await as(cred, 'PATCH', `${agentsRecords()}/${other}`, { values: { model: 'opus' } })).statusCode).toBe(403);
    const restore = await as(cred, 'POST', `${agentsRecords()}/${agent}/versions/00000000-0000-4000-8000-000000000000/restore`);
    expect(restore.statusCode, restore.body).toBe(403);
    // the same restore by a person gets past the guard (and is then a plain 404: no such version)
    expect((await as(owner.token, 'POST', `${agentsRecords()}/${agent}/versions/00000000-0000-4000-8000-000000000000/restore`)).statusCode).toBe(404);

    // nothing moved
    const now = (await as(owner.token, 'GET', `${agentsRecords()}/${agent}`)).json().values;
    expect(now.tools).toBe('link_records');
    expect(now.model).toBe('haiku');
    // and the credential still does the work it is for
    const ticket = await as(cred, 'PATCH', `/workspaces/${ws}/databases/${ticketsDbId}/records/${w.ticket}`, { values: { [notesApi]: 'agent was here' } });
    expect(ticket.statusCode, ticket.body).toBe(200);
  });

  it('an older agent-origin token (minted by a person for an agent) is refused too: the rule is the SOURCE, not the credential kind', async () => {
    const agent = await mkAgent(owner, 'Legacy token bot');
    const minted = await as(owner.token, 'POST', '/me/tokens', { name: 'legacy agent token', workspace_id: ws, scope: 'write', agent_id: agent });
    expect(minted.statusCode, minted.body).toBe(201);
    const res = await as(minted.json().token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { tools: 'link_records' } });
    expect(res.statusCode, res.body).toBe(403);
    // a field that is not one of the two is not this rule's business
    expect((await as(minted.json().token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { enabled: true } })).statusCode).not.toBe(403);
  });
});

describe('the claim carries them', () => {
  it('an agent with neither set gets tools [] and model null (the defaults: nothing added, no --model)', async () => {
    const agent = await mkAgent(owner, 'Default bot');
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    const w = await claimFor(agent);
    expect(w.agent.tools).toEqual([]);
    expect(w.agent.model).toBeNull();
  });

  it('an agent with settings gets the names parsed and de-duplicated, in the order written, and the model as written', async () => {
    const agent = await mkAgent(owner, 'Configured bot', { tools: 'link_records,\nunlink_records  link_records', model: 'claude-sonnet-4-5' });
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    const w = await claimFor(agent);
    expect(w.agent.tools).toEqual(['link_records', 'unlink_records']);
    expect(w.agent.model).toBe('claude-sonnet-4-5');
  });

  it('a saved list whose names have ALL left the registry is the essentials (empty), never silently "all tools"', async () => {
    const agent = await mkAgent(owner, 'All gone bot', { tools: 'link_records' });
    const toolsId = (await pool.query("select id from fields where database_id = $1 and api_name = 'tools'", [agentsDbId])).rows[0].id as string;
    await pool.query('update records set values = values || $2::jsonb where id = $1', [agent, JSON.stringify({ [toolsId]: 'removed_long_ago' })]);
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    expect((await claimFor(agent)).agent.tools).toEqual([]);
  });

  it('`all` is the explicit opt-in: the claim carries exactly [\'all\'] (even next to other names), and the write validator accepts it', async () => {
    const agent = await mkAgent(owner, 'All tools bot', { tools: 'all' });
    expect((await as(owner.token, 'PATCH', `${agentsRecords()}/${agent}`, { values: { tools: 'link_records, all' } })).statusCode).toBe(200);
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    expect((await claimFor(agent)).agent.tools).toEqual(['all']);
  });

  it('what is stale or unsafe in a stored value is not sent: a name that left the registry is dropped, a model that fails the rule is null', async () => {
    const agent = await mkAgent(owner, 'Stale bot', { tools: 'link_records' });
    const toolsId = (await pool.query("select id from fields where database_id = $1 and api_name = 'tools'", [agentsDbId])).rows[0].id as string;
    const modelId = (await pool.query("select id from fields where database_id = $1 and api_name = 'model'", [agentsDbId])).rows[0].id as string;
    // written straight to the row, past the API rule: a value from before the rule, or from a restore
    await pool.query('update records set values = values || $2::jsonb where id = $1', [agent, JSON.stringify({ [toolsId]: 'link_records, removed_long_ago', [modelId]: '--dangerously-skip-permissions' })]);
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    const w = await claimFor(agent);
    expect(w.agent.tools).toEqual(['link_records']);
    expect(w.agent.model).toBeNull();
  });
});

describe('the workspace default model (settings.default_agent_model) and the order the claim resolves the model in', () => {
  const setDefault = (token: string, v: string | null) => as(token, 'PATCH', `/workspaces/${ws}`, { default_agent_model: v });
  const settings = async () => (await pool.query('select settings from workspaces where id = $1', [ws])).rows[0].settings as Record<string, unknown>;
  const cancelOpen = () => pool.query("update agent_wakes set status = 'canceled', finished_at = now() where workspace_id = $1 and status in ('queued','claimed')", [ws]);
  const claimModel = async (agent: string) => {
    await pairRunner(owner, [agent]).then((r) => (runner = r));
    return (await claimFor(agent)).agent.model;
  };

  it('an admin sets and clears it; a member and a guest cannot; a bad value is refused and nothing is stored', async () => {
    expect((await setDefault(admin.token, 'sonnet')).statusCode).toBe(200);
    expect((await settings()).default_agent_model).toBe('sonnet');
    expect((await setDefault(owner.token, 'opus')).statusCode).toBe(403);
    expect([403, 404]).toContain((await setDefault(guestViewer.token, 'opus')).statusCode);
    for (const bad of ['--dangerously-skip-permissions', '-p', 'opus;id', 'a b', '$(id)', 'a'.repeat(101)]) {
      const res = await setDefault(admin.token, bad);
      expect([400, 422], `${bad}: ${res.body}`).toContain(res.statusCode);
    }
    expect((await settings()).default_agent_model).toBe('sonnet');
    // merged over the other settings, not clobbering them
    expect((await as(admin.token, 'PATCH', `/workspaces/${ws}`, { private_attachments: true })).statusCode).toBe(200);
    expect((await settings()).default_agent_model).toBe('sonnet');
    expect((await setDefault(admin.token, null)).statusCode).toBe(200);
    expect('default_agent_model' in (await settings())).toBe(false);
    expect((await settings()).private_attachments).toBe(true);
  });

  it("an agent can never change it: an admin-owned agent's token (admin scope, agent origin) is refused; the person's own session is the control", async () => {
    const adminAgent = await mkAgent(admin, 'Admin-owned agent');
    const minted = await as(admin.token, 'POST', '/me/tokens', { name: 'agent token', workspace_id: ws, scope: 'admin', agent_id: adminAgent });
    expect(minted.statusCode, minted.body).toBe(201);
    const res = await setDefault(minted.json().token, 'opus');
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain('decided by a person');
    expect((await settings()).default_agent_model ?? null).toBeNull();
    expect((await setDefault(admin.token, 'haiku')).statusCode).toBe(200);
    expect((await setDefault(admin.token, null)).statusCode).toBe(200);
  });

  it("resolution: the agent's own model, else the workspace default, else nothing", async () => {
    const plain = await mkAgent(owner, 'Plain model bot');
    const own = await mkAgent(owner, 'Own model bot', { model: 'opus' });
    expect(await claimModel(plain)).toBeNull(); // no default anywhere: the customer's own CLI default
    expect((await setDefault(admin.token, 'sonnet')).statusCode).toBe(200);
    await cancelOpen();
    expect(await claimModel(plain)).toBe('sonnet'); // workspace default
    await cancelOpen();
    expect(await claimModel(own)).toBe('opus'); // the agent's own wins
    expect((await as(owner.token, 'PATCH', `${agentsRecords()}/${own}`, { values: { model: null } })).statusCode).toBe(200); // reset = back to the default
    await cancelOpen();
    expect(await claimModel(own)).toBe('sonnet');
    expect((await setDefault(admin.token, null)).statusCode).toBe(200);
  });
});
