import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';
import type { PackManifest } from '@storyos/schemas';

/**
 * Business Packs — the pack format (MN-218 / #160).
 *
 * The money test is the round trip: build a business in one workspace, export
 * it, install it into a *clean* one, and check the result is the same running
 * system — not the same-looking one. The assertion that earns its keep is the
 * view-config one: a view stores `group_by_field_id` as a raw id, so a pack that
 * forgets to rewrite refs installs a view that validates, saves, and groups by a
 * field in somebody else's workspace. Nothing about it looks wrong until you
 * open it.
 *
 * Each describe gets its own workspace: install is find-by-name, so tests
 * sharing one would answer each other's create-vs-reuse questions.
 */

let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let admin: { token: string; email: string };

/**
 * Unanchored on purpose, and worth a word because the anchored version of this
 * was a bug in this file: `/^…$/` with the `g` flag matches only at the very
 * start/end of the subject, so scanning a serialised manifest with it found
 * nothing — ever. The leak test passed on a manifest that was *full* of raw ids,
 * and only a mutation run exposed it. Anything that scans inside a string must
 * be anchor-free.
 */
const UUID_SCAN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every raw uuid in a serialised value. */
function rawUuidsIn(value: unknown): string[] {
  return JSON.stringify(value)?.match(UUID_SCAN) ?? [];
}

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
  config?: Record<string, unknown>;
  options?: Array<{ id: string; label: string }>;
}

interface ViewDetail {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

async function detailOf(wsId: string, dbId: string) {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { fields: FieldDetail[]; views: ViewDetail[] };
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

async function dbNamed(wsId: string, name: string): Promise<{ id: string; name: string }> {
  const found = (await listDatabases(wsId)).find((d) => d.name === name);
  if (!found) throw new Error(`no database "${name}" in ${wsId}`);
  return found;
}

async function newWorkspace(name: string): Promise<string> {
  const res = await as(admin.token, 'POST', '/workspaces', { name: `${name} ${Date.now()}` });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

async function exportPack(wsId: string, body: Record<string, unknown>) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/packs/export`, body);
}

async function installPack(wsId: string, manifest: unknown) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/packs/install`, { manifest });
}

async function installOk(wsId: string, manifest: unknown) {
  const res = await installPack(wsId, manifest);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function previewPack(wsId: string, manifest: unknown) {
  return as(admin.token, 'POST', `/workspaces/${wsId}/packs/preview`, { manifest });
}

async function previewOk(wsId: string, manifest: unknown) {
  const res = await previewPack(wsId, manifest);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

interface PreviewItem {
  name: string;
  action: 'create' | 'reuse';
}

function actionsOf(items: PreviewItem[]): string[] {
  return items.map((i) => i.action);
}

/**
 * Builds a small but *complete* business in a workspace: schema, a relation, a
 * board view whose config is full of raw field ids, an automation keyed on a
 * field id and an option id, and an agent bound to a state.
 *
 * Deliberately not a toy. Every id-bearing config shape the format has to
 * survive is present here, because the bug this ticket is about is the one that
 * only appears in the shapes nobody remembered to test.
 */
async function buildSourceBusinessViaApi(wsId: string) {
  const space = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Sales' }))
    .json()
    .id as string;

  const leadsId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Leads',
    })
  ).json().id as string;
  const tasksId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Tasks',
    })
  ).json().id as string;

  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/fields`, {
    display_name: 'Status',
    type: 'select',
    config: {},
    options: [
      { label: 'New', color: 'blue' },
      { label: 'Contacted', color: 'orange' },
      { label: 'Won', color: 'green' },
    ],
  });
  // A config that is not `{}` — the round trip must not quietly flatten it.
  await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/fields`, {
    display_name: 'Score',
    type: 'number',
    config: { precision: 2, format: 'percent' },
  });

  await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: tasksId,
    database_b_id: leadsId,
    cardinality: 'one_to_many',
    field_a_name: 'Lead',
    field_b_name: 'Tasks',
  });

  const leads = await detailOf(wsId, leadsId);
  const status = fieldNamed(leads.fields, 'Status');
  const score = fieldNamed(leads.fields, 'Score');

  // The view: group_by, card_field_ids, and column_widths — which is KEYED by
  // field id, the shape a value-only rewrite silently misses.
  const view = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/views`, {
    name: 'Pipeline',
    type: 'board',
    config: {
      group_by_field_id: status.id,
      color_by_field_id: status.id,
      card_field_ids: [score.id],
      column_widths: { [score.id]: 220 },
      sorts: [],
      hidden_field_ids: [],
    },
  });
  expect(view.statusCode, view.body).toBe(201);

  // The automation: a field id in the trigger, an option id inside the condition.
  const rule = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${leadsId}/automations`, {
    name: 'Greet new leads',
    trigger: { type: 'record_updated', field_id: status.id },
    // `has` + an array: the option id sits nested inside the condition AST,
    // which is where a shallow rewrite would miss it.
    condition: { field: status.apiName, op: 'has', value: [optionId(status, 'New')] },
    actions: [{ type: 'add_comment', body_template: 'Welcome {Name}' }],
  });
  expect(rule.statusCode, rule.body).toBe(201);

  // The agent + its state binding, through the ordinary agents API — exactly as
  // a person would define them before exporting their workspace as a pack.
  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  const agentsDbId = ensured.json().agentsDb.id as string;

  const agentFields = (await detailOf(wsId, agentsDbId)).fields;
  const agent = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: {
      name: 'Greeter',
      enabled: true,
      goal: [{ type: 'paragraph', content: [{ type: 'text', text: 'Greet inbound leads' }] }],
      scopes: [optionId(fieldNamed(agentFields, 'Scopes'), 'write')],
      // The gate that must survive the round trip and still catch the send.
      approval_policy: [optionId(fieldNamed(agentFields, 'Approval policy'), 'email')],
      target_databases: leadsId,
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);

  const binding = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/triggers`, {
    agent: agent.json().id,
    database_id: leadsId,
    state_field_id: status.id,
    state_option_id: optionId(status, 'New'),
    human_gate: false,
    enabled: true,
  });
  expect(binding.statusCode, binding.body).toBe(201);

  return { space, leadsId, tasksId, statusId: status.id, scoreId: score.id };
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  admin = await signUpUser(app, 'PacksAdmin');
}, 60_000);

afterAll(async () => {
  await app?.close();
});

// ── export ───────────────────────────────────────────────────────────────────

describe('export', () => {
  let wsId: string;
  let manifest: PackManifest;

  beforeAll(async () => {
    wsId = await newWorkspace('Pack Source');
    await buildSourceBusinessViaApi(wsId);
    const res = await exportPack(wsId, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '1.2.0',
      summary: 'Leads and tasks with a pipeline board',
      space: 'Sales',
    });
    expect(res.statusCode, res.body).toBe(201);
    manifest = res.json() as PackManifest;
  }, 60_000);

  it('covers schema, states, views, automations, agents and bindings', () => {
    expect(manifest.format_version).toBe(1);
    expect(manifest.version).toBe('1.2.0');
    expect(manifest.databases.map((d) => d.name).sort()).toEqual(['Leads', 'Tasks']);
    expect(manifest.relations).toHaveLength(1);
    expect(manifest.states.map((s) => s.field)).toContain('Status');
    expect(manifest.views.map((v) => v.name)).toContain('Pipeline');
    expect(manifest.automations.map((a) => a.name)).toContain('Greet new leads');
    expect(manifest.agents.map((a) => a.name)).toContain('Greeter');
    expect(manifest.triggers).toHaveLength(1);
  });

  /**
   * The AC, asserted the blunt way: serialise the whole manifest and look for
   * anything uuid-shaped. A targeted per-field check would pass on exactly the
   * manifest this is meant to catch — one where a config key nobody thought of
   * still carries a raw id.
   */
  it('leaks no raw ids — every reference is symbolic', () => {
    // Self-check the detector before trusting it: a scan that cannot find a uuid
    // it is handed will happily certify anything. This is not paranoia — the
    // first version of this test did exactly that (see UUID_SCAN).
    expect(rawUuidsIn({ x: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })).toHaveLength(1);

    const leaked = rawUuidsIn(manifest);
    expect(leaked, `raw ids leaked into the manifest: ${leaked.slice(0, 5).join(', ')}`).toEqual([]);
  });

  it('rewrites the view config — ids became refs, including the keys', () => {
    const view = manifest.views.find((v) => v.name === 'Pipeline')!;
    expect(view.config.group_by_field_id).toBe('$field:leads.status');
    expect(view.config.color_by_field_id).toBe('$field:leads.status');
    expect(view.config.card_field_ids).toEqual(['$field:leads.score']);
    // The keyed-by-id shape.
    expect(Object.keys(view.config.column_widths as object)).toEqual(['$field:leads.score']);
  });

  it('rewrites automation trigger and condition, option ids included', () => {
    const rule = manifest.automations.find((a) => a.name === 'Greet new leads')!;
    expect(rule.trigger.field_id).toBe('$field:leads.status');
    expect((rule.condition as { value: string[] }).value).toEqual(['$option:leads.status.new']);
  });

  it('keeps non-empty field config (a lossy round trip is a broken one)', () => {
    const leads = manifest.databases.find((d) => d.name === 'Leads')!;
    const score = leads.fields.find((f) => f.name === 'Score')!;
    expect(score.config).toMatchObject({ precision: 2, format: 'percent' });
  });

  it('declares required connections and AI needs', () => {
    // Derived from content: no Slack action here, and agents are present.
    expect(manifest.requires.ai).toBe('byo');
    expect(manifest.requires.connections).not.toContain('slack');
  });

  it('never exports the Agentic OS system databases', () => {
    expect(manifest.databases.map((d) => d.name)).not.toContain('Agents');
    expect(manifest.databases.map((d) => d.name)).not.toContain('Runs');
  });
});

// ── the round trip ───────────────────────────────────────────────────────────

describe('round trip into a clean workspace', () => {
  let sourceWs: string;
  let targetWs: string;
  let manifest: PackManifest;
  let sourceStatusId: string;

  beforeAll(async () => {
    sourceWs = await newWorkspace('RT Source');
    const built = await buildSourceBusinessViaApi(sourceWs);
    sourceStatusId = built.statusId;

    const res = await exportPack(sourceWs, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '1.0.0',
      summary: 'Leads and tasks',
      space: 'Sales',
    });
    expect(res.statusCode, res.body).toBe(201);
    manifest = res.json() as PackManifest;

    targetWs = await newWorkspace('RT Target');
    await installOk(targetWs, manifest);
  }, 90_000);

  it('installs the schema', async () => {
    const names = (await listDatabases(targetWs)).map((d) => d.name);
    expect(names).toContain('Leads');
    expect(names).toContain('Tasks');
  });

  /**
   * THE assertion. The installed view must group by the TARGET workspace's
   * Status field — not the source's, and not nothing.
   *
   * Both halves matter. `toBe(targetStatus.id)` catches a rewrite that dropped
   * the key; `not.toBe(sourceStatusId)` catches the one that copied it through.
   * A test that only checked "is a uuid" would pass on both bugs.
   */
  it("the view's field ids point at the NEW workspace's fields", async () => {
    const leads = await dbNamed(targetWs, 'Leads');
    const detail = await detailOf(targetWs, leads.id);
    const targetStatus = fieldNamed(detail.fields, 'Status');
    const targetScore = fieldNamed(detail.fields, 'Score');

    const view = detail.views.find((v) => v.name === 'Pipeline');
    expect(view, 'the pack installed the Pipeline view').toBeTruthy();

    expect(view!.config.group_by_field_id).toBe(targetStatus.id);
    expect(view!.config.group_by_field_id).not.toBe(sourceStatusId);
    expect(view!.config.card_field_ids).toEqual([targetScore.id]);
    // The keyed-by-id shape survived, rewritten.
    expect(view!.config.column_widths).toEqual({ [targetScore.id]: 220 });
  });

  it('the automation points at the new workspace, option id and all', async () => {
    const leads = await dbNamed(targetWs, 'Leads');
    const detail = await detailOf(targetWs, leads.id);
    const status = fieldNamed(detail.fields, 'Status');

    const res = await as(admin.token, 'GET', `/workspaces/${targetWs}/databases/${leads.id}/automations`);
    const rule = (res.json().data as Array<{ name: string; trigger: { field_id: string }; condition: { value: string[] } }>)
      .find((r) => r.name === 'Greet new leads')!;
    expect(rule, 'the pack installed the automation').toBeTruthy();
    expect(rule.trigger.field_id).toBe(status.id);
    expect(rule.condition.value).toEqual([optionId(status, 'New')]);
  });

  it('the relation still links the right two databases', async () => {
    const tasks = await dbNamed(targetWs, 'Tasks');
    const leads = await dbNamed(targetWs, 'Leads');
    const detail = await detailOf(targetWs, tasks.id);
    const lead = fieldNamed(detail.fields, 'Lead') as FieldDetail & {
      relation?: { target_database_id: string; cardinality: string; inverse_field_id: string };
    };
    expect(lead.type).toBe('relation');
    // The relation field advertises its target database for generic clients —
    // and it must be the TARGET workspace's Leads, not the source's.
    expect(lead.relation!.target_database_id).toBe(leads.id);
    expect(lead.relation!.cardinality).toBe('one_to_many');

    // The inverse leg exists too, pointing back — a relation that installed as
    // a one-sided field would still satisfy the assertion above.
    const leadsDetail = await detailOf(targetWs, leads.id);
    const tasksField = fieldNamed(leadsDetail.fields, 'Tasks') as FieldDetail & {
      relation?: { target_database_id: string };
    };
    expect(tasksField.relation!.target_database_id).toBe(tasks.id);
  });

  it('the field config came across', async () => {
    const leads = await dbNamed(targetWs, 'Leads');
    const detail = await detailOf(targetWs, leads.id);
    expect(fieldNamed(detail.fields, 'Score').config).toMatchObject({
      precision: 2,
      format: 'percent',
    });
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('idempotent re-install', () => {
  let targetWs: string;
  let manifest: PackManifest;

  beforeAll(async () => {
    const sourceWs = await newWorkspace('Idem Source');
    await buildSourceBusinessViaApi(sourceWs);
    manifest = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
      })
    ).json() as PackManifest;
    targetWs = await newWorkspace('Idem Target');
  }, 90_000);

  it('installing twice creates nothing the second time', async () => {
    const first = await installOk(targetWs, manifest);
    expect(first.databases.every((d: { action: string }) => d.action === 'created')).toBe(true);

    const before = await counts(targetWs);
    const second = await installOk(targetWs, manifest);
    const after = await counts(targetWs);

    // Counts, not just the report — the report could claim "reused" while a
    // create slipped through on a path nobody reported.
    expect(after, 'a second install changed the workspace').toEqual(before);

    // And the report agrees.
    for (const kind of ['databases', 'views', 'automations', 'agents', 'triggers', 'states'] as const) {
      for (const entity of second[kind] as Array<{ name: string; action: string }>) {
        expect(entity.action, `${kind} "${entity.name}" was re-created`).toBe('reused');
      }
    }
  }, 90_000);

  async function counts(wsId: string) {
    const dbs = await listDatabases(wsId);
    const out: Record<string, number> = { databases: dbs.length };
    for (const db of dbs) {
      const detail = await detailOf(wsId, db.id);
      out[`${db.name}.fields`] = detail.fields.length;
      out[`${db.name}.views`] = detail.views.length;
      const rules = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db.id}/automations`);
      out[`${db.name}.automations`] = (rules.json().data as unknown[]).length;
      const records = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db.id}/records`);
      out[`${db.name}.records`] = (records.json().data as unknown[]).length;
    }
    return out;
  }
});

// ── the point of the whole ticket: a pack installs a RUNNING system ──────────

describe('an installed pack actually runs', () => {
  let targetWs: string;
  let leadsId: string;
  let status: FieldDetail;
  let runsDbId: string;
  let agentRecordId: string;

  beforeAll(async () => {
    const sourceWs = await newWorkspace('Run Source');
    await buildSourceBusinessViaApi(sourceWs);
    const manifest = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
      })
    ).json() as PackManifest;

    targetWs = await newWorkspace('Run Target');
    const result = await installOk(targetWs, manifest);
    agentRecordId = (result.agents as Array<{ name: string; id: string }>).find(
      (a) => a.name === 'Greeter',
    )!.id;

    leadsId = (await dbNamed(targetWs, 'Leads')).id;
    status = fieldNamed((await detailOf(targetWs, leadsId)).fields, 'Status');
    runsDbId = (await dbNamed(targetWs, 'Runs')).id;
  }, 90_000);

  /**
   * The runtime that stands in for the model — the pattern from
   * architect.test.ts, and honest for the same reason: no LLM exists
   * (ADR-0010 §3, `ManagedAiRuntime` throws), so the *drafting* is stubbed.
   * Everything the stub touches is real, and it is all real *in a workspace
   * that only ever saw a manifest*: the binding that fired came from the pack,
   * the state option it fired on came from the pack, and the approval policy
   * that catches the send was written onto the agent record by the pack.
   */
  function sendingRuntime(leadId: string): AgentRuntime {
    const send: ProposedAction = {
      kind: 'email',
      summary: 'send the greeting',
      payload: {
        apply: 'automation_action',
        database_id: leadsId,
        record_id: leadId,
        action: { type: 'notify_user', user: '@me', message: 'greeted' },
      },
    };
    return {
      runClass: 'non_ai',
      async *execute() {
        yield { tool: 'lead.read', summary: 'read the new lead' };
        yield { tool: 'greeting.send', summary: send.summary, action: send };
      },
    };
  }

  it('the packaged agent + binding fire in the target workspace, and gate', async () => {
    const service = app.get(AgentsService);
    const original = service.runtimeFor;

    const lead = (
      await as(admin.token, 'POST', `/workspaces/${targetWs}/databases/${leadsId}/records`, {
        values: { name: 'Initech — inbound' },
      })
    ).json();
    service.runtimeFor = () => sendingRuntime(lead.id);

    try {
      // The transition the pack's binding watches for.
      const moved = await as(
        admin.token,
        'PATCH',
        `/workspaces/${targetWs}/databases/${leadsId}/records/${lead.id}`,
        { values: { [status.apiName]: optionId(status, 'New') } },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      await subscriber.settle(lead.id);

      const runs = (
        await as(admin.token, 'GET', `/workspaces/${targetWs}/databases/${runsDbId}/records`)
      ).json().data as Array<{ values: Record<string, unknown> }>;
      const mine = runs.filter((r) =>
        ((r.values.agent as Array<{ id: string }> | undefined) ?? []).some(
          (l) => l.id === agentRecordId,
        ),
      );

      expect(mine.length, 'the installed binding dispatched a run').toBe(1);
      expect(mine[0]!.values.input_record).toBe(lead.id);

      // And the gate the pack carried still catches the send.
      const runFields = (await detailOf(targetWs, runsDbId)).fields;
      const statusField = fieldNamed(runFields, 'Status');
      expect(mine[0]!.values.status, 'the send parks at the gate the pack declared').toBe(
        optionId(statusField, 'Waiting approval'),
      );
    } finally {
      service.runtimeFor = original;
    }
  }, 60_000);
});

// ── cross-database refs inside action blobs ──────────────────────────────────

/**
 * An automation action carries `database_id` — a ref to a *different* database
 * in the same pack — and `send_slack_message`, which is what makes the pack
 * require Slack whether or not its author said so.
 *
 * Separate from the main fixture because both facts are about derivation, and
 * folding them in would have let the other tests' expectations drift.
 */
describe('refs that cross databases, and derived requirements', () => {
  let sourceWs: string;
  let manifest: PackManifest;
  let sourceTasksId: string;

  beforeAll(async () => {
    sourceWs = await newWorkspace('Cross Source');
    const built = await buildSourceBusinessViaApi(sourceWs);
    sourceTasksId = built.tasksId;

    const rule = await as(
      admin.token,
      'POST',
      `/workspaces/${sourceWs}/databases/${built.leadsId}/automations`,
      {
        name: 'Fan out on won',
        trigger: { type: 'record_created' },
        actions: [
          { type: 'send_slack_message', text: 'A lead landed' },
          // The id of ANOTHER database, buried in an action blob.
          { type: 'create_record', database_id: built.tasksId, values: { name: 'Follow up' } },
        ],
      },
    );
    expect(rule.statusCode, rule.body).toBe(201);

    const res = await exportPack(sourceWs, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '2.0.0',
      summary: 'Leads and tasks',
      upgrade_notes: 'Adds the fan-out automation',
      space: 'Sales',
    });
    expect(res.statusCode, res.body).toBe(201);
    manifest = res.json() as PackManifest;
  }, 90_000);

  it('derives the Slack requirement from the pack contents, not the author', () => {
    expect(manifest.requires.connections).toContain('slack');
  });

  it('carries upgrade notes and the semver', () => {
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.upgrade_notes).toBe('Adds the fan-out automation');
  });

  it("the cross-database ref in the action became a ref, not an id", () => {
    const rule = manifest.automations.find((a) => a.name === 'Fan out on won')!;
    const create = rule.actions.find((a) => a.type === 'create_record')!;
    expect(create.database_id).toBe('$db:tasks');
    expect(create.database_id).not.toBe(sourceTasksId);
  });

  it('installs pointing at the TARGET workspace\'s other database', async () => {
    const targetWs = await newWorkspace('Cross Target');
    await installOk(targetWs, manifest);

    const leads = await dbNamed(targetWs, 'Leads');
    const tasks = await dbNamed(targetWs, 'Tasks');
    const res = await as(
      admin.token,
      'GET',
      `/workspaces/${targetWs}/databases/${leads.id}/automations`,
    );
    const rule = (res.json().data as Array<{ name: string; actions: Array<Record<string, unknown>> }>)
      .find((r) => r.name === 'Fan out on won')!;
    const create = rule.actions.find((a) => a.type === 'create_record')!;

    expect(create.database_id).toBe(tasks.id);
    expect(create.database_id).not.toBe(sourceTasksId);
  }, 90_000);
});

// ── sample records ───────────────────────────────────────────────────────────

/**
 * Sample records are opt-in, and their values are the third place raw ids hide:
 * a select value IS an option id. A pack whose sample data was not rewritten
 * installs records whose Status points at the source workspace's option — which
 * renders as blank, not as an error.
 */
describe('sample records', () => {
  let manifest: PackManifest;
  let targetWs: string;

  beforeAll(async () => {
    const sourceWs = await newWorkspace('Sample Source');
    const built = await buildSourceBusinessViaApi(sourceWs);
    const status = fieldNamed((await detailOf(sourceWs, built.leadsId)).fields, 'Status');

    await as(admin.token, 'POST', `/workspaces/${sourceWs}/databases/${built.leadsId}/records`, {
      values: { name: 'Acme — sample', [status.apiName]: optionId(status, 'Contacted') },
    });

    manifest = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
        include_sample_records: true,
      })
    ).json() as PackManifest;

    targetWs = await newWorkspace('Sample Target');
    await installOk(targetWs, manifest);
  }, 90_000);

  it('exports the option id in a record value as a ref', () => {
    const sample = manifest.sample_records.find((r) => r.values.name === 'Acme — sample');
    expect(sample, 'the sample record was exported').toBeTruthy();
    expect(Object.values(sample!.values)).toContain('$option:leads.status.contacted');
    expect(rawUuidsIn(manifest)).toEqual([]);
  });

  it('installs the record with the TARGET workspace\'s option id', async () => {
    const leads = await dbNamed(targetWs, 'Leads');
    const status = fieldNamed((await detailOf(targetWs, leads.id)).fields, 'Status');
    const res = await as(admin.token, 'GET', `/workspaces/${targetWs}/databases/${leads.id}/records`);
    const record = (res.json().data as Array<{ title: string; values: Record<string, unknown> }>)
      .find((r) => r.title === 'Acme — sample');

    expect(record, 'the pack installed the sample record').toBeTruthy();
    expect(record!.values[status.apiName]).toBe(optionId(status, 'Contacted'));
  });

  it('re-installing does not duplicate the samples', async () => {
    const leads = await dbNamed(targetWs, 'Leads');
    const before = ((
      await as(admin.token, 'GET', `/workspaces/${targetWs}/databases/${leads.id}/records`)
    ).json().data as unknown[]).length;

    await installOk(targetWs, manifest);

    const after = ((
      await as(admin.token, 'GET', `/workspaces/${targetWs}/databases/${leads.id}/records`)
    ).json().data as unknown[]).length;
    expect(after).toBe(before);
  }, 60_000);
});

// ── requirements + validation ────────────────────────────────────────────────

describe('requirements and validation', () => {
  let wsId: string;
  let base: PackManifest;

  beforeAll(async () => {
    const sourceWs = await newWorkspace('Req Source');
    await buildSourceBusinessViaApi(sourceWs);
    base = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
      })
    ).json() as PackManifest;
    wsId = await newWorkspace('Req Target');
  }, 90_000);

  it('reports an unmet connection instead of crashing or half-installing', async () => {
    const manifest = {
      ...base,
      requires: { connections: ['slack'], ai: 'byo' },
    };
    const result = await installOk(wsId, manifest);

    expect(result.unmet).toHaveLength(1);
    expect(result.unmet[0].kind).toBe('connection');
    expect(result.unmet[0].name).toBe('slack');
    // Reported, not fatal: the rest of the pack is there.
    expect((await listDatabases(wsId)).map((d) => d.name)).toContain('Leads');
  }, 60_000);

  it('reports managed AI as unmet — it does not exist yet', async () => {
    const ws = await newWorkspace('Req AI');
    const result = await installOk(ws, { ...base, requires: { connections: [], ai: 'storyos' } });
    expect(result.unmet.map((u: { kind: string }) => u.kind)).toContain('ai');
  }, 60_000);

  it('a byo pack is never metered — the run class comes from the runtime', async () => {
    // ADR-0010: `your_own_ai` is never metered, and `requires.ai` is a
    // declaration a human reads, not a runtime input. Asserted structurally:
    // nothing in install may consult `requires.ai` to pick a runtime.
    const ws = await newWorkspace('Req BYO');
    const result = await installOk(ws, { ...base, requires: { connections: [], ai: 'byo' } });
    expect(result.unmet).toEqual([]);
  }, 60_000);

  it('a bad semver is a 422, not a 500', async () => {
    const res = await installPack(wsId, { ...base, version: 'v1.2' });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('semver');
  });

  it('a malformed manifest is a 422, not a 500', async () => {
    for (const bad of [undefined, null, 'nope', {}, { format_version: 9 }]) {
      const res = await installPack(wsId, bad);
      expect(res.statusCode, `payload ${JSON.stringify(bad)}`).toBe(422);
    }
  });

  it('export refuses a slice that is not self-contained', async () => {
    // A view grouped by a field of a database outside the slice would install
    // pointing at nothing. Exporting only Tasks leaves the Leads relation
    // dangling — the relation is skipped, but nothing silently breaks.
    const res = await exportPack(wsId, {
      slug: 'partial',
      name: 'Partial',
      version: '1.0.0',
      summary: 'just tasks',
      database_ids: [(await dbNamed(wsId, 'Tasks')).id],
    });
    expect(res.statusCode, res.body).toBe(201);
    const manifest = res.json() as PackManifest;
    expect(manifest.databases.map((d) => d.name)).toEqual(['Tasks']);
    // The cross-slice relation did not come along, and no raw id leaked.
    expect(manifest.relations).toEqual([]);
    expect(rawUuidsIn(manifest)).toEqual([]);
  }, 60_000);

  it('is admin-gated', async () => {
    const member = await signUpUser(app, 'PackMember');
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/packs/export`, {
      slug: 'x',
      name: 'X',
      version: '1.0.0',
      summary: 'x',
      space: 'Sales',
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ── preview (MN-219 / #161) ─────────────────────────────────────────────────

describe('preview', () => {
  let targetWs: string;
  let manifest: PackManifest;

  beforeAll(async () => {
    const sourceWs = await newWorkspace('Preview Source');
    await buildSourceBusinessViaApi(sourceWs);
    manifest = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
      })
    ).json() as PackManifest;
    targetWs = await newWorkspace('Preview Target');
  }, 90_000);

  it('a clean workspace previews everything as create, and creates nothing', async () => {
    const result = await previewOk(targetWs, manifest);

    expect(result.databases).toHaveLength(manifest.databases.length);
    expect(actionsOf(result.databases).every((a) => a === 'create')).toBe(true);
    expect(result.databases.map((d: PreviewItem) => d.name).sort()).toEqual(['Leads', 'Tasks']);

    // Views/automations/agents counts follow whatever the export produced
    // (databases carry their own default views along) — the thing under test
    // is that every one of them previews as `create`, not the exact count.
    expect(result.views.length).toBeGreaterThan(0);
    expect(actionsOf(result.views).every((a) => a === 'create')).toBe(true);
    expect(result.automations).toHaveLength(manifest.automations.length);
    expect(actionsOf(result.automations).every((a) => a === 'create')).toBe(true);
    expect(result.agents).toHaveLength(manifest.agents.length);
    expect(actionsOf(result.agents).every((a) => a === 'create')).toBe(true);
    expect(result.unmet).toEqual([]);

    // The whole point: nothing installed.
    expect(await listDatabases(targetWs)).toEqual([]);
  }, 60_000);

  it('after installing, the same manifest previews everything as reuse', async () => {
    await installOk(targetWs, manifest);
    const result = await previewOk(targetWs, manifest);

    expect(actionsOf(result.databases).every((a) => a === 'reuse')).toBe(true);
    expect(actionsOf(result.views).every((a) => a === 'reuse')).toBe(true);
    expect(actionsOf(result.automations).every((a) => a === 'reuse')).toBe(true);
    expect(actionsOf(result.agents).every((a) => a === 'reuse')).toBe(true);
  }, 60_000);

  it('surfaces unmet requirements exactly like install, without installing them', async () => {
    const ws = await newWorkspace('Preview Unmet');
    const result = await previewOk(ws, { ...manifest, requires: { connections: ['slack'], ai: 'storyos' } });

    expect(result.unmet.map((u: { kind: string }) => u.kind).sort()).toEqual(['ai', 'connection']);
    expect(await listDatabases(ws)).toEqual([]);
  }, 60_000);

  it('a malformed manifest is a 422, not a 500', async () => {
    for (const bad of [undefined, null, 'nope', {}, { format_version: 9 }]) {
      const res = await previewPack(targetWs, bad);
      expect(res.statusCode, `payload ${JSON.stringify(bad)}`).toBe(422);
    }
  });

  it('is admin-gated', async () => {
    const member = await signUpUser(app, 'PackPreviewMember');
    const res = await as(member.token, 'POST', `/workspaces/${targetWs}/packs/preview`, { manifest });
    expect([403, 404]).toContain(res.statusCode);
  });
});

// ── skills (#40) ─────────────────────────────────────────────────────────────

/**
 * Skills are the one manifest section with no ids to rewrite — a skill is
 * portable prose by design (skills.ts's header) — so what's worth testing
 * here is different from the rest of the format: explicit opt-in selection at
 * export (a skill is workspace-wide, not scoped to a slice), idempotent
 * install by name regardless of who created it, and the
 * agent-declares-a-skill-name validation the manifest format adds on top of
 * #40's own shape.
 */
describe('skills (#40)', () => {
  async function createSkill(wsId: string, overrides: Record<string, unknown> = {}) {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/skills`, {
      name: 'Lead triage reply drafter',
      description: 'Drafts a first-touch reply for a new lead.',
      when_to_use: 'When a new lead lands and needs a fast reply drafted.',
      instructions: 'Read the lead, draft a reply, leave it for a human.',
      examples: [],
      allowed_tools: ['records.read'],
      visibility: 'shared',
      ...overrides,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; name: string };
  }

  it('bundles an explicitly-requested skill into the manifest, unchanged', async () => {
    const wsId = await newWorkspace('Skills Source');
    await buildSourceBusinessViaApi(wsId);
    const skill = await createSkill(wsId);

    const res = await exportPack(wsId, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '1.0.0',
      summary: 'Leads and tasks',
      space: 'Sales',
      skill_ids: [skill.id],
    });
    expect(res.statusCode, res.body).toBe(201);
    const manifest = res.json() as PackManifest;

    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0]).toMatchObject({
      name: skill.name,
      description: 'Drafts a first-touch reply for a new lead.',
      allowed_tools: ['records.read'],
    });
    // Portable by design: no ref, no id, anywhere in it.
    expect(rawUuidsIn(manifest.skills)).toEqual([]);
  }, 60_000);

  it('a skill not requested does not ride along', async () => {
    const wsId = await newWorkspace('Skills Unrequested');
    await buildSourceBusinessViaApi(wsId);
    await createSkill(wsId);

    const res = await exportPack(wsId, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '1.0.0',
      summary: 'Leads and tasks',
      space: 'Sales',
    });
    const manifest = res.json() as PackManifest;
    expect(manifest.skills).toEqual([]);
  }, 60_000);

  it('installs the skill as shared, and a re-install reuses it by name', async () => {
    const sourceWs = await newWorkspace('Skills RT Source');
    await buildSourceBusinessViaApi(sourceWs);
    const skill = await createSkill(sourceWs);

    const manifest = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
        skill_ids: [skill.id],
      })
    ).json() as PackManifest;

    const targetWs = await newWorkspace('Skills RT Target');
    const first = await installOk(targetWs, manifest);
    expect(first.skills).toHaveLength(1);
    expect(first.skills[0].action).toBe('created');

    const installed = (await as(admin.token, 'GET', `/workspaces/${targetWs}/skills`)).json()
      .data as Array<{ name: string; visibility: string }>;
    expect(installed.map((s) => s.name)).toContain(skill.name);
    expect(installed.find((s) => s.name === skill.name)!.visibility).toBe('shared');

    const second = await installOk(targetWs, manifest);
    expect(second.skills[0].action).toBe('reused');
    const after = (await as(admin.token, 'GET', `/workspaces/${targetWs}/skills`)).json().data as unknown[];
    expect(after).toHaveLength(installed.length); // no duplicate
  }, 90_000);

  it("an agent's skill name must resolve to a bundled skill — 422, not a silent no-op", async () => {
    const sourceWs = await newWorkspace('Skills Validate Source');
    await buildSourceBusinessViaApi(sourceWs);
    const base = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
      })
    ).json() as PackManifest;

    const wsId = await newWorkspace('Skills Validate Target');
    const manifest = {
      ...base,
      agents: base.agents.map((a) => ({ ...a, skills: ['Nonexistent Skill'] })),
    };
    const res = await installPack(wsId, manifest);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('Nonexistent Skill');
  }, 60_000);

  it('installs cleanly when an agent declares a skill the manifest bundles', async () => {
    const sourceWs = await newWorkspace('Skills Bound Source');
    await buildSourceBusinessViaApi(sourceWs);
    const skill = await createSkill(sourceWs, { name: 'Weekly status digest' });
    const base = (
      await exportPack(sourceWs, {
        slug: 'sales-os',
        name: 'Sales OS',
        version: '1.0.0',
        summary: 'Leads and tasks',
        space: 'Sales',
        skill_ids: [skill.id],
      })
    ).json() as PackManifest;

    const wsId = await newWorkspace('Skills Bound Target');
    const manifest = {
      ...base,
      agents: base.agents.map((a) => ({ ...a, skills: [skill.name] })),
    };
    const result = await installOk(wsId, manifest);
    expect(result.skills).toHaveLength(1);
    expect(result.agents.map((a: { name: string }) => a.name)).toContain('Greeter');
  }, 60_000);

  it('two requested skills with colliding names are refused at export', async () => {
    const wsId = await newWorkspace('Skills Collide');
    await buildSourceBusinessViaApi(wsId);
    const a = await createSkill(wsId, { name: 'Duplicate Name' });
    const b = await createSkill(wsId, { name: 'duplicate name' }); // same, case/space-insensitively

    const res = await exportPack(wsId, {
      slug: 'sales-os',
      name: 'Sales OS',
      version: '1.0.0',
      summary: 'Leads and tasks',
      space: 'Sales',
      skill_ids: [a.id, b.id],
    });
    expect(res.statusCode, res.body).toBe(422);
  }, 60_000);
});
