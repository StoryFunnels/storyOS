import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { RecordsService } from '../src/records/records.service';
import { asAgentRuntime } from '../src/records/runtime-owned-fields';

/**
 * #1062 — an agent run's runtime-owned fields (pending_action, run_class, cost) cannot be written through the records API.
 * The runtime still writes them (agent-runs / agent-approvals suites exercise that), and the fields a person is meant to set on a
 * run (Surface, Commit or image, name) stay writable.
 */
let app: NestFastifyApplication;
let user: { token: string };
let ws: string, runsDb: string, otherDb: string, runId: string;

const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(user.token), payload: (payload ?? {}) as never });
const records = (db: string) => `/workspaces/${ws}/databases/${db}/records`;

beforeAll(async () => {
  app = await createTestApp();
  user = await signUpUser(app, 'Member');
  ws = (await as('POST', '/workspaces', { name: 'Runs WS' })).json().id;
  runsDb = (await as('POST', `/workspaces/${ws}/agents/ensure`)).json().runsDb.id;
  const space = (await as('POST', `/workspaces/${ws}/spaces`, { name: 'Work' })).json();
  otherDb = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space.id, name: 'Costs' })).json().id;
  await as('POST', `/workspaces/${ws}/databases/${otherDb}/fields`, { display_name: 'Cost', type: 'number', config: {} });
  await as('POST', `/workspaces/${ws}/databases/${otherDb}/fields`, { display_name: 'Pending action', type: 'text', config: {} });
  runId = (await as('POST', records(runsDb), { values: { name: 'a run' } })).json().id;
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1062 writes to runtime-owned run fields', () => {
  it.each(['pending_action', 'run_class', 'cost'])('create with %s is refused with a clear 422', async (key) => {
    const res = await as('POST', records(runsDb), { values: { name: 'x', [key]: key === 'cost' ? 5 : null } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain(key);
    expect(res.body).toContain('agent runtime');
  });

  it('PATCH, upsert-style batch update and batch create are refused too', async () => {
    expect((await as('PATCH', `${records(runsDb)}/${runId}`, { values: { pending_action: '{}' } })).statusCode).toBe(422);
    expect((await as('PATCH', `${records(runsDb)}/batch`, { ids: [runId], values: { cost: 9 } })).json().failed?.length ?? 1).toBeGreaterThan(0);
    expect((await as('POST', `${records(runsDb)}/batch`, { records: [{ values: { name: 'b', cost: 1 } }] })).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('nothing was written by the refused attempts', async () => {
    const run = (await as('GET', `${records(runsDb)}/${runId}`)).json();
    expect(run.values.pending_action ?? null).toBeNull();
    expect(run.values.cost ?? null).toBeNull();
  });

  it("the database detail carries isSystem, which the MCP read-only flag keys on", async () => {
    const d = (await as('GET', `/workspaces/${ws}/databases/${runsDb}`)).json();
    expect(d.isSystem).toBe(true);
    expect(d.name).toBe('Runs');
  });

  it('what a person IS meant to set on a run stays writable', async () => {
    const res = await as('PATCH', `${records(runsDb)}/${runId}`, { values: { name: 'renamed', commit_or_image: 'abc123' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().values.commit_or_image).toBe('abc123');
  });

  it('a user database that merely has fields with the same names is untouched by the rule', async () => {
    const res = await as('POST', records(otherDb), { values: { name: 'mine', cost: 7, pending_action: 'x' } });
    expect(res.statusCode, res.body).toBe(201);
  });

  it('the runtime still writes them (inside the runtime scope)', async () => {
    const updated = await asAgentRuntime(() => app.get(RecordsService).update(ws, runsDb, runId, { pending_action: '{"a":1}', cost: 3 }, null));
    expect(updated.values.pending_action).toBe('{"a":1}');
    expect(updated.values.cost).toBe(3);
  });

  it('the scope does not leak: a write right after, outside it, is refused again', async () => {
    expect((await as('PATCH', `${records(runsDb)}/${runId}`, { values: { cost: 99 } })).statusCode).toBe(422);
  });
});
