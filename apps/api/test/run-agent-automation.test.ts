import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { RecordsService } from '../src/records/records.service';
import type { AgentRuntime } from '../src/agents/agent-runtime';

/**
 * MN-109 Phase A — the run_agent automation action.
 *
 * A run_agent action is a `run this agent` entry into the SAME machinery
 * every other trigger uses (AgentsService.dispatchRun) — reached from the
 * regular automations engine (schedule / record event / button) rather than
 * the Architect's state-transition bindings (#212). It is durable-queued
 * (MN-253's JobRunnerService) exactly like any other long-running action
 * kind, so the tests below drive the REAL path end to end: an HTTP record
 * update → the domain-event bus → AutomationsService.runRule → the job
 * queue → AgentsService.runFromAutomation → dispatchRun → (a swapped-in test
 * runtime standing in for a real model, exactly like agent-runs.test.ts's
 * own runtimeFor doubles) → the agent's proposed action applied for real.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let contentDbId: string;
let stageFieldId: string;
let stageOptions: Map<string, string>;
let agentsDbId: string;
let runsDbId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

interface FieldDetail {
  id: string;
  apiName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

async function fieldsOf(dbId: string): Promise<Map<string, FieldDetail>> {
  const detail = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  return new Map(detail.fields.map((f: FieldDetail) => [f.apiName, f]));
}

function optionId(field: FieldDetail | undefined, label: string): string {
  const option = field?.options?.find((o) => o.label === label);
  if (!option) throw new Error(`no option "${label}" on ${field?.apiName}`);
  return option.id;
}

/** Create an enabled agent record; `scopes` are passed as labels. */
async function createAgent(name: string, scopes: string[] = ['write']): Promise<{ id: string }> {
  const fields = await fieldsOf(agentsDbId);
  const scopeField = fields.get('scopes');
  const res = await as('POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: { name, enabled: true, scopes: scopes.map((s) => optionId(scopeField, s)) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** A test runtime standing in for a real model: proposes a `set_values`
 * ProposedAction that moves the run's input record's Stage forward one step.
 * Ungated (set_values isn't in APPROVAL_POLICY_KINDS), so dispatchRun applies
 * it inline through the exact same AutomationActionsService buttons/rules use. */
function pipelineAdvanceRuntime(toStageOptionId: string): AgentRuntime {
  return {
    runClass: 'non_ai',
    async *execute(ctx) {
      yield {
        tool: 'pipeline.advance',
        summary: 'Advancing the content record to its next stage',
        action: {
          kind: 'set_values',
          summary: `Set Stage → Published`,
          payload: {
            apply: 'automation_action',
            database_id: contentDbId,
            record_id: ctx.inputRecordId!,
            action: { type: 'set_values', values: { stage: toStageOptionId } },
          },
        },
      };
    },
  };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'RunAgentAuto');
  wsId = (await as('POST', '/workspaces', { name: 'Run Agent WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  const contentDb = (
    await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Content' })
  ).json();
  contentDbId = contentDb.id;

  const stageField = (
    await as('POST', `/workspaces/${wsId}/databases/${contentDbId}/fields`, {
      display_name: 'Stage',
      type: 'select',
      config: {},
      options: [
        { label: 'Draft', color: 'gray' },
        { label: 'Review', color: 'gold' },
        { label: 'Published', color: 'green' },
      ],
    })
  ).json();
  stageFieldId = stageField.id;
  stageOptions = new Map(
    (stageField.options as Array<{ id: string; label: string }>).map((o) => [o.label, o.id]),
  );

  const ensured = await as('POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;
  runsDbId = ensured.json().runsDb.id;
});

afterAll(async () => {
  await app.close();
});

describe('run_agent automation action — end-to-end pipeline demo (MN-109 Phase A)', () => {
  it('a record entering "Review" fires a schedule/record-event rule that runs an agent, which advances it to "Published"', async () => {
    const agent = await createAgent('Pipeline bot');
    const agentsService = app.get(AgentsService);
    const automationsService = app.get(AutomationsService);
    const jobs = app.get(JobRunnerService);
    const originalRuntime = agentsService.runtimeFor;
    agentsService.runtimeFor = () => pipelineAdvanceRuntime(stageOptions.get('Published')!);

    try {
      const ruleRes = await as('POST', `/workspaces/${wsId}/databases/${contentDbId}/automations`, {
        name: 'Advance pipeline via agent',
        trigger: { type: 'record_updated', field_id: stageFieldId },
        actions: [{ type: 'run_agent', agent: agent.id, target: 'trigger_record' }],
      });
      expect(ruleRes.statusCode, ruleRes.body).toBe(201);

      const record = (
        await as('POST', `/workspaces/${wsId}/databases/${contentDbId}/records`, {
          values: { name: 'Q3 launch post', stage: stageOptions.get('Draft') },
        })
      ).json();

      // The transition that fires the rule.
      const updated = await as(
        'PATCH',
        `/workspaces/${wsId}/databases/${contentDbId}/records/${record.id}`,
        { values: { stage: stageOptions.get('Review') } },
      );
      expect(updated.statusCode, updated.body).toBe(200);

      // Let the rule's own inline actions finish — this is where the
      // run_agent action gets QUEUED (MN-253), not executed yet.
      await automationsService.settle(record.id);

      // Drive the durable queue's worker pass directly (its 5s timer is
      // disabled in tests), exactly like automation-jobs.test.ts does.
      await jobs.tick();

      const finalRecord = (
        await as('GET', `/workspaces/${wsId}/databases/${contentDbId}/records/${record.id}`)
      ).json();
      // The whole point of the demo: the agent moved the record forward a
      // pipeline stage, with nobody clicking anything.
      expect(finalRecord.values.stage).toBe(stageOptions.get('Published'));

      // And it left a real, inspectable Run behind it.
      const runs = (await as('GET', `/workspaces/${wsId}/databases/${runsDbId}/records`)).json();
      const runFields = await fieldsOf(runsDbId);
      const run = runs.data.find((r: { title: string }) => r.title === 'Pipeline bot — Automation');
      expect(run, 'expected a Run titled "Pipeline bot — Automation"').toBeTruthy();
      expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
      expect(run.values.trigger).toBe(optionId(runFields.get('trigger'), 'Automation'));
      expect(run.values.input_record).toBe(record.id);
      const links = run.values.agent as Array<{ id: string }>;
      expect(links.map((l) => l.id)).toEqual([agent.id]);
    } finally {
      agentsService.runtimeFor = originalRuntime;
    }
  });
});

describe('run_agent guardrails (MN-109 Phase A)', () => {
  it('dry_run: proposes the pipeline advance but never applies it', async () => {
    const agent = await createAgent('Dry-run bot');
    const agentsService = app.get(AgentsService);
    const originalRuntime = agentsService.runtimeFor;
    agentsService.runtimeFor = () => pipelineAdvanceRuntime(stageOptions.get('Published')!);

    try {
      const record = (
        await as('POST', `/workspaces/${wsId}/databases/${contentDbId}/records`, {
          values: { name: 'Dry-run candidate', stage: stageOptions.get('Review') },
        })
      ).json();

      const run = await agentsService.runFromAutomation({
        workspaceId: wsId,
        agentRef: agent.id,
        inputRecordId: record.id,
        dryRun: true,
      });

      const runFields = await fieldsOf(runsDbId);
      expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));

      const unchanged = (
        await as('GET', `/workspaces/${wsId}/databases/${contentDbId}/records/${record.id}`)
      ).json();
      // Nothing applied — still sitting in Review.
      expect(unchanged.values.stage).toBe(stageOptions.get('Review'));
    } finally {
      agentsService.runtimeFor = originalRuntime;
    }
  });

  it('max_steps: a runtime that keeps yielding steps is stopped and the run is marked Failed', async () => {
    const agent = await createAgent('Runaway bot');
    const agentsService = app.get(AgentsService);
    const originalRuntime = agentsService.runtimeFor;
    agentsService.runtimeFor = () => ({
      runClass: 'non_ai',
      async *execute() {
        for (let i = 0; i < 10; i++) {
          yield { tool: 'loop.step', summary: `step ${i}` };
        }
      },
    });

    try {
      const run = await agentsService.runFromAutomation({
        workspaceId: wsId,
        agentRef: agent.id,
        maxSteps: 3,
      });
      const runFields = await fieldsOf(runsDbId);
      expect(run.values.status).toBe(optionId(runFields.get('status'), 'Failed'));
    } finally {
      agentsService.runtimeFor = originalRuntime;
    }
  });

  it('tool_scope: narrows the agent\'s own declared scopes for this run only, never widens', async () => {
    const agent = await createAgent('Scoped bot', ['read', 'write', 'admin']);
    const agentsService = app.get(AgentsService);
    const originalRuntime = agentsService.runtimeFor;
    let observedScope: string | undefined;
    agentsService.runtimeFor = () => ({
      runClass: 'non_ai',
      async *execute(ctx) {
        observedScope = ctx.principal.scope;
        yield { tool: 'scope.observe', summary: `acting as ${ctx.principal.scope}` };
      },
    });

    try {
      await agentsService.runFromAutomation({
        workspaceId: wsId,
        agentRef: agent.id,
        toolScope: ['read'],
      });
      // The owner (an admin) and the agent (admin-scoped) would both allow
      // 'admin' — the run_agent action's tool_scope caps it down to 'read'.
      expect(observedScope).toBe('read');
    } finally {
      agentsService.runtimeFor = originalRuntime;
    }
  });

  it('an allowedActionKinds guardrail stages an out-of-allowlist action for approval instead of applying it', async () => {
    const agent = await createAgent('Allowlisted bot');
    const agentsService = app.get(AgentsService);
    const originalRuntime = agentsService.runtimeFor;
    agentsService.runtimeFor = () => pipelineAdvanceRuntime(stageOptions.get('Published')!);

    try {
      const record = (
        await as('POST', `/workspaces/${wsId}/databases/${contentDbId}/records`, {
          values: { name: 'Allowlist candidate', stage: stageOptions.get('Review') },
        })
      ).json();

      // dispatchRun's guardrails aren't exposed on runFromAutomation's public
      // input shape yet for allowedActionKinds directly — exercise it through
      // dispatchRun the same way the job executor eventually would, via a
      // deliberately empty allowlist (no kind is ever allowed through).
      const { agentsDb, runsDb } = await agentsService.findPackDbs(wsId);
      const agentRecord = await app.get(RecordsService).get(agentsDb!.id, agent.id);
      const owner = await agentsService.resolveAgentOwner(wsId, agentRecord);
      const run = await agentsService.dispatchRun({
        workspaceId: wsId,
        agentsDb: agentsDb!,
        runsDb: runsDb!,
        agentRecord,
        trigger: 'Automation',
        inputRecordId: record.id,
        owner: owner!,
        guardrails: { allowedActionKinds: [] },
      });

      const runFields = await fieldsOf(runsDbId);
      expect(run.values.status).toBe(optionId(runFields.get('status'), 'Waiting approval'));

      const unchanged = (
        await as('GET', `/workspaces/${wsId}/databases/${contentDbId}/records/${record.id}`)
      ).json();
      expect(unchanged.values.stage).toBe(stageOptions.get('Review'));
    } finally {
      agentsService.runtimeFor = originalRuntime;
    }
  });
});
