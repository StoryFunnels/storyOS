import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

const EXPECTED_FIELDS = [
  { name: 'goal', type: 'rich_text' },
  { name: 'instructions', type: 'rich_text' },
  { name: 'scopes', type: 'multi_select' },
  { name: 'trigger', type: 'select' },
  { name: 'target_databases', type: 'text' },
  { name: 'approval_policy', type: 'multi_select' },
  { name: 'enabled', type: 'checkbox' },
];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'AgentAdmin');
  member = await signUpUser(app, 'AgentMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Agents WS' })).json().id;

  // Invite the second user as a non-admin member of the same workspace.
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('Agents system database (MN-214a, ADR-0010)', () => {
  it('GET reports not-provisioned before ensure', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/agents`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ exists: false });
  });

  it('ensure creates the Agentic OS space, the Agents database and its fields', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().created).toBe(true);
    const dbId = res.json().agentsDb.id;
    expect(dbId).toBeTruthy();

    // The space exists and is named "Agentic OS".
    const spaces = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json();
    expect(spaces.some((s: { name: string }) => s.name === 'Agentic OS')).toBe(true);

    // The database carries exactly the agent-definition fields.
    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const byName = new Map<string, { type: string }>(
      detail.fields.map((f: { apiName: string; type: string }) => [f.apiName, f]),
    );
    for (const expected of EXPECTED_FIELDS) {
      const field = byName.get(expected.name);
      expect(field, `missing field ${expected.name}`).toBeTruthy();
      expect(field!.type, `field ${expected.name} type`).toBe(expected.type);
    }

    // Select/multi_select options land as specified.
    const scopes = detail.fields.find((f: { apiName: string }) => f.apiName === 'scopes');
    expect(scopes.options.map((o: { label: string }) => o.label)).toEqual(['read', 'write', 'admin']);
    const trigger = detail.fields.find((f: { apiName: string }) => f.apiName === 'trigger');
    expect(trigger.options.map((o: { label: string }) => o.label)).toEqual([
      'Manual',
      'State change',
      'Schedule',
      'Automation',
    ]);
    const approval = detail.fields.find((f: { apiName: string }) => f.apiName === 'approval_policy');
    expect(approval.options.map((o: { label: string }) => o.label)).toEqual([
      'delete',
      'webhook',
      'email',
      'run_button',
      'outward',
    ]);
  });

  it('ensure is idempotent — same database id, no duplicate fields', async () => {
    const first = (await as(admin.token, 'GET', `/workspaces/${wsId}/agents`)).json();
    const dbId = first.id;

    const again = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().created).toBe(false);
    expect(again.json().agentsDb.id).toBe(dbId);

    // No duplicate database.
    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
    expect(dbs.filter((d: { name: string }) => d.name === 'Agents')).toHaveLength(1);

    // No duplicate fields (still exactly the seven definition fields; title/system excluded).
    const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const defFields = detail.fields.filter((f: { apiName: string }) =>
      EXPECTED_FIELDS.some((e) => e.name === f.apiName),
    );
    expect(defFields).toHaveLength(EXPECTED_FIELDS.length);

    // No duplicate "Agentic OS" space.
    const spaces = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json();
    expect(spaces.filter((s: { name: string }) => s.name === 'Agentic OS')).toHaveLength(1);
  });

  it('GET returns the Agents database summary once provisioned', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/agents`);
    expect(res.statusCode).toBe(200);
    expect(res.json().exists).toBe(true);
    expect(res.json().name).toBe('Agents');
    expect(res.json().id).toBeTruthy();
  });

  it('is admin-only — a non-admin member gets 403', async () => {
    const get = await as(member.token, 'GET', `/workspaces/${wsId}/agents`);
    expect(get.statusCode).toBe(403);
    const ensure = await as(member.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(ensure.statusCode).toBe(403);
  });
});
