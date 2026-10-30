import { expect } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Pool } from 'pg';
import { authed, signUpUser } from './users';
import { call, joinAs } from './members';
import type { Person } from './members';

/**
 * #1135 — a REAL per-run credential, minted the only way production mints one: a member pairs a Runner, an agent is assigned to it,
 * a wake is delegated, the Runner claims it, and the credential comes back in the claim response (ADR-0021 §4, #1132). Nothing here
 * inserts an `api_tokens` row by hand: a fixture that forged the token would pass for the cases the real one never reaches.
 */
export interface RunCredentialWorld {
  app: NestFastifyApplication;
  ws: string;
  admin: { token: string; email: string };
  /** A MEMBER: owns the agent and the Runner. */
  owner: Person;
  agentsDbId: string;
  ticketsDbId: string;
  notesApi: string;
  spaceId: string;
  agentId: string;
  /** The per-run credential (write scope): `mn_pat_…`. */
  credential: string;
  runnerToken: string;
  wakeId: string;
  ticketId: string;
  as: (token: string | null, method: string, url: string, payload?: unknown) => ReturnType<typeof call>;
}

export async function buildRunCredentialWorld(app: NestFastifyApplication, pool: Pool, label: string): Promise<RunCredentialWorld> {
  const as = (token: string | null, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
  const asRunner = (token: string, method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });

  const admin = await signUpUser(app, `${label}Admin`);
  const ws = (await as(admin.token, 'POST', '/workspaces', { name: `${label} WS` })).json().id as string;
  const ensured = (await as(admin.token, 'POST', `/workspaces/${ws}/agents/ensure`)).json();
  const agentsDbId = ensured.agentsDb.id as string;
  const opt = async (dbId: string, field: string) =>
    Object.fromEntries(
      (await pool.query('select o.label, o.id from select_options o join fields f on f.id = o.field_id where f.database_id = $1 and f.api_name = $2', [dbId, field])).rows.map(
        (r: { label: string; id: string }) => [r.label, r.id],
      ),
    ) as Record<string, string>;
  const aiOwn = (await opt(agentsDbId, 'ai_mode'))['Your own AI']!;
  const scopeIds = await opt(agentsDbId, 'scopes');
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${ws}/spaces`)).json()[0].id as string;
  const ticketsDbId = (await as(admin.token, 'POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id as string;
  const notesApi = (await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/fields`, { display_name: 'Notes', type: 'text', config: {} })).json().apiName as string;
  const owner = await joinAs(app, admin.token, ws, `${label}Owner`, 'member');

  const agentRes = await as(owner.token, 'POST', `/workspaces/${ws}/databases/${agentsDbId}/records`, {
    values: { name: `${label} bot`, enabled: true, ai_mode: aiOwn, scopes: [scopeIds['write']] },
  });
  expect(agentRes.statusCode, agentRes.body).toBe(201);
  const agentId = agentRes.json().id as string;

  const code = (await as(owner.token, 'POST', `/workspaces/${ws}/runners/pairing-codes`)).json() as { code: string };
  const paired = await asRunner('x', 'POST', '/runner/v1/pair', {
    code: code.code,
    machine_name: 'audit machine',
    tools: [{ id: 'claude-code', name: 'Claude Code', installed: true, version: '2.1.104', logged_in: true }],
    runner_version: '0.1.0',
    protocol_version: 1,
  });
  expect(paired.statusCode, paired.body).toBe(201);
  const { token: runnerToken, runner } = paired.json() as { token: string; runner: { id: string } };
  expect((await as(owner.token, 'POST', `/workspaces/${ws}/runners/${runner.id}/activate`, { tool: 'claude-code' })).statusCode).toBe(200);
  expect((await as(owner.token, 'PUT', `/workspaces/${ws}/runner-assignments/${agentId}`, { runner_id: runner.id })).statusCode).toBe(200);

  const ticket = await as(admin.token, 'POST', `/workspaces/${ws}/databases/${ticketsDbId}/records`, { values: { name: 'Audit ticket', [notesApi]: 'start' } });
  expect(ticket.statusCode, ticket.body).toBe(201);
  const ticketId = ticket.json().id as string;
  const delegated = await as(admin.token, 'POST', `/workspaces/${ws}/agents/${agentId}/delegate`, { record_id: ticketId });
  expect(delegated.statusCode, delegated.body).toBe(201);
  const claimed = await asRunner(runnerToken, 'POST', '/runner/v1/claim', { wait_seconds: 0 });
  expect(claimed.statusCode, claimed.body).toBe(200);
  const wake = (claimed.json() as { wakes: Array<{ id: string; credential: { token: string; scope: string } }> }).wakes[0];
  expect(wake, claimed.body).toBeTruthy();
  expect(wake!.credential.scope).toBe('write');

  return { app, ws, admin, owner, agentsDbId, ticketsDbId, notesApi, spaceId, agentId, credential: wake!.credential.token, runnerToken, wakeId: wake!.id, ticketId, as };
}
