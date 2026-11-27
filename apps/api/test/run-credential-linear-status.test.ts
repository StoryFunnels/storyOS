import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher } from './helpers/linear-fake';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { issueShape, WORKFLOW_STATES } from './fixtures/linear-documented-shapes';
import { LinearService } from '../src/integrations/linear.service';
import { LinearStatusWriteBackService, ISSUE_STATUS_QUERY, ISSUE_STATUS_UPDATE_MUTATION } from '../src/integrations/linear-status-write-back.service';

/**
 * Ticket #1390 / ADR-0021 section 7 - the status write-back's destination is the admin's own Linear, behind an admin's per-team switch, so a
 * status changed with an agent's RUN CREDENTIAL is written as configured and LOGGED with the agent and the run (`outward.linear_status`).
 * Proof for the `held` verdict in helpers/outward-audit.ts FANOUT_CONSUMERS. A person's identical change is the control.
 *
 * The Linear side is a mock from the documented shapes (no key exists); the credential is minted the way production mints it.
 */
const ENG = { id: 'team-eng', key: 'ENG', name: 'Engineering' };
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
let app: NestFastifyApplication;
let w: RunCredentialWorld;
const { pool } = connectTestDb();
const sent: Array<{ id: string; input: unknown }> = [];

const outwardLog = async () =>
  (await pool.query("select source, agent_id, agent_name, run_id, runner_name, payload from activity_events where type = 'outward.linear_status' and workspace_id = $1", [w.ws])).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  app = await createTestApp();
  w = await buildRunCredentialWorld(app, pool, 'LinStatus1390');
  const linear = app.get(LinearService);
  const state = new Map<string, string>();
  const issues = [1, 2].map((n) => issueShape(ENG, n, { title: `Issue ${n}`, state: { type: 'unstarted', name: 'Todo' } }));
  for (const i of issues) state.set(i.id, 'Todo');
  const fake = makeLinearFetcher([{ ...ENG, data: { ...empty, issues: { nodes: issues as never }, states: WORKFLOW_STATES } }]);
  linear.fetcher = async (query, variables, key) => {
    if (query === ISSUE_STATUS_QUERY) {
      const st = WORKFLOW_STATES.find((s) => s.name === state.get(String(variables['id'])))!;
      return { issue: { id: variables['id'], state: { id: st.id, name: st.name }, team: { id: 'x', key: 'ENG', states: { nodes: WORKFLOW_STATES, pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (query === ISSUE_STATUS_UPDATE_MUTATION) {
      const input = variables['input'] as { stateId: string };
      sent.push({ id: String(variables['id']), input });
      state.set(String(variables['id']), WORKFLOW_STATES.find((s) => s.id === input.stateId)!.name);
      return { issueUpdate: { success: true, issue: { id: variables['id'], state: { id: input.stateId, name: 'x' } } } };
    }
    return fake.fetcher(query, variables, key);
  };
  const at = (method: string, url: string, payload?: unknown) => w.as(w.admin.token, method, `/workspaces/${w.ws}${url}`, payload);
  expect((await at('POST', '/integrations/linear', { api_key: 'lin_api_proof', team_keys: ['ENG'] })).statusCode).toBe(201);
  expect((await at('POST', '/integrations/linear/sync')).statusCode).toBe(201);
  expect((await at('PUT', '/integrations/linear/teams/ENG/ownership', { owner: 'storyos' })).statusCode).toBe(200);
  expect((await at('PUT', '/integrations/linear/teams/ENG/status-write-back', { enabled: true })).statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 20));
}, 240_000);
afterAll(async () => {
  await app.close();
  await pool.end();
});

const setStatus = async (token: string, n: number, label: string) => {
  const db = (await pool.query("select d.id from databases d join spaces s on s.id = d.space_id where s.workspace_id = $1 and s.name = 'Engineering (Linear)' and d.name = 'Issues'", [w.ws])).rows[0].id as string;
  const rec = (await pool.query('select id from records where database_id = $1 and number = $2', [db, n])).rows[0].id as string;
  const opt = (await pool.query("select so.id from select_options so join fields f on f.id = so.field_id where f.database_id = $1 and f.api_name = 'state' and so.label = $2", [db, label])).rows[0].id as string;
  const res = await w.as(token, 'PATCH', `/workspaces/${w.ws}/databases/${db}/records/${rec}`, { values: { state: opt } });
  expect(res.statusCode, res.body).toBe(200);
  return rec;
};

describe('a status an agent set is written to Linear as configured and logged with the agent and the run', () => {
  it("the agent's change: one write of the state id, and an outward.linear_status row naming the agent, the run and the Runner", async () => {
    const recordId = await setStatus(w.credential, 1, 'In Progress');
    await app.get(LinearStatusWriteBackService).tick(new Date(Date.now() + 3_600_000));
    expect(sent).toEqual([{ id: 'lin-eng-1', input: { stateId: 'st-prog' } }]);
    const rows = await outwardLog();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'agent', agent_id: w.agentId, agent_name: 'LinStatus1390 bot', runner_name: 'audit machine' });
    expect(rows[0]!['run_id']).toBeTruthy();
    expect((rows[0]!['payload'] as { object: { id: string } }).object.id).toBe(recordId);
  });

  it("CONTROL: a person's identical change is written too, with no agent log row", async () => {
    await setStatus(w.admin.token, 2, 'In Progress');
    await app.get(LinearStatusWriteBackService).tick(new Date(Date.now() + 7_200_000));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ id: 'lin-eng-2', input: { stateId: 'st-prog' } });
    expect(await outwardLog()).toHaveLength(1);
  });
});
