import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';

let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let admin: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let runsDbId: string;
let triggersDbId: string;

// The target database the agents watch — a Tickets db with a State select.
let ticketsDbId: string;
let stateFieldId: string;
let stateApi: string;
let todoId: string;
let reviewId: string;
let doneId: string;
let notesFieldId: string;
let notesApi: string;

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

async function fieldsOf(dbId: string): Promise<Map<string, FieldDetail>> {
  const detail = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
  return new Map(detail.fields.map((f: FieldDetail) => [f.apiName, f]));
}

function optionId(field: FieldDetail | undefined, label: string): string {
  const option = field?.options?.find((o) => o.label === label);
  if (!option) throw new Error(`no option "${label}" on ${field?.apiName}`);
  return option.id;
}

/** Flatten a BlockNote document to plain text — `Steps` is rich_text. */
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

async function createAgent(name: string, opts: { enabled: boolean; scopes?: string[] }) {
  const scopeField = (await fieldsOf(agentsDbId)).get('scopes');
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: {
      name,
      enabled: opts.enabled,
      scopes: (opts.scopes ?? ['read']).map((s) => optionId(scopeField, s)),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function createBinding(body: Record<string, unknown>) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/agents/triggers`, body);
}

async function createTicket(name: string, state?: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ticketsDbId}/records`, {
    values: { name, ...(state ? { [stateApi]: state } : {}) },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/**
 * Dispatch is fire-and-forget off the event bus — await the record's chain
 * before asserting (the automations tests do the same via engine.settle).
 */
async function settle(recordId: string) {
  await subscriber.settle(recordId);
}

/** Runs whose Agent link points at `agentId`. */
async function runsFor(agentId: string) {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records`);
  return (res.json().data as Array<{ values: Record<string, unknown> }>).filter((r) =>
    ((r.values.agent as Array<{ id: string }> | undefined) ?? []).some((l) => l.id === agentId),
  );
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'TriggerAdmin');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Triggers WS' })).json().id;

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;
  runsDbId = ensured.json().runsDb.id;
  triggersDbId = ensured.json().triggersDb.id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  ticketsDbId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Tickets',
    })
  ).json().id;

  const state = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ticketsDbId}/fields`, {
      display_name: 'State',
      type: 'select',
      config: {},
      options: [{ label: 'Todo' }, { label: 'Review' }, { label: 'Done' }],
    })
  ).json();
  stateFieldId = state.id;
  stateApi = state.apiName;
  todoId = state.options.find((o: { label: string }) => o.label === 'Todo').id;
  reviewId = state.options.find((o: { label: string }) => o.label === 'Review').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;

  const notes = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ticketsDbId}/fields`, {
      display_name: 'Notes',
      type: 'text',
      config: {},
    })
  ).json();
  notesFieldId = notes.id;
  notesApi = notes.apiName;
});

afterAll(async () => {
  await app.close();
});

/** Disarm every binding — each test arms exactly the ones it is about. */
async function disarmAll() {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${triggersDbId}/records`);
  for (const b of res.json().data as Array<{ id: string }>) {
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${triggersDbId}/records/${b.id}`, {
      values: { enabled: false },
    });
  }
}

beforeEach(async () => {
  await disarmAll();
});

describe('Agent Triggers system database (#211, ADR-0010 §5)', () => {
  it('ensure creates the Agent Triggers database with its binding fields', async () => {
    expect(triggersDbId).toBeTruthy();

    const fields = await fieldsOf(triggersDbId);
    for (const [name, type] of [
      ['database', 'text'],
      ['state_field', 'text'],
      ['state_option', 'text'],
      ['human_gate', 'checkbox'],
      ['enabled', 'checkbox'],
    ] as const) {
      expect(fields.get(name), `missing field ${name}`).toBeTruthy();
      expect(fields.get(name)!.type, `field ${name} type`).toBe(type);
    }

    // It lives in the one "Agentic OS" space, with the rest of the pack.
    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
    const triggers = dbs.find((d: { id: string }) => d.id === triggersDbId);
    const agents = dbs.find((d: { id: string }) => d.id === agentsDbId);
    expect(triggers.space_id ?? triggers.spaceId).toBe(agents.space_id ?? agents.spaceId);
  });

  it('ensure creates the Agents↔Triggers relation — one agent, many bindings', async () => {
    const triggerFields = await fieldsOf(triggersDbId);
    const agentField = triggerFields.get('agent');
    expect(agentField, 'Agent Triggers.Agent relation field').toBeTruthy();
    expect(agentField!.type).toBe('relation');

    const agentFields = await fieldsOf(agentsDbId);
    const triggersField = agentFields.get('triggers');
    expect(triggersField, 'Agents.Triggers relation field').toBeTruthy();
    expect(triggersField!.type).toBe('relation');

    const relationId = agentField!.config!.relation_id;
    expect(relationId).toBeTruthy();
    expect(triggersField!.config!.relation_id).toBe(relationId);

    const rel = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations/${relationId}`)).json();
    expect(rel.cardinality).toBe('one_to_many');
    // Side A is the "many" side that carries the single reference.
    expect(rel.database_a_id).toBe(triggersDbId);
    expect(rel.database_b_id).toBe(agentsDbId);
    expect(rel.field_a.display_name).toBe('Agent');
    expect(rel.field_b.display_name).toBe('Triggers');
  });

  it('re-ensure is idempotent — no duplicate database, fields or relation', async () => {
    const again = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(again.statusCode, again.body).toBe(201);
    expect(again.json().created).toBe(false);
    expect(again.json().triggersDb.id).toBe(triggersDbId);

    const dbs = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases`)).json();
    expect(dbs.filter((d: { name: string }) => d.name === 'Agent Triggers')).toHaveLength(1);

    // Exactly one relation field per side — no second Agents↔Triggers relation.
    const triggerRelations = [...(await fieldsOf(triggersDbId)).values()].filter(
      (f) => f.type === 'relation',
    );
    expect(triggerRelations).toHaveLength(1);
    // Agents now carries exactly two: Runs (#209) and Triggers (#211).
    const agentRelations = [...(await fieldsOf(agentsDbId)).values()].filter(
      (f) => f.type === 'relation',
    );
    expect(agentRelations.map((f) => f.apiName).sort()).toEqual(['runs', 'triggers']);
  });

  it('GET reports the triggers database alongside Agents and Runs', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/agents`);
    expect(res.statusCode).toBe(200);
    expect(res.json().triggers).toEqual({ id: triggersDbId, name: 'Agent Triggers' });
  });
});

describe('Binding validation (#211)', () => {
  it('creates a valid binding, enabled and un-gated by default', async () => {
    const agent = await createAgent('Reviewer bot', { enabled: true });
    const res = await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });
    expect(res.statusCode, res.body).toBe(201);
    const binding = res.json();
    expect(binding.values.database).toBe(ticketsDbId);
    expect(binding.values.state_field).toBe(stateFieldId);
    expect(binding.values.state_option).toBe(reviewId);
    expect(binding.values.enabled).toBe(true);
    expect(binding.values.human_gate ?? false).toBe(false);
    // A readable title, so the binding is legible in an ordinary table view.
    expect(binding.title).toBe('Reviewer bot ← Tickets.State = Review');

    // Linked to the agent it fires (relation chips are attached on read).
    const stored = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${triggersDbId}/records/${binding.id}`)
    ).json();
    const links = stored.values.agent as Array<{ id: string }>;
    expect(links.map((l) => l.id)).toEqual([agent.id]);
  });

  it('422s when the state field is not a select', async () => {
    const agent = await createAgent('Wrong field bot', { enabled: true });
    const res = await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      // Notes is a text field — a state must be a discrete, observable option.
      state_field_id: notesFieldId,
      state_option_id: reviewId,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/must be a select field/i);
  });

  it('422s when the option does not belong to the state field', async () => {
    const agent = await createAgent('Wrong option bot', { enabled: true });
    // A real option — but on a select field of a different database.
    const otherDbId = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
        space_id: (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
        name: 'Other',
      })
    ).json().id;
    const otherState = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${otherDbId}/fields`, {
        display_name: 'Stage',
        type: 'select',
        config: {},
        options: [{ label: 'Elsewhere' }],
      })
    ).json();

    const res = await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: otherState.options[0].id,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/does not belong/i);
  });

  it('422s when the state field is not on the target database', async () => {
    const agent = await createAgent('Cross-db bot', { enabled: true });
    const otherDbId = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
        space_id: (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
        name: 'Unrelated',
      })
    ).json().id;

    const res = await createBinding({
      agent: agent.id,
      database_id: otherDbId,
      state_field_id: stateFieldId, // lives on Tickets, not on Unrelated
      state_option_id: reviewId,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/does not exist on/i);
  });

  it('validateBinding accepts the real thing — the service method is the gate', async () => {
    const agents = app.get(AgentsService);
    await expect(
      agents.validateBinding(wsId, {
        database_id: ticketsDbId,
        state_field_id: stateFieldId,
        state_option_id: doneId,
      }),
    ).resolves.toMatchObject({ option: { label: 'Done' } });
  });

  it('404s for an unknown agent', async () => {
    const res = await createBinding({
      agent: '00000000-0000-4000-8000-000000000000',
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('The core loop — state transition dispatch (#212, ADR-0010 §5)', () => {
  it('a record moving into the bound state runs the agent', async () => {
    const agent = await createAgent('Triage bot', { enabled: true, scopes: ['write'] });
    expect((await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    })).statusCode).toBe(201);

    const ticket = await createTicket('Broken login', todoId);
    await settle(ticket.id);
    expect(await runsFor(agent.id), 'created in Todo — not the bound state').toHaveLength(0);

    // The transition: Todo → Review.
    const moved = await as(
      admin.token,
      'PATCH',
      `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`,
      { values: { [stateApi]: reviewId } },
    );
    expect(moved.statusCode, moved.body).toBe(200);
    await settle(ticket.id);

    const runs = await runsFor(agent.id);
    expect(runs, 'the transition dispatched exactly one run').toHaveLength(1);
    const run = runs[0]!;

    const runFields = await fieldsOf(runsDbId);
    expect(run.values.trigger).toBe(optionId(runFields.get('trigger'), 'State change'));
    expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
    // The run class is stamped at dispatch on this path too (ADR-0010 §3).
    expect(run.values.run_class).toBe(optionId(runFields.get('run_class'), 'Non-AI'));
    // The record that triggered it is the run's context.
    expect(run.values.input_record).toBe(ticket.id);
    expect(plainText(run.values.steps)).toContain('principal.resolve');
  });

  it('fires on create-into-the-state too', async () => {
    const agent = await createAgent('Intake bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const ticket = await createTicket('Born in review', reviewId);
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(1);
  });

  it('a write that does not touch the state field fires nothing — a re-save is not a transition', async () => {
    const agent = await createAgent('Quiet bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    // The cooldown is OFF for this test on purpose: it would mask the thing
    // under test by blocking the second fire for its own reasons. Exactly-once
    // per transition has to hold on the transition check alone.
    const original = subscriber.cooldownMs;
    subscriber.cooldownMs = 0;
    try {
      const ticket = await createTicket('Already reviewing', reviewId);
      await settle(ticket.id);
      expect(await runsFor(agent.id), 'the create-into-state fired once').toHaveLength(1);

      // The record STAYS in Review — but this write changed Notes, not the state.
      // Re-saving a record already sitting in the state is not a transition.
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
        values: { [notesApi]: 'just a comment' },
      });
      await settle(ticket.id);
      expect(await runsFor(agent.id), 'a non-state write must not re-fire').toHaveLength(1);
    } finally {
      subscriber.cooldownMs = original;
    }
  });

  it('a transition into a DIFFERENT state fires nothing', async () => {
    const agent = await createAgent('Review-only bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const ticket = await createTicket('Shipping', todoId);
    await settle(ticket.id);
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: doneId }, // Done, not Review
    });
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(0);
  });

  it('a binding on another database is not fired by this one', async () => {
    const agent = await createAgent('Other-db bot', { enabled: true });
    const otherDbId = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
        space_id: (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
        name: 'Leads',
      })
    ).json().id;
    const otherState = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${otherDbId}/fields`, {
        display_name: 'Stage',
        type: 'select',
        config: {},
        options: [{ label: 'Review' }],
      })
    ).json();
    await createBinding({
      agent: agent.id,
      database_id: otherDbId,
      state_field_id: otherState.id,
      state_option_id: otherState.options[0].id,
    });

    // A Tickets transition into *its* Review must not fire the Leads binding.
    const ticket = await createTicket('Unrelated', todoId);
    await settle(ticket.id);
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: reviewId },
    });
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(0);
  });

  it('a disabled binding fires nothing', async () => {
    const agent = await createAgent('Disarmed bot', { enabled: true });
    const binding = (
      await createBinding({
        agent: agent.id,
        database_id: ticketsDbId,
        state_field_id: stateFieldId,
        state_option_id: reviewId,
        enabled: false,
      })
    ).json();
    expect(binding.values.enabled).toBe(false);

    const ticket = await createTicket('Ignored', reviewId);
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(0);
  });

  it('a DISABLED AGENT is never auto-run, even through an armed binding', async () => {
    const agent = await createAgent('Sleeping bot', { enabled: false });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const ticket = await createTicket('Wakes nobody', reviewId);
    await settle(ticket.id);
    expect(await runsFor(agent.id), 'a disabled agent is a definition, not a runnable thing')
      .toHaveLength(0);
  });
});

describe('Human gate (#212, ADR-0010 §5)', () => {
  it('a human-gate binding never auto-fires', async () => {
    const agent = await createAgent('Gated bot', { enabled: true });
    const binding = (
      await createBinding({
        agent: agent.id,
        database_id: ticketsDbId,
        state_field_id: stateFieldId,
        state_option_id: reviewId,
        human_gate: true,
      })
    ).json();
    expect(binding.values.human_gate).toBe(true);
    expect(binding.values.enabled).toBe(true); // armed — and still must not fire

    const ticket = await createTicket('Needs a human', todoId);
    await settle(ticket.id);
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: reviewId },
    });
    await settle(ticket.id);

    expect(await runsFor(agent.id), 'a checkpoint is a checkpoint — only a human moves it')
      .toHaveLength(0);
  });

  it('the SAME transition fires an un-gated binding — the gate is what stops it', async () => {
    // The control for the test above: identical setup, human_gate false.
    const agent = await createAgent('Ungated twin', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
      human_gate: false,
    });

    const ticket = await createTicket('No gate here', todoId);
    await settle(ticket.id);
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: reviewId },
    });
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(1);
  });
});

describe('Loop protection (#212, ADR-0010 §5)', () => {
  it('cooldown: the same agent cannot re-fire on the same record inside the window', async () => {
    const agent = await createAgent('Looping bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const ticket = await createTicket('Ping-pong', todoId);
    await settle(ticket.id);

    // Transition in → fires.
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: reviewId },
    });
    await settle(ticket.id);
    expect(await runsFor(agent.id)).toHaveLength(1);

    // Out and immediately back in: a genuine second transition, but the same
    // agent on the same record inside the cooldown must NOT run again.
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: todoId },
    });
    await settle(ticket.id);
    await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
      values: { [stateApi]: reviewId },
    });
    await settle(ticket.id);
    expect(await runsFor(agent.id), 'the cooldown bounds a tight re-trigger loop').toHaveLength(1);
  });

  it('cooldown is per record AND per agent — a different record still fires', async () => {
    const agent = await createAgent('Per-record bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const first = await createTicket('First', reviewId);
    await settle(first.id);
    const second = await createTicket('Second', reviewId);
    await settle(second.id);

    // The cooldown must bound loops, not throttle the agent globally.
    expect(await runsFor(agent.id)).toHaveLength(2);
  });

  it('once the cooldown expires the same record can fire again', async () => {
    const agent = await createAgent('Expiry bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const original = subscriber.cooldownMs;
    subscriber.cooldownMs = 20;
    try {
      const ticket = await createTicket('Slow loop', todoId);
      await settle(ticket.id);
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
        values: { [stateApi]: reviewId },
      });
      await settle(ticket.id);
      expect(await runsFor(agent.id)).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 40)); // outside the window now

      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
        values: { [stateApi]: todoId },
      });
      await settle(ticket.id);
      await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${ticket.id}`, {
        values: { [stateApi]: reviewId },
      });
      await settle(ticket.id);
      expect(await runsFor(agent.id), 'the cooldown bounds loops, it does not disable the binding')
        .toHaveLength(2);
    } finally {
      subscriber.cooldownMs = original;
    }
  });

  it('depth guard: an agent-caused event at max depth does not dispatch', async () => {
    const agent = await createAgent('Deep bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    // Cooldown OFF: it would block the replay for its own reasons and this test
    // would pass without a depth guard at all. Depth has to stop it alone.
    const original = subscriber.cooldownMs;
    subscriber.cooldownMs = 0;
    try {
      const ticket = await createTicket('Deep', reviewId);
      await settle(ticket.id);
      const before = (await runsFor(agent.id)).length;
      expect(before, 'the user-depth transition fired').toBe(1);

      // Replay the same transition as an event carrying agent-caused lineage:
      // depth 2 is the guard's ceiling (mirrors the automations engine).
      subscriber.dispatch({
        type: 'record_updated',
        workspaceId: wsId,
        databaseId: ticketsDbId,
        recordId: ticket.id,
        changedFieldIds: [stateFieldId],
        actorId: null,
        depth: 2,
      });
      await settle(ticket.id);
      expect(await runsFor(agent.id), 'depth 2 is the loop-guard ceiling').toHaveLength(before);
    } finally {
      subscriber.cooldownMs = original;
    }
  });

  it('depth guard: an event below the ceiling still dispatches — depth bounds, it does not block', async () => {
    const agent = await createAgent('Shallow bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const original = subscriber.cooldownMs;
    subscriber.cooldownMs = 0;
    try {
      const ticket = await createTicket('Shallow', reviewId);
      await settle(ticket.id);
      expect(await runsFor(agent.id)).toHaveLength(1);

      // depth 1 is inside the ceiling: an agent's first write-back may still run.
      subscriber.dispatch({
        type: 'record_updated',
        workspaceId: wsId,
        databaseId: ticketsDbId,
        recordId: ticket.id,
        changedFieldIds: [stateFieldId],
        actorId: null,
        depth: 1,
      });
      await settle(ticket.id);
      expect(await runsFor(agent.id)).toHaveLength(2);
    } finally {
      subscriber.cooldownMs = original;
    }
  });
});

describe('Dead-letter and retry (#212, ADR-0010 §5)', () => {
  it('a failing run retries with backoff, then lands as a Failed Run — the subscriber survives', async () => {
    const agent = await createAgent('Flaky bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    let attempts = 0;
    service.runtimeFor = () => ({
      runClass: 'non_ai' as const,
      // eslint-disable-next-line require-yield
      async *execute() {
        attempts++;
        throw new Error('tool blew up');
      },
    });
    try {
      const ticket = await createTicket('Explodes', reviewId);
      await settle(ticket.id);

      // 1 attempt + 2 retries (ADR-0010 §5).
      expect(attempts).toBe(3);

      const runs = await runsFor(agent.id);
      expect(runs, 'the dead-letter is a visible Run, not a swallowed error').toHaveLength(1);
      const runFields = await fieldsOf(runsDbId);
      expect(runs[0]!.values.status).toBe(optionId(runFields.get('status'), 'Failed'));
      const steps = plainText(runs[0]!.values.steps);
      expect(steps).toContain('tool blew up');
      expect(steps).toMatch(/retrying in/i);
    } finally {
      service.runtimeFor = original;
    }
  });

  it('a run that succeeds on a retry lands as Succeeded', async () => {
    const agent = await createAgent('Recovering bot', { enabled: true });
    await createBinding({
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: reviewId,
    });

    const service = app.get(AgentsService);
    const original = service.runtimeFor;
    let attempts = 0;
    service.runtimeFor = () => ({
      runClass: 'non_ai' as const,
      async *execute() {
        attempts++;
        if (attempts < 2) throw new Error('transient blip');
        yield { tool: 'work.do', summary: 'succeeded on the retry' };
      },
    });
    try {
      const ticket = await createTicket('Recovers', reviewId);
      await settle(ticket.id);

      const runs = await runsFor(agent.id);
      expect(runs).toHaveLength(1);
      const runFields = await fieldsOf(runsDbId);
      expect(runs[0]!.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
      const steps = plainText(runs[0]!.values.steps);
      // The failed attempt stays in the log — retries are visible, not hidden.
      expect(steps).toContain('transient blip');
      expect(steps).toContain('succeeded on the retry');
    } finally {
      service.runtimeFor = original;
    }
  });
});
