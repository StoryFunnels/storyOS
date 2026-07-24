import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { platformAdmins } from '../src/db/schema';

/**
 * #300, MN-216c — the superadmin cross-workspace runs view + kill-switch.
 * Two entirely separate workspaces (own owners, own agents pack) prove the
 * "cross-workspace" half; the operator belongs to neither.
 */

let app: NestFastifyApplication;
let db: Db;
let operator: { token: string; email: string; id: string };
let ownerA: { token: string; email: string };
let ownerB: { token: string; email: string };

let wsA: string;
let wsB: string;
let agentsDbA: string;
let agentsDbB: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

interface FieldDetail {
  id: string;
  apiName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

async function fieldsOf(token: string, ws: string, dbId: string): Promise<Map<string, FieldDetail>> {
  const detail = (await as(token, 'GET', `/workspaces/${ws}/databases/${dbId}`)).json();
  return new Map(detail.fields.map((f: FieldDetail) => [f.apiName, f]));
}

function optionId(field: FieldDetail | undefined, label: string): string {
  const option = field?.options?.find((o) => o.label === label);
  if (!option) throw new Error(`no option "${label}" on ${field?.apiName}`);
  return option.id;
}

/** Create an enabled, write-scoped agent in `ws`, run as `token` (must be an admin/owner of `ws`). */
async function createAgent(token: string, ws: string, agentsDb: string, name: string, policy: string[] = []) {
  const fields = await fieldsOf(token, ws, agentsDb);
  const res = await as(token, 'POST', `/workspaces/${ws}/databases/${agentsDb}/records`, {
    values: {
      name,
      enabled: true,
      // The fixture parks a delete proposal. #330 correctly requires the
      // derived principal to be admin for that destructive operation.
      scopes: [optionId(fields.get('scopes'), 'admin')],
      ...(policy.length
        ? { approval_policy: policy.map((p) => optionId(fields.get('approval_policy'), p)) }
        : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** A runtime that immediately proposes `action` and stops — parks the run Waiting approval. */
function stagingRuntime(action: ProposedAction): AgentRuntime {
  return {
    runClass: 'non_ai',
    async *execute() {
      yield { tool: 'propose', summary: action.summary, action };
    },
  };
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  operator = { ...(await signUpUser(app, 'RunsAdminOperator')), id: '' };
  ownerA = await signUpUser(app, 'RunsAdminOwnerA');
  ownerB = await signUpUser(app, 'RunsAdminOwnerB');

  const me = await as(operator.token, 'GET', '/me');
  operator.id = me.json().id;
  await db.insert(platformAdmins).values({ userId: operator.id, grantedBy: null });

  wsA = (await as(ownerA.token, 'POST', '/workspaces', { name: 'Runs Admin WS A' })).json().id;
  wsB = (await as(ownerB.token, 'POST', '/workspaces', { name: 'Runs Admin WS B' })).json().id;

  const ensuredA = await as(ownerA.token, 'POST', `/workspaces/${wsA}/agents/ensure`);
  agentsDbA = ensuredA.json().agentsDb.id;

  const ensuredB = await as(ownerB.token, 'POST', `/workspaces/${wsB}/agents/ensure`);
  agentsDbB = ensuredB.json().agentsDb.id;

  // wsA: an ordinary Succeeded run.
  const agentA = await createAgent(ownerA.token, wsA, agentsDbA, 'Succeeding bot A');
  const runA = await as(ownerA.token, 'POST', `/workspaces/${wsA}/agents/${agentA.id}/run`);
  expect(runA.statusCode, runA.body).toBe(201);

  // wsB: a run parked Waiting approval, so a non-terminal run exists cross-workspace.
  const agentB = await createAgent(ownerB.token, wsB, agentsDbB, 'Gated bot B', ['delete']);
  const service = app.get(AgentsService);
  const original = service.runtimeFor;
  service.runtimeFor = () =>
    stagingRuntime({
      kind: 'delete',
      summary: 'delete something',
      payload: { apply: 'record_delete', database_id: agentsDbB, record_id: agentB.id },
    });
  try {
    const runB = await as(ownerB.token, 'POST', `/workspaces/${wsB}/agents/${agentB.id}/run`);
    expect(runB.statusCode, runB.body).toBe(201);
    expect(runB.json().values.status).toBeTruthy();
  } finally {
    service.runtimeFor = original;
  }
});

afterAll(async () => {
  await app.close();
});

describe('GET /admin/runs — #300, MN-216c', () => {
  it('401s with no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/runs' });
    expect(res.statusCode).toBe(401);
  });

  it('403s for a non-platform-admin', async () => {
    const res = await as(ownerA.token, 'GET', '/admin/runs');
    expect(res.statusCode).toBe(403);
  });

  it('a platform admin sees runs from BOTH workspaces, neither of which they belong to', async () => {
    const res = await as(operator.token, 'GET', '/admin/runs');
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json() as Array<{
      workspaceId: string;
      workspaceName: string;
      agent: { title: string } | null;
      status: string | null;
      runClass: string | null;
      trigger: string | null;
    }>;

    const fromA = rows.find((r) => r.workspaceId === wsA);
    const fromB = rows.find((r) => r.workspaceId === wsB);
    expect(fromA, 'a run from workspace A').toBeTruthy();
    expect(fromB, 'a run from workspace B').toBeTruthy();

    expect(fromA!.workspaceName).toBe('Runs Admin WS A');
    expect(fromA!.agent?.title).toBe('Succeeding bot A');
    expect(fromA!.status).toBe('Succeeded');
    expect(fromA!.runClass).toBe('Non-AI');
    expect(fromA!.trigger).toBe('Manual');

    expect(fromB!.workspaceName).toBe('Runs Admin WS B');
    expect(fromB!.agent?.title).toBe('Gated bot B');
    expect(fromB!.status).toBe('Waiting approval');
  });
});

describe('POST /admin/runs/:workspaceId/:run/cancel — #300, MN-216c', () => {
  it('401s with no auth', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/admin/runs/${wsB}/x/cancel` });
    expect(res.statusCode).toBe(401);
  });

  it('403s for a non-platform-admin', async () => {
    const rows = (await as(operator.token, 'GET', '/admin/runs')).json() as Array<{
      id: string;
      workspaceId: string;
    }>;
    const waiting = rows.find((r) => r.workspaceId === wsB)!;
    const res = await as(ownerB.token, 'POST', `/admin/runs/${wsB}/${waiting.id}/cancel`);
    expect(res.statusCode).toBe(403);
  });

  it('404s for an unknown run id in a real workspace', async () => {
    const res = await as(
      operator.token,
      'POST',
      `/admin/runs/${wsA}/00000000-0000-4000-8000-000000000000/cancel`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('404s for a workspace with no Runs database at all', async () => {
    const bareOwner = await signUpUser(app, 'RunsAdminBareOwner');
    const bareWs = (await as(bareOwner.token, 'POST', '/workspaces', { name: 'No agents pack' })).json().id;
    const res = await as(
      operator.token,
      'POST',
      `/admin/runs/${bareWs}/00000000-0000-4000-8000-000000000000/cancel`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('422s canceling a run that already finished (Succeeded)', async () => {
    const rows = (await as(operator.token, 'GET', '/admin/runs')).json() as Array<{
      id: string;
      workspaceId: string;
      status: string | null;
    }>;
    const succeeded = rows.find((r) => r.workspaceId === wsA && r.status === 'Succeeded')!;
    const res = await as(operator.token, 'POST', `/admin/runs/${wsA}/${succeeded.id}/cancel`);
    expect(res.statusCode, res.body).toBe(422);
  });

  it('cancels a Waiting-approval run in a workspace the operator does not belong to — status flip only', async () => {
    const before = (await as(operator.token, 'GET', '/admin/runs')).json() as Array<{
      id: string;
      workspaceId: string;
      status: string | null;
    }>;
    const waiting = before.find((r) => r.workspaceId === wsB && r.status === 'Waiting approval')!;

    const res = await as(operator.token, 'POST', `/admin/runs/${wsB}/${waiting.id}/cancel`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().values.status).toBeTruthy();

    const fields = await fieldsOf(
      ownerB.token,
      wsB,
      (await as(ownerB.token, 'GET', `/workspaces/${wsB}/agents`)).json().runs.id,
    );
    const canceledId = optionId(fields.get('status'), 'Canceled');
    expect(res.json().values.status).toBe(canceledId);

    // A pure status flip: the staged action's own record was never applied
    // (still there — a `delete` proposal would have removed it), and the
    // gate's own `pending_action` blob is left exactly as it was staged.
    const agentStillThere = await as(ownerB.token, 'GET', `/workspaces/${wsB}/databases/${agentsDbB}/records`);
    expect(agentStillThere.json().data.length).toBeGreaterThan(0);

    const runsDb = (await as(ownerB.token, 'GET', `/workspaces/${wsB}/agents`)).json().runs.id;
    const runRow = (
      await as(ownerB.token, 'GET', `/workspaces/${wsB}/databases/${runsDb}/records/${waiting.id}`)
    ).json();
    expect(runRow.values.pending_action).toBeTruthy();

    // 422 on a second cancel — it's no longer in a cancelable state.
    const again = await as(operator.token, 'POST', `/admin/runs/${wsB}/${waiting.id}/cancel`);
    expect(again.statusCode).toBe(422);
  });
});
