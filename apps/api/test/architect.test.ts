import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';
import type { ArchitectPlan } from '@storyos/schemas';

/**
 * The Architect (#213 propose / #214 build, ADR-0010 §6).
 *
 * Each describe gets its own workspace: create-vs-reuse is a fact about a
 * workspace's live schema, so tests that share one would silently decide each
 * other's answers.
 */

let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let admin: { token: string; email: string };
let member: { token: string; email: string };

const LEAD_GOAL =
  'When a lead arrives I want it to draft a reply and open a follow-up task, ' +
  'but nothing gets sent without me approving it';

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
  displayName: string;
  apiName: string;
  type: string;
  options?: Array<{ id: string; label: string }>;
}

async function fieldsOf(wsId: string, dbId: string): Promise<FieldDetail[]> {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().fields as FieldDetail[];
}

function fieldNamed(fields: FieldDetail[], name: string): FieldDetail {
  const field = fields.find((f) => f.displayName === name);
  if (!field) throw new Error(`no field "${name}" — have: ${fields.map((f) => f.displayName)}`);
  return field;
}

function optionId(field: FieldDetail, label: string): string {
  const option = field.options?.find((o) => o.label === label);
  if (!option) throw new Error(`no option "${label}" on ${field.displayName}`);
  return option.id;
}

async function listDatabases(wsId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

async function newWorkspace(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/workspaces', { name });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

async function propose(wsId: string, goal = LEAD_GOAL): Promise<ArchitectPlan> {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/architect/propose`, { goal });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as ArchitectPlan;
}

async function build(wsId: string, plan: unknown) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/architect/build`, { plan });
}

async function buildOk(wsId: string, plan: unknown) {
  const res = await build(wsId, plan);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** Flatten a BlockNote document to plain text — `Goal`/`Steps` are rich_text. */
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

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'ArchitectAdmin');
  member = await signUpUser(app, 'ArchitectMember');
});

afterAll(async () => {
  await app.close();
});

// ── #213: propose ─────────────────────────────────────────────────────────────

describe('propose: a plain-language goal becomes a concrete, reviewable plan (#213)', () => {
  let wsId: string;
  beforeAll(async () => {
    wsId = await newWorkspace('Architect Propose WS');
  });

  it('names the entities, states, agents and gates — not vague advice', async () => {
    const plan = await propose(wsId);

    expect(plan.scenario).toBe('lead-intake');
    expect(plan.summary).toContain('approval');

    // Entities.
    expect(plan.databases.map((d) => d.name).sort()).toEqual(['Leads', 'Tasks']);
    const leads = plan.databases.find((d) => d.name === 'Leads')!;
    expect(leads.fields.map((f) => f.name)).toContain('Draft reply');
    expect(leads.space).toBe('Sales');

    // Relations — the follow-up task is attached to its lead, not floating.
    expect(plan.relations).toContainEqual(
      expect.objectContaining({ from: 'Tasks', to: 'Leads', cardinality: 'one_to_many' }),
    );

    // States, with the checkpoint spelled out.
    const state = plan.states.find((s) => s.database === 'Leads')!;
    expect(state.field).toBe('Status');
    expect(state.options.map((o) => o.label)).toEqual(
      expect.arrayContaining(['New', 'Awaiting approval', 'Sent']),
    );

    // Agents, with a declared scope ceiling.
    expect(plan.agents).toHaveLength(1);
    const agent = plan.agents[0]!;
    expect(agent.name).toBe('Lead Intake Assistant');
    expect(agent.scopes).toEqual(['read', 'write']);
    // The agent asks a human about sending — this IS the gate, as data.
    expect(agent.approval_policy).toContain('email');

    // Trigger bindings, including the human-gate state.
    expect(plan.triggers).toContainEqual(
      expect.objectContaining({ database: 'Leads', state_option: 'New', human_gate: false }),
    );
    expect(plan.triggers).toContainEqual(
      expect.objectContaining({ state_option: 'Awaiting approval', human_gate: true }),
    );
  });

  it('refuses a goal it has no template for, rather than improvising', async () => {
    // The honest limit of NonAiProposer: it template-matches, it does not read.
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/architect/propose`, {
      goal: 'reconcile the general ledger against the bank statement every night',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('lead-intake');
  });
});

describe('propose BUILDS NOTHING (#213 — the whole reason this is its own ticket)', () => {
  let wsId: string;
  beforeAll(async () => {
    wsId = await newWorkspace('Architect Propose-Only WS');
  });

  it('creates no databases, no spaces, no records — not even the Agents pack', async () => {
    const dbsBefore = await listDatabases(wsId);
    const spacesBefore = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json();

    // Propose repeatedly: if anything here were find-or-CREATE, three passes
    // would show it.
    const plan = await propose(wsId);
    await propose(wsId);
    await propose(wsId);

    // The plan is real and full — this is not "nothing happened because nothing
    // was planned".
    expect(plan.databases.length).toBeGreaterThan(0);
    expect(plan.agents.length).toBeGreaterThan(0);
    expect(plan.triggers.length).toBeGreaterThan(0);

    const dbsAfter = await listDatabases(wsId);
    expect(dbsAfter).toHaveLength(dbsBefore.length);
    expect(dbsAfter.map((d) => d.name).sort()).toEqual(dbsBefore.map((d) => d.name).sort());

    const spacesAfter = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json();
    expect(spacesAfter).toHaveLength(spacesBefore.length);

    // Specifically: propose must never call ensurePack. Provisioning the Agentic
    // OS space + three databases behind a "preview" is exactly the thing #213
    // says must not happen.
    const pack = (await as(admin.token, 'GET', `/workspaces/${wsId}/agents`)).json();
    expect(pack.exists).toBe(false);
    expect(dbsAfter.find((d) => d.name === 'Agents')).toBeUndefined();
    expect(dbsAfter.find((d) => d.name === 'Leads')).toBeUndefined();
  });
});

// ── #214: create-vs-reuse ─────────────────────────────────────────────────────

describe('reuse-existing, not duplicate (#213 AC + #214 AC)', () => {
  let wsId: string;
  let existingLeadsId: string;

  beforeAll(async () => {
    wsId = await newWorkspace('Architect Reuse WS');
    const space = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Existing' })
    ).json();
    const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space.id,
      name: 'Leads',
    });
    expect(created.statusCode, created.body).toBe(201);
    existingLeadsId = created.json().id;
  });

  it('marks a database that already exists as `reuse` and a new one as `create`', async () => {
    const plan = await propose(wsId);
    expect(plan.databases.find((d) => d.name === 'Leads')!.action).toBe('reuse');
    expect(plan.databases.find((d) => d.name === 'Tasks')!.action).toBe('create');
  });

  it('build reuses the existing database — the same id, and no second one', async () => {
    const plan = await propose(wsId);
    const result = await buildOk(wsId, plan);

    const leads = result.databases.find((d: { name: string }) => d.name === 'Leads');
    expect(leads.action).toBe('reused');
    // THE POINT: the very database that was already there, not a namesake.
    expect(leads.id).toBe(existingLeadsId);
    expect(result.databases.find((d: { name: string }) => d.name === 'Tasks').action).toBe(
      'created',
    );

    const all = await listDatabases(wsId);
    expect(all.filter((d) => d.name === 'Leads')).toHaveLength(1);

    // The reused database got the plan's fields and states added to it — reuse
    // means "extend what's there", not "ignore it".
    const leadFields = await fieldsOf(wsId, existingLeadsId);
    expect(fieldNamed(leadFields, 'Draft reply').type).toBe('rich_text');
    expect(fieldNamed(leadFields, 'Status').type).toBe('select');
  });

  it('re-building the same plan is idempotent — everything reused, nothing doubled', async () => {
    const plan = await propose(wsId);
    // Now that the first build ran, propose sees both databases as existing.
    expect(plan.databases.every((d) => d.action === 'reuse')).toBe(true);

    const result = await buildOk(wsId, plan);
    for (const entity of [...result.databases, ...result.agents, ...result.triggers]) {
      expect(entity.action, `${entity.name} should have been reused`).toBe('reused');
    }

    const all = await listDatabases(wsId);
    expect(all.filter((d) => d.name === 'Leads')).toHaveLength(1);
    expect(all.filter((d) => d.name === 'Tasks')).toHaveLength(1);

    // And exactly one agent record and two bindings, not two and four.
    const pack = (await as(admin.token, 'GET', `/workspaces/${wsId}/agents`)).json();
    const agentRecords = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${pack.id}/records`)
    ).json();
    expect(
      agentRecords.data.filter((r: { title: string }) => r.title === 'Lead Intake Assistant'),
    ).toHaveLength(1);
    const bindings = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${pack.triggers.id}/records`)
    ).json();
    expect(bindings.data).toHaveLength(2);
  });
});

// ── #214: the lead-intake scenario, end to end ────────────────────────────────

describe('lead-intake, built and then DRIVEN end to end (#214, ADR-0010 §6)', () => {
  let wsId: string;
  let leadsDbId: string;
  let tasksDbId: string;
  let runsDbId: string;
  let agentRecordId: string;
  let statusField: FieldDetail;

  beforeAll(async () => {
    wsId = await newWorkspace('Architect Lead Intake WS');
    const plan = await propose(wsId);
    const result = await buildOk(wsId, plan);

    leadsDbId = result.databases.find((d: { name: string }) => d.name === 'Leads').id;
    tasksDbId = result.databases.find((d: { name: string }) => d.name === 'Tasks').id;
    agentRecordId = result.agents[0].id;

    const pack = (await as(admin.token, 'GET', `/workspaces/${wsId}/agents`)).json();
    runsDbId = pack.runs.id;
    statusField = fieldNamed(await fieldsOf(wsId, leadsDbId), 'Status');
  });

  it('built the whole thing as ordinary, hand-editable workspace config', async () => {
    // Databases + fields.
    const leadFields = await fieldsOf(wsId, leadsDbId);
    expect(fieldNamed(leadFields, 'Email').type).toBe('email');
    expect(fieldNamed(leadFields, 'Draft reply').type).toBe('rich_text');
    // States: a select, because only a select transition is dispatchable.
    expect(statusField.type).toBe('select');
    expect(statusField.options!.map((o) => o.label)).toEqual([
      'New',
      'Drafting reply',
      'Awaiting approval',
      'Sent',
      'Closed',
    ]);
    // The relation is wired both ways.
    const taskFields = await fieldsOf(wsId, tasksDbId);
    expect(fieldNamed(taskFields, 'Lead').type).toBe('relation');
    expect(fieldNamed(leadFields, 'Tasks').type).toBe('relation');

    // The agent is a RECORD — readable, and editable — in the Agents database.
    const pack = (await as(admin.token, 'GET', `/workspaces/${wsId}/agents`)).json();
    const agent = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${pack.id}/records/${agentRecordId}`)
    ).json();
    expect(agent.title).toBe('Lead Intake Assistant');
    expect(agent.values.enabled).toBe(true);
    expect(plainText(agent.values.goal)).toContain('follow-up task');

    // Hand-editable is a claim worth testing, not asserting: rename it through
    // the ordinary records API and it takes.
    const edited = await as(
      admin.token,
      'PATCH',
      `/workspaces/${wsId}/databases/${pack.id}/records/${agentRecordId}`,
      { values: { name: 'Lead Intake Assistant' } },
    );
    expect(edited.statusCode, edited.body).toBe(200);

    // The bindings exist and are armed, including the human-gate checkpoint.
    const bindings = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${pack.triggers.id}/records`)
    ).json().data as Array<{ values: Record<string, unknown> }>;
    expect(bindings).toHaveLength(2);
    const newBinding = bindings.find(
      (b) => b.values['state_option'] === optionId(statusField, 'New'),
    )!;
    expect(newBinding.values['database']).toBe(leadsDbId);
    expect(newBinding.values['state_field']).toBe(statusField.id);
    expect(newBinding.values['enabled']).toBe(true);
    expect(newBinding.values['human_gate']).toBe(false);

    const gateBinding = bindings.find(
      (b) => b.values['state_option'] === optionId(statusField, 'Awaiting approval'),
    )!;
    expect(gateBinding.values['human_gate']).toBe(true);
  });

  /**
   * The runtime that stands in for the drafting model.
   *
   * Being straight about what is real here: no LLM exists yet (ADR-0010 §3 —
   * `ManagedAiRuntime` throws), so the *drafting* is stubbed, exactly as it is in
   * agent-approvals.test.ts. Everything the stub touches is real: the binding
   * fired it, dispatch stamped the run class, the approval policy the Architect
   * wrote onto the agent record is what catches the send, and the staging/park
   * behaviour is #210's. The trailing step is the halt probe — if the gate merely
   * *noted* the send and let the run continue, it would appear in the log.
   */
  function sendingRuntime(leadId: string): AgentRuntime {
    const send: ProposedAction = {
      kind: 'email',
      summary: 'send the drafted reply to the lead',
      payload: {
        apply: 'automation_action',
        database_id: leadsDbId,
        record_id: leadId,
        action: { type: 'notify_user', user: '@me', message: 'reply sent' },
      },
    };
    return {
      runClass: 'non_ai',
      async *execute() {
        yield { tool: 'lead.read', summary: 'read the incoming lead' };
        yield { tool: 'reply.draft', summary: 'drafted a reply into "Draft reply"' };
        yield { tool: 'task.open', summary: 'opened a follow-up task' };
        yield { tool: 'reply.send', summary: send.summary, action: send };
        yield { tool: 'lead.close', summary: 'marked the lead Sent' };
      },
    };
  }

  async function createLead(name: string, state?: string) {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsDbId}/records`, {
      values: { name, ...(state ? { [statusField.apiName]: optionId(statusField, state) } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }

  async function runsForAgent() {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records`);
    return (res.json().data as Array<{ id: string; values: Record<string, unknown> }>).filter((r) =>
      ((r.values.agent as Array<{ id: string }> | undefined) ?? []).some(
        (l) => l.id === agentRecordId,
      ),
    );
  }

  it('a lead arriving in New dispatches a run, and the send PARKS at the gate', async () => {
    const service = app.get(AgentsService);
    const original = service.runtimeFor;

    // The lead is created stateless first, so its id can be baked into the stub
    // before the transition that actually fires the binding.
    const lead = await createLead('Globex — demo request');
    service.runtimeFor = () => sendingRuntime(lead.id);
    try {
      const leadId = lead.id as string;
      const before = (await runsForAgent()).length;

      // ── The transition: the lead enters New ─────────────────────────────────
      const moved = await as(
        admin.token,
        'PATCH',
        `/workspaces/${wsId}/databases/${leadsDbId}/records/${leadId}`,
        { values: { [statusField.apiName]: optionId(statusField, 'New') } },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      await subscriber.settle(leadId);

      // ── It dispatched ───────────────────────────────────────────────────────
      const runs = await runsForAgent();
      expect(runs.length, 'the binding dispatched a run').toBe(before + 1);
      const run = runs.find((r) => r.values.input_record === leadId)!;
      expect(run, 'the run carries the lead as its input record').toBeTruthy();

      const runFields = await fieldsOf(wsId, runsDbId);
      const status = fieldNamed(runFields, 'Status');
      const trigger = fieldNamed(runFields, 'Trigger');
      expect(run.values.trigger).toBe(optionId(trigger, 'State change'));

      // ── It PARKED at the gate, it did not send ──────────────────────────────
      expect(run.values.status, 'the send parks at Waiting approval').toBe(
        optionId(status, 'Waiting approval'),
      );
      // Blocked, not finished.
      expect(run.values.finished_at).toBeFalsy();

      const staged = JSON.parse(run.values.pending_action as string);
      expect(staged.action.kind).toBe('email');
      expect(staged.action.summary).toBe('send the drafted reply to the lead');

      // The work before the gate happened; the step after it never ran.
      const steps = plainText(run.values.steps);
      expect(steps).toContain('drafted a reply');
      expect(steps).toContain('opened a follow-up task');
      expect(steps).not.toContain('marked the lead Sent');
      expect(steps).not.toContain('action.applied');

      // And the owner was asked, with the proposal in the message.
      const inbox = (
        await as(admin.token, 'GET', `/workspaces/${wsId}/notifications?type=approval_requested`)
      ).json();
      const item = inbox.data.find((n: { record: { id: string } | null }) => n.record?.id === run.id);
      expect(item, 'an approval request in the Inbox').toBeTruthy();
      expect(item.snippet).toContain('send the drafted reply to the lead');
    } finally {
      service.runtimeFor = original;
    }
  });

  it('the human-gate state never auto-fires the agent out of it (ADR-0010 §5)', async () => {
    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    service.runtimeFor = () => sendingRuntime('unused');
    try {
      const lead = await createLead('Initech — waiting on a human');
      const before = (await runsForAgent()).length;

      const moved = await as(
        admin.token,
        'PATCH',
        `/workspaces/${wsId}/databases/${leadsDbId}/records/${lead.id}`,
        { values: { [statusField.apiName]: optionId(statusField, 'Awaiting approval') } },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      await subscriber.settle(lead.id);

      // The Architect bound the agent to this state *with* human_gate — so the
      // checkpoint holds and nothing ran.
      expect(await runsForAgent()).toHaveLength(before);
    } finally {
      service.runtimeFor = original;
    }
  });
});

// ── guards and bad input ──────────────────────────────────────────────────────

describe('access and bad plans', () => {
  let wsId: string;
  beforeAll(async () => {
    wsId = await newWorkspace('Architect Guards WS');
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: member.email,
      role: 'member',
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member.token, 'POST', '/invites/accept', { token });
  });

  it('a non-admin cannot propose or build — building a workflow is schema work', async () => {
    const proposed = await as(member.token, 'POST', `/workspaces/${wsId}/architect/propose`, {
      goal: LEAD_GOAL,
    });
    expect(proposed.statusCode).toBe(403);

    const built = await as(member.token, 'POST', `/workspaces/${wsId}/architect/build`, {
      plan: { summary: 'x', scenario: 'lead-intake' },
    });
    expect(built.statusCode).toBe(403);
  });

  it('a malformed plan is 422 with the offending path, not a 500', async () => {
    for (const plan of [
      undefined,
      'not a plan',
      42,
      {},
      { summary: 'missing the rest' },
      // Structurally a plan, but a database entry with a bogus action.
      { summary: 's', scenario: 'x', databases: [{ action: 'destroy', name: 'X', space: 'Y' }] },
      // A field type that doesn't exist.
      {
        summary: 's',
        scenario: 'x',
        databases: [{ action: 'create', name: 'X', space: 'Y', fields: [{ name: 'f', type: 'psychic' }] }],
      },
    ]) {
      const res = await build(wsId, plan);
      expect(res.statusCode, `plan: ${JSON.stringify(plan)} → ${res.body}`).toBe(422);
      expect(res.json().error.message, JSON.stringify(res.json())).toContain('not a valid Architect plan');
    }
  });

  it('a plan that reuses a database which has vanished is 422, not a crash', async () => {
    const plan = await propose(wsId);
    // Simulate the database disappearing between propose and build: the plan
    // says "reuse Leads", but there is no Leads here.
    const stale: ArchitectPlan = {
      ...plan,
      databases: plan.databases.map((d) =>
        d.name === 'Leads' ? { ...d, action: 'reuse' as const } : d,
      ),
    };
    const res = await build(wsId, stale);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toContain('no such database exists');

    // And it refused before doing anything: no half-built Tasks database.
    const all = await listDatabases(wsId);
    expect(all.find((d) => d.name === 'Tasks')).toBeUndefined();
  });

  it('a plan whose trigger names an undeclared agent is 422', async () => {
    const plan = await propose(wsId);
    const res = await build(wsId, {
      ...plan,
      agents: [],
      triggers: plan.triggers,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toContain('does not declare');
  });
});
