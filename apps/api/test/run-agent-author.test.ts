import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs, type Person } from './helpers/members';
import { AgentsService } from '../src/agents/agents.service';
import type { AgentRuntime } from '../src/agents/agent-runtime';

/**
 * Ticket #1074 — a run_agent action runs with the agent OWNER's authority, so the person who decided it (the rule's author, or
 * whoever pressed the button) must be that owner or a workspace admin. A member cannot point their own rule at an admin's agent.
 */
let app: NestFastifyApplication;
let owner: { token: string; email: string };
let ownerId: string;
let member: Person;
let otherAdmin: Person;
let ws: string;
let agentsDbId: string;
let agentId: string;

const fx = async (token: string, method: string, url: string, payload?: unknown) => {
  const r = await call(app, token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};

const quietRuntime: AgentRuntime = {
  runClass: 'non_ai',
  async *execute() {
    yield { tool: 'noop', summary: 'looked around' };
  },
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Agent Owner');
  ws = (await fx(owner.token, 'POST', '/workspaces', { name: 'Run author WS' })).id;
  const me = await fx(owner.token, 'GET', '/me');
  ownerId = me.id ?? me.user?.id;
  agentsDbId = (await fx(owner.token, 'POST', `/workspaces/${ws}/agents/ensure`)).agentsDb.id;
  agentId = (await fx(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, { values: { name: 'Admin bot', enabled: true } })).id;
  member = await joinAs(app, owner.token, ws, 'Rule Member', 'member');
  otherAdmin = await joinAs(app, owner.token, ws, 'Other Admin', 'admin');
  app.get(AgentsService).runtimeFor = () => quietRuntime;
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('#1074 run_agent: only the agent owner or an admin may decide the run', () => {
  const run = (authorId: string | null) => app.get(AgentsService).runFromAutomation({ workspaceId: ws, agentRef: agentId, authorId });

  it("a member's rule cannot run an admin's agent", async () => {
    await expect(run(member.id)).rejects.toMatchObject({ status: 403 });
  });

  it('a rule with no identifiable author is refused too', async () => {
    await expect(run(null)).rejects.toMatchObject({ status: 403 });
  });

  it('the owner and another admin can', async () => {
    expect(ownerId).toBeTruthy();
    await expect(run(ownerId)).resolves.toBeDefined();
    await expect(run(otherAdmin.id)).resolves.toBeDefined();
  });

  it('a demoted admin loses it at run time', async () => {
    const members = await fx(owner.token, 'GET', `/workspaces/${ws}/members`);
    const list = (Array.isArray(members) ? members : members.data) as Array<{ id: string; user_id?: string; userId?: string }>;
    const m = list.find((x) => (x.user_id ?? x.userId) === otherAdmin.id)!;
    await fx(owner.token, 'PATCH', `/workspaces/${ws}/members/${m.id}`, { role: 'member' });
    await expect(run(otherAdmin.id)).rejects.toMatchObject({ status: 403 });
  });
});
