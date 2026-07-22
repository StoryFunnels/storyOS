import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { AiCreditsService } from '../src/billing/ai-credits.service';
import { TokensService } from '../src/tokens/tokens.service';
import {
  ManagedAiRuntime,
  NonAiRuntime,
  pickRuntime,
  YourOwnAiRuntime,
} from '../src/agents/agent-runtime';
import type { AgentRuntime } from '../src/agents/agent-runtime';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let runsDbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

interface FieldDetail {
  id: string;
  apiName: string;
  type: string;
  config?: { relation_id?: string; side?: string };
  options?: Array<{ id: string; label: string }>;
}

/** Live field defs of a database, by api_name. */
async function fieldsOf(dbId: string): Promise<Map<string, FieldDetail>> {
  const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  return new Map(detail.fields.map((f: FieldDetail) => [f.apiName, f]));
}

/** The option id for a select label — select values are written as ids, not labels. */
function optionId(field: FieldDetail | undefined, label: string): string {
  const option = field?.options?.find((o) => o.label === label);
  if (!option) throw new Error(`no option "${label}" on ${field?.apiName}`);
  return option.id;
}

/** Flatten a BlockNote document to plain text — `Steps` is rich_text, not a string. */
function plainText(blocks: unknown): string {
  const out: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const block = node as { text?: unknown; content?: unknown; children?: unknown };
      if (typeof block.text === 'string') out.push(block.text);
      if (Array.isArray(block.content)) walk(block.content);
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return out.join(' ');
}

/** Create an agent record; `scopes` are passed as labels and mapped to option ids. */
async function createAgent(
  name: string,
  opts: { enabled: boolean; scopes?: string[]; targets?: string; aiMode?: string; goal?: string },
) {
  const fields = await fieldsOf(agentsDbId);
  const scopeField = fields.get('scopes');
  const aiModeField = fields.get('ai_mode');
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: {
      name,
      enabled: opts.enabled,
      scopes: (opts.scopes ?? []).map((s) => optionId(scopeField, s)),
      ...(opts.targets ? { target_databases: opts.targets } : {}),
      ...(opts.aiMode ? { ai_mode: optionId(aiModeField, opts.aiMode) } : {}),
      ...(opts.goal
        ? {
            goal: [{ type: 'paragraph', content: [{ type: 'text', text: opts.goal, styles: {} }] }],
          }
        : {}),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RunsAdmin');
  member = await signUpUser(app, 'RunsMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Runs WS' })).json().id;

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;
  runsDbId = ensured.json().runsDb.id;
});

afterAll(async () => {
  await app.close();
});

const EXPECTED_RUN_FIELDS = [
  { name: 'trigger', type: 'select' },
  { name: 'status', type: 'select' },
  { name: 'run_class', type: 'select' },
  { name: 'input_record', type: 'text' },
  { name: 'cost', type: 'number' },
  { name: 'started_at', type: 'date' },
  { name: 'finished_at', type: 'date' },
  { name: 'steps', type: 'rich_text' },
];

describe('Runs system database (#209, ADR-0010 §1)', () => {
  it('ensure creates the Runs database with its fields, in the Agentic OS space', async () => {
    expect(runsDbId).toBeTruthy();

    const fields = await fieldsOf(runsDbId);
    for (const expected of EXPECTED_RUN_FIELDS) {
      const field = fields.get(expected.name);
      expect(field, `missing field ${expected.name}`).toBeTruthy();
      expect(field!.type, `field ${expected.name} type`).toBe(expected.type);
    }

    expect(fields.get('status')!.options!.map((o) => o.label)).toEqual([
      'Queued',
      'Running',
      'Waiting approval',
      'Succeeded',
      'Failed',
      'Canceled',
    ]);
    // MN-188: the three classes the metering boundary is drawn on.
    expect(fields.get('run_class')!.options!.map((o) => o.label)).toEqual([
      'Non-AI',
      'Your own AI',
      'StoryOS AI',
    ]);
    expect(fields.get('trigger')!.options!.map((o) => o.label)).toEqual([
      'Manual',
      'State change',
      'Schedule',
      'Automation',
    ]);

    // Both pack databases live in the one "Agentic OS" space.
    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
    const runs = dbs.find((d: { id: string }) => d.id === runsDbId);
    const agents = dbs.find((d: { id: string }) => d.id === agentsDbId);
    expect(runs.space_id ?? runs.spaceId).toBe(agents.space_id ?? agents.spaceId);
  });

  it('ensure creates the Agent↔Runs relation — one agent, many runs', async () => {
    const runFields = await fieldsOf(runsDbId);
    const agentField = runFields.get('agent');
    expect(agentField, 'Runs.Agent relation field').toBeTruthy();
    expect(agentField!.type).toBe('relation');

    const agentFields = await fieldsOf(agentsDbId);
    const runsField = agentFields.get('runs');
    expect(runsField, 'Agents.Runs relation field').toBeTruthy();
    expect(runsField!.type).toBe('relation');

    // Both fields are the two sides of one relation: Runs (many) → Agents (one).
    const relationId = agentField!.config!.relation_id;
    expect(relationId).toBeTruthy();
    expect(runsField!.config!.relation_id).toBe(relationId);

    const rel = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/relations/${relationId}`)
    ).json();
    expect(rel.cardinality).toBe('one_to_many');
    // Side A is the "many" side that carries the single reference — a run has one agent.
    expect(rel.database_a_id).toBe(runsDbId);
    expect(rel.database_b_id).toBe(agentsDbId);
    expect(rel.field_a.display_name).toBe('Agent');
    expect(rel.field_b.display_name).toBe('Runs');
  });

  it('ensure creates the Agents "AI mode" field — the driver an owner picks (#205 item 1)', async () => {
    const fields = await fieldsOf(agentsDbId);
    const aiMode = fields.get('ai_mode');
    expect(aiMode, 'missing field ai_mode').toBeTruthy();
    expect(aiMode!.type).toBe('select');
    // Same three labels, same order, as Runs."Run class" (RUN_CLASS_LABEL) —
    // whatever an owner picks here is exactly what the Run gets stamped with.
    expect(aiMode!.options!.map((o) => o.label)).toEqual(['Non-AI', 'Your own AI', 'StoryOS AI']);
  });

  it('re-ensure is idempotent — no duplicate database, fields or relation', async () => {
    const again = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().created).toBe(false);
    expect(again.json().runsDb.id).toBe(runsDbId);
    expect(again.json().agentsDb.id).toBe(agentsDbId);

    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
    expect(dbs.filter((d: { name: string }) => d.name === 'Runs')).toHaveLength(1);

    const fields = await fieldsOf(runsDbId);
    for (const expected of EXPECTED_RUN_FIELDS) expect(fields.get(expected.name)).toBeTruthy();

    // The back-filled "AI mode" field isn't duplicated by a second ensure either.
    const agentFieldsAgain = [...(await fieldsOf(agentsDbId)).values()].filter(
      (f) => f.apiName === 'ai_mode',
    );
    expect(agentFieldsAgain).toHaveLength(1);

    // Exactly one relation field per side — no second Agent↔Runs relation.
    const runRelationFields = [...(await fieldsOf(runsDbId)).values()].filter(
      (f) => f.type === 'relation',
    );
    expect(runRelationFields).toHaveLength(1);
    // Agents carries one relation per pack database that points at it: Runs
    // (#209) and Triggers (#211). Named rather than counted, so this keeps
    // catching a duplicated Runs relation as the pack grows.
    const agentRelationFields = [...(await fieldsOf(agentsDbId)).values()].filter(
      (f) => f.type === 'relation',
    );
    expect(agentRelationFields.map((f) => f.apiName).sort()).toEqual(['runs', 'triggers']);
  });

  it('GET reports both pack databases', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/agents`);
    expect(res.statusCode).toBe(200);
    expect(res.json().exists).toBe(true);
    expect(res.json().id).toBe(agentsDbId);
    expect(res.json().name).toBe('Agents');
    expect(res.json().runs).toEqual({ id: runsDbId, name: 'Runs' });
  });
});

describe('Manual run (#208, ADR-0010 §3)', () => {
  it('runs an enabled agent → a Succeeded, Non-AI Run linked to the agent', async () => {
    const agent = await createAgent('Triage bot', {
      enabled: true,
      scopes: ['write'],
      targets: 'Issues',
    });

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
    expect(res.statusCode, res.body).toBe(201);
    const run = res.json();

    const fields = await fieldsOf(runsDbId);
    expect(run.title).toBe('Triage bot — Manual');
    expect(run.values.status).toBe(optionId(fields.get('status'), 'Succeeded'));
    expect(run.values.trigger).toBe(optionId(fields.get('trigger'), 'Manual'));
    // The run class is stamped at dispatch, before any step runs (ADR-0010 §3).
    expect(run.values.run_class).toBe(optionId(fields.get('run_class'), 'Non-AI'));
    expect(run.values.started_at).toBeTruthy();
    expect(run.values.finished_at).toBeTruthy();

    // A non-empty step log — the manual run is useful with no LLM at all.
    expect(run.values.steps).toBeTruthy();
    const steps = plainText(run.values.steps);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps).toContain('principal.resolve');
    expect(steps).toContain('targets.resolve');
    expect(steps).toContain('Issues');
    // The principal it resolved to, and the fact that nothing was metered.
    expect(steps).toContain('Declared scopes: write');
    expect(steps).toContain('no model was invoked');

    // Linked to the agent it ran.
    const stored = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records/${run.id}`)
    ).json();
    const links = stored.values.agent as Array<{ id: string }>;
    expect(links.map((l) => l.id)).toEqual([agent.id]);
  });

  it('an agent declaring no scopes runs as read — least privilege by default', async () => {
    const agent = await createAgent('Read-only watcher', { enabled: true, scopes: [] });
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
    expect(res.statusCode, res.body).toBe(201);
    const steps = plainText(res.json().values.steps);
    expect(steps).toContain('acting as the owner with  read  scope');
    expect(steps).toContain('(none — defaulted to read)');
  });

  it('resolves the agent by its public number too', async () => {
    const agent = await createAgent('Numbered bot', { enabled: true, scopes: ['read'] });
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.number}/run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().title).toBe('Numbered bot — Manual');
  });

  it('a disabled agent is 422 and creates no Run', async () => {
    const agent = await createAgent('Sleeping bot', { enabled: false, scopes: ['read'] });

    const before = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records`)
    ).json();
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
    expect(res.statusCode, res.body).toBe(422);

    const after = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records`)
    ).json();
    expect(after.data.length).toBe(before.data.length);
  });

  it('404s for an unknown agent', async () => {
    const missing = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/agents/00000000-0000-4000-8000-000000000000/run`,
    );
    expect(missing.statusCode).toBe(404);
    expect((await as(admin.token, 'POST', `/workspaces/${wsId}/agents/99999/run`)).statusCode).toBe(
      404,
    );
  });

  it('is admin-only — a non-admin member gets 403', async () => {
    const agent = await createAgent('Guarded bot', { enabled: true, scopes: ['read'] });
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
    expect(res.statusCode).toBe(403);
  });
});

describe('Run classification at dispatch (#205, ADR-0010 §3)', () => {
  it('pickRuntime returns the non-AI runtime — no LLM on the default path', () => {
    const runtime = pickRuntime({ id: 'a', name: 'A', scopes: [] });
    expect(runtime).toBeInstanceOf(NonAiRuntime);
    expect(runtime.runClass).toBe('non_ai');
  });

  it('pickRuntime selects the BYO-AI/MCP driver when an agent asks for it (#205 item 1)', () => {
    const runtime = pickRuntime({ id: 'a', name: 'A', scopes: [], aiMode: 'your_own_ai' });
    expect(runtime).toBeInstanceOf(YourOwnAiRuntime);
    expect(runtime.runClass).toBe('your_own_ai');
  });

  it('pickRuntime selects the (still-stub) managed runtime when an agent asks for storyos_ai', () => {
    const runtime = pickRuntime({ id: 'a', name: 'A', scopes: [], aiMode: 'storyos_ai' });
    expect(runtime).toBeInstanceOf(ManagedAiRuntime);
    expect(runtime.runClass).toBe('storyos_ai');
  });

  it('YourOwnAiRuntime reports honestly when the workspace has no live API token to connect', async () => {
    const steps = [];
    for await (const step of new YourOwnAiRuntime().execute({
      workspaceId: wsId,
      agent: { id: 'a', name: 'A', scopes: ['read'], goal: 'Triage new leads' },
      principal: { userId: 'u', scope: 'read' },
      aiConnected: false,
    })) {
      steps.push(step);
    }
    const tools = steps.map((s) => s.tool);
    expect(tools).toContain('principal.resolve');
    expect(tools).toContain('byo_ai.not_connected');
    expect(tools).not.toContain('byo_ai.handoff');
    const notConnected = steps.find((s) => s.tool === 'byo_ai.not_connected')!;
    expect(notConnected.detail).toMatch(/no live API token/i);
  });

  it('YourOwnAiRuntime hands off the goal/instructions once the workspace is connected', async () => {
    const steps = [];
    for await (const step of new YourOwnAiRuntime().execute({
      workspaceId: wsId,
      agent: { id: 'a', name: 'A', scopes: ['read'], goal: 'Triage new leads' },
      principal: { userId: 'u', scope: 'read' },
      aiConnected: true,
    })) {
      steps.push(step);
    }
    const tools = steps.map((s) => s.tool);
    expect(tools).toContain('byo_ai.handoff');
    expect(tools).not.toContain('byo_ai.not_connected');
    const handoff = steps.find((s) => s.tool === 'byo_ai.handoff')!;
    expect(handoff.detail).toContain('Triage new leads');
  });

  it('the managed runtime is a stub that says so rather than silently degrading', async () => {
    const iterate = async () => {
      for await (const _ of new ManagedAiRuntime().execute({
        workspaceId: wsId,
        agent: { id: 'a', name: 'A', scopes: [] },
        principal: { userId: 'u', scope: 'read' },
      })) {
        // no steps expected — execute throws
      }
    };
    await expect(iterate()).rejects.toThrow(/managed AI runtime not configured/i);
  });

  it('stamps the run class BEFORE any step executes — a your-own-AI run is never metered', async () => {
    const agent = await createAgent('BYO bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const original = service.runtimeFor;

    // A runtime that records what the Run already looked like on its first step.
    let runClassAtFirstStep: unknown;
    const byo: AgentRuntime = {
      runClass: 'your_own_ai',
      async *execute() {
        const runs = (
          await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records`)
        ).json();
        const mine = runs.data.filter((r: { title: string }) => r.title === 'BYO bot — Manual');
        runClassAtFirstStep = mine[0]?.values.run_class;
        yield { tool: 'byo.step', summary: 'drove a tool over MCP' };
      },
    };
    service.runtimeFor = () => byo;
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);

      const fields = await fieldsOf(runsDbId);
      const yourOwnAi = optionId(fields.get('run_class'), 'Your own AI');
      // Classified at dispatch: already stamped when the first step ran, and
      // unchanged by what the run went on to do (ADR-0010 §3).
      expect(runClassAtFirstStep).toBe(yourOwnAi);
      expect(res.json().values.run_class).toBe(yourOwnAi);
    } finally {
      service.runtimeFor = original;
    }
  });

  it('a runtime error lands as a Failed run, never a 500', async () => {
    const agent = await createAgent('Exploding bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    service.runtimeFor = () => ({
      runClass: 'non_ai',
      // eslint-disable-next-line require-yield
      async *execute() {
        throw new Error('tool blew up');
      },
    });
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);

      const fields = await fieldsOf(runsDbId);
      const run = res.json();
      expect(run.values.status).toBe(optionId(fields.get('status'), 'Failed'));
      expect(run.values.finished_at).toBeTruthy();
      // The failure is recorded where the user will look for it.
      expect(plainText(run.values.steps)).toContain('tool blew up');
    } finally {
      service.runtimeFor = original;
    }
  });

  it('keeps steps produced before a mid-run failure', async () => {
    const agent = await createAgent('Half-way bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    service.runtimeFor = () => ({
      runClass: 'non_ai',
      async *execute() {
        yield { tool: 'step.one', summary: 'did the first thing' };
        throw new Error('then it broke');
      },
    });
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      const steps = plainText(res.json().values.steps);
      expect(steps).toContain('did the first thing');
      expect(steps).toContain('then it broke');
    } finally {
      service.runtimeFor = original;
    }
  });

  describe('an agent set to "Your own AI" actually dispatches the BYO-AI driver (#205 item 1)', () => {
    /** The admin's bare userId — TokensService.create needs it, not a bearer token. */
    async function adminUserId(): Promise<string> {
      const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
      const list = Array.isArray(members) ? members : members.data;
      const mine = list.find(
        (m: { user: { email: string; id: string } }) => m.user.email === admin.email,
      );
      if (!mine) throw new Error('admin membership not found');
      return mine.user.id;
    }

    it('stamps "Your own AI" and reports the missing on-ramp when no token is connected', async () => {
      const agent = await createAgent('Unconnected BYO bot', {
        enabled: true,
        scopes: ['read'],
        aiMode: 'Your own AI',
        goal: 'Draft replies to new leads',
      });

      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      const run = res.json();

      const runFields = await fieldsOf(runsDbId);
      // pickRuntime actually read the agent's own field — not the always-non_ai
      // default this ticket started from.
      expect(run.values.run_class).toBe(optionId(runFields.get('run_class'), 'Your own AI'));

      const steps = plainText(run.values.steps);
      expect(steps).toContain('byo_ai.not_connected');
      expect(steps).toMatch(/no live API token/i);
      expect(steps).not.toContain('byo_ai.handoff');
    });

    it('hands off the goal once the workspace has a live API token connected', async () => {
      const tokens = app.get(TokensService);
      const userId = await adminUserId();
      const created = await tokens.create(userId, wsId, 'BYO-AI test token');
      try {
        const agent = await createAgent('Connected BYO bot', {
          enabled: true,
          scopes: ['read'],
          aiMode: 'Your own AI',
          goal: 'Draft replies to new leads',
        });

        const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
        expect(res.statusCode, res.body).toBe(201);
        const run = res.json();

        const runFields = await fieldsOf(runsDbId);
        expect(run.values.run_class).toBe(optionId(runFields.get('run_class'), 'Your own AI'));

        const steps = plainText(run.values.steps);
        expect(steps).toContain('byo_ai.handoff');
        expect(steps).toContain('Draft replies to new leads');
        expect(steps).not.toContain('byo_ai.not_connected');
      } finally {
        // Leave the workspace exactly as this test found it — later cases in
        // this describe rely on there being no OTHER live token around.
        await tokens.revoke(userId, created.id);
      }
    });

    it('a revoked token does not count as connected', async () => {
      const tokens = app.get(TokensService);
      const userId = await adminUserId();
      const created = await tokens.create(userId, wsId, 'Revoked-before-run token');
      await tokens.revoke(userId, created.id);

      const agent = await createAgent('Revoked-token BYO bot', {
        enabled: true,
        scopes: ['read'],
        aiMode: 'Your own AI',
      });

      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      expect(plainText(res.json().values.steps)).toContain('byo_ai.not_connected');
    });

    it('an agent left at the default "AI mode" still runs non_ai — unchanged behavior', async () => {
      const agent = await createAgent('Default-mode bot', { enabled: true, scopes: ['read'] });
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      const runFields = await fieldsOf(runsDbId);
      expect(res.json().values.run_class).toBe(optionId(runFields.get('run_class'), 'Non-AI'));
    });
  });
});

describe('MN-168 — entitlements wiring at dispatch', () => {
  /**
   * Stripe is unset in the test env, so EntitlementsService.can()/recordNonAiRun
   * are real no-ops (self-host mode) — proving nothing. These tests spy on the
   * singleton's methods directly, the same technique agents.runtimeFor already
   * uses, so the assertion is about WHICH code path calls the entitlements
   * service, not about a live Stripe-backed counter (that's entitlements.
   * service.test.ts's job).
   */
  function spyEntitlements() {
    const service = app.get(EntitlementsService);
    const originalCan = service.can.bind(service);
    const originalRecord = service.recordNonAiRun.bind(service);
    const canSpy = vi.fn(originalCan);
    const recordSpy = vi.fn(originalRecord);
    service.can = canSpy;
    service.recordNonAiRun = recordSpy;
    return {
      canSpy,
      recordSpy,
      restore: () => {
        service.can = originalCan;
        service.recordNonAiRun = originalRecord;
      },
    };
  }

  it('a non-AI run counts toward the automation-run allowance', async () => {
    const agent = await createAgent('Counted bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const originalRuntime = service.runtimeFor;
    service.runtimeFor = () => new NonAiRuntime();
    const { recordSpy, restore } = spyEntitlements();
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      expect(recordSpy).toHaveBeenCalledExactlyOnceWith(wsId);
    } finally {
      service.runtimeFor = originalRuntime;
      restore();
    }
  });

  it('a your-own-AI run never reaches the entitlements counter — MN-188 structural guarantee', async () => {
    const agent = await createAgent('BYO counted bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const originalRuntime = service.runtimeFor;
    const byo: AgentRuntime = {
      runClass: 'your_own_ai',
      async *execute() {
        yield { tool: 'byo.step', summary: 'drove a tool over MCP' };
      },
    };
    service.runtimeFor = () => byo;
    const { canSpy, recordSpy, restore } = spyEntitlements();
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      // Not merely "unmetered" — no code path calls EITHER method at all.
      expect(canSpy).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      service.runtimeFor = originalRuntime;
      restore();
    }
  });

  it('a StoryOS-AI run never decrements the non-AI automation allowance', async () => {
    const agent = await createAgent('Managed-AI bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const originalRuntime = service.runtimeFor;
    const managed: AgentRuntime = {
      runClass: 'storyos_ai',
      async *execute() {
        yield { tool: 'managed.step', summary: 'called the managed model' };
      },
    };
    service.runtimeFor = () => managed;
    const { canSpy, recordSpy, restore } = spyEntitlements();
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      // The two ledgers must never be conflated: a StoryOS-AI run draws
      // prepaid credits (MN-189), never the automation-run allowance.
      expect(canSpy).not.toHaveBeenCalled();
      expect(recordSpy).not.toHaveBeenCalled();
    } finally {
      service.runtimeFor = originalRuntime;
      restore();
    }
  });

  it('blocks a non-AI run over its allowance BEFORE any step executes — graceful, not a 500', async () => {
    const agent = await createAgent('Over-quota bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const originalRuntime = service.runtimeFor;
    let executed = false;
    service.runtimeFor = () => ({
      runClass: 'non_ai',
      async *execute() {
        executed = true; // must never flip — the run is blocked before dispatch
        yield { tool: 'should.never.run', summary: 'unreachable' };
      },
    });
    const entitlements = app.get(EntitlementsService);
    const originalCan = entitlements.can.bind(entitlements);
    entitlements.can = vi.fn(async (workspaceId: string, capability) =>
      workspaceId === wsId ? false : originalCan(workspaceId, capability),
    );
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201); // a real, visible Run — not a request failure

      const fields = await fieldsOf(runsDbId);
      const run = res.json();
      expect(run.values.status).toBe(optionId(fields.get('status'), 'Failed'));
      expect(run.values.finished_at).toBeTruthy();
      expect(plainText(run.values.steps)).toMatch(/allowance/i);
      expect(executed).toBe(false);
    } finally {
      service.runtimeFor = originalRuntime;
      entitlements.can = originalCan;
    }
  });
});

describe('MN-188 — StoryOS-AI runs decrement prepaid credits', () => {
  /** The admin's bare userId — needed to invoke the completion hook directly. */
  async function adminUserId(): Promise<string> {
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    const list = Array.isArray(members) ? members : members.data;
    const mine = list.find(
      (m: { user: { email: string; id: string } }) => m.user.email === admin.email,
    );
    if (!mine) throw new Error('admin membership not found');
    return mine.user.id;
  }

  function storyOsAiRuntime(): AgentRuntime {
    return {
      runClass: 'storyos_ai',
      async *execute() {
        yield { tool: 'managed.step', summary: 'called the managed model' };
      },
    };
  }

  it('a completed StoryOS-AI run charges the workspace ai_credit_balances exactly once, via AiCreditsService', async () => {
    const agent = await createAgent('Metered AI bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const aiCredits = app.get(AiCreditsService);
    const originalRuntime = service.runtimeFor;
    const originalRecordUsage = aiCredits.recordUsage.bind(aiCredits);
    const recordUsageSpy = vi.fn(originalRecordUsage);
    service.runtimeFor = () => storyOsAiRuntime();
    aiCredits.recordUsage = recordUsageSpy;
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      const run = res.json();

      const fields = await fieldsOf(runsDbId);
      expect(run.values.status).toBe(optionId(fields.get('status'), 'Succeeded'));
      expect(run.values.run_class).toBe(optionId(fields.get('run_class'), 'StoryOS AI'));

      // Wired through AiCreditsService's existing API — no parallel mechanism —
      // and charged exactly once for the one completed run.
      expect(recordUsageSpy).toHaveBeenCalledTimes(1);
      // The Run's own `cost` field records what was charged (in cents) — a
      // real, inspectable number, even though it's a placeholder pending
      // MN-214r's real per-run token cost.
      expect(run.values.cost).toBeGreaterThan(0);
    } finally {
      service.runtimeFor = originalRuntime;
      aiCredits.recordUsage = originalRecordUsage;
    }
  });

  it('never fires for non-AI or your-own-AI runs — the class boundary MN-188 draws', async () => {
    const aiCredits = app.get(AiCreditsService);
    const originalRecordUsage = aiCredits.recordUsage.bind(aiCredits);
    const recordUsageSpy = vi.fn(originalRecordUsage);
    aiCredits.recordUsage = recordUsageSpy;
    const service = app.get(AgentsService);
    const originalRuntime = service.runtimeFor;
    try {
      // non_ai
      const nonAi = await createAgent('Unmetered non-AI bot', { enabled: true, scopes: ['read'] });
      service.runtimeFor = () => new NonAiRuntime();
      expect(
        (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${nonAi.id}/run`)).statusCode,
      ).toBe(201);

      // your_own_ai
      const byo = await createAgent('Unmetered BYO bot', { enabled: true, scopes: ['read'] });
      service.runtimeFor = () => ({
        runClass: 'your_own_ai',
        async *execute() {
          yield { tool: 'byo.step', summary: 'drove a tool over MCP' };
        },
      });
      expect(
        (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${byo.id}/run`)).statusCode,
      ).toBe(201);

      expect(recordUsageSpy).not.toHaveBeenCalled();
    } finally {
      service.runtimeFor = originalRuntime;
      aiCredits.recordUsage = originalRecordUsage;
    }
  });

  it('is idempotent — invoking the completion hook twice for the same run only decrements once', async () => {
    const agent = await createAgent('Double-billed bot', { enabled: true, scopes: ['read'] });
    const service = app.get(AgentsService);
    const aiCredits = app.get(AiCreditsService);
    const originalRuntime = service.runtimeFor;
    const originalRecordUsage = aiCredits.recordUsage.bind(aiCredits);
    const recordUsageSpy = vi.fn(originalRecordUsage);
    service.runtimeFor = () => storyOsAiRuntime();
    aiCredits.recordUsage = recordUsageSpy;
    try {
      const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/run`);
      expect(res.statusCode, res.body).toBe(201);
      const run = res.json();
      expect(recordUsageSpy).toHaveBeenCalledTimes(1);

      // Simulate the completion path firing a second time for the SAME run
      // (e.g. a retried job or a duplicate event) by calling the private
      // completion hook directly — the same technique `service.runtimeFor`
      // swapping already relies on to reach behavior with no HTTP-level seam.
      const actorId = await adminUserId();
      const chargeAgain = (
        service as unknown as {
          chargeStoryOsAiRun: (
            workspaceId: string,
            runsDbId: string,
            run: unknown,
            actorId: string,
          ) => Promise<unknown>;
        }
      ).chargeStoryOsAiRun.bind(service);
      const secondResult = (await chargeAgain(wsId, runsDbId, run, actorId)) as {
        values: { cost: number };
      };

      // Still only ever charged once — the run's own `cost` field was the guard.
      expect(recordUsageSpy).toHaveBeenCalledTimes(1);
      expect(secondResult.values.cost).toBe(run.values.cost);
    } finally {
      service.runtimeFor = originalRuntime;
      aiCredits.recordUsage = originalRecordUsage;
    }
  });
});
