import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import type { AgentRuntime, ProposedAction } from '../src/agents/agent-runtime';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let runsDbId: string;
/** An ordinary user database — the thing agents propose to act on. */
let issuesDbId: string;

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

/** Create an agent whose "Approval policy" gates exactly `policy`. */
async function createAgent(name: string, policy: string[]) {
  const fields = await fieldsOf(agentsDbId);
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: {
      name,
      enabled: true,
      scopes: [optionId(fields.get('scopes'), 'write')],
      approval_policy: policy.map((p) => optionId(fields.get('approval_policy'), p)),
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

/** An issue record for an agent to propose acting on. */
async function createIssue(title: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${issuesDbId}/records`, {
    values: { name: title },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function getIssue(id: string) {
  return (
    await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${issuesDbId}/records/${id}`)
  ).json();
}

async function getRun(id: string) {
  return (
    await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}/records/${id}`)
  ).json();
}

/**
 * Install a runtime that observes a step, then proposes `action`, then wants to
 * do one more thing. The trailing step is the halt probe: if the gate merely
 * *recorded* the proposal and let the iterator run on, `after.step` would show up
 * in the log.
 */
function stubRuntime(action: ProposedAction): AgentRuntime {
  return {
    runClass: 'non_ai',
    async *execute() {
      yield { tool: 'before.step', summary: 'looked at the record' };
      yield { tool: 'propose', summary: action.summary, action };
      yield { tool: 'after.step', summary: 'kept going past the gate' };
    },
  };
}

/** Run `agent` with `runtime` installed on the swappable seam, then restore it. */
async function runWith(agentId: string, runtime: AgentRuntime) {
  const service = app.get(AgentsService);
  const original = service.runtimeFor;
  service.runtimeFor = () => runtime;
  try {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agentId}/run`);
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  } finally {
    service.runtimeFor = original;
  }
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ApprovalsAdmin');
  member = await signUpUser(app, 'ApprovalsMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Approvals WS' })).json().id;

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

  const space = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Work' })).json();
  issuesDbId = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space.id,
      name: 'Issues',
    })
  ).json().id;
  const created = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${issuesDbId}/fields`, {
    display_name: 'Notes',
    type: 'text',
    config: {},
  });
  expect(created.statusCode, created.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('The Runs "Pending action" field (#210, ADR-0010 §4)', () => {
  it('ensure provisions it as text, and re-ensure adds no duplicate', async () => {
    const fields = await fieldsOf(runsDbId);
    const pending = fields.get('pending_action');
    expect(pending, 'Runs.Pending action').toBeTruthy();
    // Text, not rich_text: it round-trips a JSON payload verbatim.
    expect(pending!.type).toBe('text');

    const again = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
    expect(again.statusCode, again.body).toBe(201);
    const after = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${runsDbId}`)
    ).json().fields as FieldDetail[];
    expect(after.filter((f) => f.apiName === 'pending_action')).toHaveLength(1);
  });
});

describe('A gated action is staged, not executed (#210, ADR-0010 §4)', () => {
  it('parks the run in Waiting approval, persists the proposal, and applies NOTHING', async () => {
    const agent = await createAgent('Deleter', ['delete']);
    const issue = await createIssue('Delete me');

    const action: ProposedAction = {
      kind: 'delete',
      summary: `delete the issue "${issue.title}"`,
      payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
    };
    const run = await runWith(agent.id, stubRuntime(action));

    const runFields = await fieldsOf(runsDbId);
    expect(run.values.status).toBe(optionId(runFields.get('status'), 'Waiting approval'));
    // Blocked, not finished — a parked run has no end time.
    expect(run.values.finished_at).toBeFalsy();

    // The proposal is persisted AS DATA, recoverable in full.
    const staged = JSON.parse(run.values.pending_action as string);
    expect(staged.action).toMatchObject({
      kind: 'delete',
      summary: `delete the issue "${issue.title}"`,
      payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
    });

    // THE POINT: the action did not happen. The record is untouched.
    const stillThere = await getIssue(issue.id);
    expect(stillThere.id).toBe(issue.id);
    expect(stillThere.deleted ?? false).toBe(false);

    // And the run halted AT the gate — steps before it are logged, the step the
    // runtime wanted to take after it never ran.
    const steps = plainText(run.values.steps);
    expect(steps).toContain('looked at the record');
    expect(steps).not.toContain('kept going past the gate');
    expect(steps).not.toContain('action.applied');
  });

  it('notifies the owner in the Inbox, naming the exact proposed action', async () => {
    const agent = await createAgent('Notifier', ['delete']);
    const issue = await createIssue('Notify about me');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete the issue "Notify about me"',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );

    const inbox = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/notifications?type=approval_requested`)
    ).json();
    const item = inbox.data.find(
      (n: { record: { id: string } | null }) => n.record?.id === run.id,
    );
    expect(item, 'an approval notification for the run').toBeTruthy();
    // The owner can read what they are approving without leaving the Inbox.
    expect(item.snippet).toContain('delete the issue "Notify about me"');
    expect(item.snippet).toContain('Notifier');
    expect(item.type).toBe('approval_requested');
    // It points at the Run, which is where approve/reject live.
    expect(item.record.id).toBe(run.id);

    // Delivered even though the owner is the very person who pressed Run — the
    // run acts as the agent, so self-notification is the point, not a bug.
    expect(inbox.data.length).toBeGreaterThan(0);
  });

  it('is delivered even to an owner who has switched their other notifications off', async () => {
    // The trap: `notifications.type` is a text column, and delivery is gated on a
    // per-type toggle. An approval request has no toggle — if it were looked up
    // like the others it would resolve to `undefined` and be dropped for every
    // user with saved preferences, stranding the run forever.
    const saved = await as(admin.token, 'PATCH', '/users/me/preferences', {
      notifications: { assigned: false, mentioned: false, commented: false, state_changed: false },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const agent = await createAgent('Muted-owner notifier', ['delete']);
    const issue = await createIssue('Still notify me');
    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete the issue "Still notify me"',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );

    const inbox = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/notifications?type=approval_requested`)
    ).json();
    expect(
      inbox.data.some((n: { record: { id: string } | null }) => n.record?.id === run.id),
      'approval notification survives the preference filter',
    ).toBe(true);

    // Restore, so later tests see a default-preferences owner.
    await as(admin.token, 'PATCH', '/users/me/preferences', {
      notifications: { assigned: true, mentioned: true, commented: true, state_changed: true },
    });
  });
});

describe('Approve applies the staged action (#210, ADR-0010 §4)', () => {
  it('applies a gated set_values for real, then Succeeds the run', async () => {
    const agent = await createAgent('Editor', ['outward']);
    const issue = await createIssue('Edit me');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'outward',
        summary: 'write the triage note',
        payload: {
          apply: 'automation_action',
          database_id: issuesDbId,
          record_id: issue.id,
          action: { type: 'set_values', values: { notes: 'triaged by the agent' } },
        },
      }),
    );

    // Staged: nothing written yet.
    expect((await getIssue(issue.id)).values.notes).toBeFalsy();

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`);
    expect(res.statusCode, res.body).toBe(201);

    // THE POINT: the real side effect landed on the real record.
    expect((await getIssue(issue.id)).values.notes).toBe('triaged by the agent');

    const runFields = await fieldsOf(runsDbId);
    const approved = res.json();
    expect(approved.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
    expect(approved.values.finished_at).toBeTruthy();
    // The gate is closed behind it.
    expect(approved.values.pending_action).toBeFalsy();

    const steps = plainText(approved.values.steps);
    expect(steps).toContain('action.applied');
    expect(steps).toContain('write the triage note');
    // The steps that led up to the gate are preserved across the park/resume.
    expect(steps).toContain('looked at the record');
  });

  it('logs the soft-deleted record id so the run view can offer undo (ADR-0009)', async () => {
    const agent = await createAgent('Undo-able deleter', ['delete']);
    const issue = await createIssue('Delete then restore me');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete a stale issue',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );
    const approved = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`)
    ).json();

    // The delete really happened — it is in the trash, not gone.
    const trash = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${issuesDbId}/records/trash`)
    ).json();
    expect(
      (trash.data ?? trash).some((r: { id: string }) => r.id === issue.id),
      'the approved delete soft-deleted the record',
    ).toBe(true);

    // Undo is only offerable if the log says WHICH record to bring back.
    const steps = plainText(approved.values.steps);
    expect(steps).toContain(issue.id);
    expect(steps).toContain('restore');

    // And the existing restore endpoint really does bring it back — soft delete
    // is what makes an applied destructive step recoverable (ADR-0010 §4).
    const restored = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/databases/${issuesDbId}/records/${issue.id}/restore`,
    );
    expect(restored.statusCode, restored.body).toBe(201);
    expect((await getIssue(issue.id)).title).toBe('Delete then restore me');
  });
});

describe('Reject applies nothing (#210, ADR-0010 §4)', () => {
  it('cancels the run and leaves the target completely untouched', async () => {
    const agent = await createAgent('Rejected editor', ['outward']);
    const issue = await createIssue('Do not touch me');
    const before = await getIssue(issue.id);

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'outward',
        summary: 'overwrite the notes',
        payload: {
          apply: 'automation_action',
          database_id: issuesDbId,
          record_id: issue.id,
          action: { type: 'set_values', values: { notes: 'THIS MUST NEVER LAND' } },
        },
      }),
    );

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/reject`);
    expect(res.statusCode, res.body).toBe(201);

    // THE POINT: no side effect at all. Not reverted — never applied.
    const after = await getIssue(issue.id);
    expect(after.values.notes).toBeFalsy();
    expect(after.title).toBe(before.title);
    expect(after.updated_at ?? after.updatedAt).toBe(before.updated_at ?? before.updatedAt);

    const runFields = await fieldsOf(runsDbId);
    const rejected = res.json();
    expect(rejected.values.status).toBe(optionId(runFields.get('status'), 'Canceled'));
    expect(rejected.values.finished_at).toBeTruthy();
    expect(rejected.values.pending_action).toBeFalsy();

    const steps = plainText(rejected.values.steps);
    expect(steps).toContain('action.rejected');
    expect(steps).toContain('no side effects');
    expect(steps).not.toContain('action.applied');
  });

  it('a rejected delete leaves the record alive and out of the trash', async () => {
    const agent = await createAgent('Rejected deleter', ['delete']);
    const issue = await createIssue('Spared');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete a record',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );
    expect(
      (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/reject`)).statusCode,
    ).toBe(201);

    const alive = await getIssue(issue.id);
    expect(alive.deleted ?? false).toBe(false);
    const trash = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${issuesDbId}/records/trash`)
    ).json();
    expect((trash.data ?? trash).some((r: { id: string }) => r.id === issue.id)).toBe(false);
  });
});

describe('An ungated action executes inline (#210, ADR-0010 §4)', () => {
  it('applies immediately, the run Succeeds, and it never waits', async () => {
    // The agent gates `delete` — and proposes a `set_values`. A gate the owner
    // did not ask for must not appear.
    const agent = await createAgent('Unfettered', ['delete']);
    const issue = await createIssue('Auto-edit me');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'set_values',
        summary: 'set the notes without asking',
        payload: {
          apply: 'automation_action',
          database_id: issuesDbId,
          record_id: issue.id,
          action: { type: 'set_values', values: { notes: 'applied inline' } },
        },
      }),
    );

    const runFields = await fieldsOf(runsDbId);
    expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
    expect(run.values.pending_action).toBeFalsy();
    expect(run.values.finished_at).toBeTruthy();

    // Applied without a human, and the run carried on to the end.
    expect((await getIssue(issue.id)).values.notes).toBe('applied inline');
    const steps = plainText(run.values.steps);
    expect(steps).toContain('action.applied');
    expect(steps).toContain('kept going past the gate');

    // No approval was requested for it.
    const inbox = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/notifications?type=approval_requested`)
    ).json();
    expect(inbox.data.some((n: { record: { id: string } | null }) => n.record?.id === run.id)).toBe(
      false,
    );
  });

  it('an agent with an empty approval policy gates nothing', async () => {
    const agent = await createAgent('Trusted', []);
    const issue = await createIssue('Trusted target');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete without a gate',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );

    const runFields = await fieldsOf(runsDbId);
    expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));
    // The owner gated nothing, so the delete applied — trust is the owner's to give.
    const trash = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${issuesDbId}/records/trash`)
    ).json();
    expect((trash.data ?? trash).some((r: { id: string }) => r.id === issue.id)).toBe(true);
  });
});

describe('Gate endpoints guard their state and their caller (#210)', () => {
  it('approve/reject on a run that is not Waiting approval is 422', async () => {
    const agent = await createAgent('Plain', ['delete']);
    // A run with no proposal at all: it just Succeeds.
    const run = await runWith(agent.id, {
      runClass: 'non_ai',
      async *execute() {
        yield { tool: 'noop', summary: 'did nothing gated' };
      },
    });
    const runFields = await fieldsOf(runsDbId);
    expect(run.values.status).toBe(optionId(runFields.get('status'), 'Succeeded'));

    for (const verdict of ['approve', 'reject']) {
      const res = await as(
        admin.token,
        'POST',
        `/workspaces/${wsId}/agents/runs/${run.id}/${verdict}`,
      );
      expect(res.statusCode, `${verdict}: ${res.body}`).toBe(422);
      expect(res.json().error.message).toMatch(/not waiting for approval/i);
    }
  });

  it('a second approve is 422 — an approved action cannot be applied twice', async () => {
    const agent = await createAgent('Double-tap', ['outward']);
    const issue = await createIssue('Approve me once');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'outward',
        summary: 'set the notes once',
        payload: {
          apply: 'automation_action',
          database_id: issuesDbId,
          record_id: issue.id,
          action: { type: 'set_values', values: { notes: 'first' } },
        },
      }),
    );

    expect(
      (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`)).statusCode,
    ).toBe(201);
    const second = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`);
    expect(second.statusCode, second.body).toBe(422);
  });

  it('rejecting an already-approved run is 422 — the verdict is final', async () => {
    const agent = await createAgent('Final', ['outward']);
    const issue = await createIssue('Final target');

    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'outward',
        summary: 'set the notes finally',
        payload: {
          apply: 'automation_action',
          database_id: issuesDbId,
          record_id: issue.id,
          action: { type: 'set_values', values: { notes: 'landed' } },
        },
      }),
    );
    await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`);

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/reject`);
    expect(res.statusCode, res.body).toBe(422);
    // The approved effect is not undone by a late reject.
    expect((await getIssue(issue.id)).values.notes).toBe('landed');
  });

  it('resolves a run by its public number too', async () => {
    const agent = await createAgent('Numbered gate', ['delete']);
    const issue = await createIssue('Numbered target');
    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete by number',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );
    const res = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/agents/runs/${run.number}/reject`,
    );
    expect(res.statusCode, res.body).toBe(201);
  });

  it('404s for an unknown run', async () => {
    const missing = await as(
      admin.token,
      'POST',
      `/workspaces/${wsId}/agents/runs/00000000-0000-4000-8000-000000000000/approve`,
    );
    expect(missing.statusCode).toBe(404);
    expect(
      (await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/99999/reject`)).statusCode,
    ).toBe(404);
  });

  it('is admin-only — a non-admin member gets 403 on both verdicts', async () => {
    const agent = await createAgent('Guarded gate', ['delete']);
    const issue = await createIssue('Guarded target');
    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete something guarded',
        payload: { apply: 'record_delete', database_id: issuesDbId, record_id: issue.id },
      }),
    );

    for (const verdict of ['approve', 'reject']) {
      const res = await as(
        member.token,
        'POST',
        `/workspaces/${wsId}/agents/runs/${run.id}/${verdict}`,
      );
      expect(res.statusCode, `${verdict}: ${res.body}`).toBe(403);
    }
    // Still parked, still unapplied — a 403 resolves nothing.
    expect((await getRun(run.id)).values.pending_action).toBeTruthy();
    expect((await getIssue(issue.id)).deleted ?? false).toBe(false);
  });

  it('a malformed staged payload is a 422, not a 500 or a wild write', async () => {
    const agent = await createAgent('Malformed', ['delete']);
    const run = await runWith(
      agent.id,
      stubRuntime({
        kind: 'delete',
        summary: 'delete something unspecified',
        // A runtime can propose anything; the apply boundary is what validates.
        payload: { apply: 'record_delete', database_id: 'not-a-uuid' },
      }),
    );
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/runs/${run.id}/approve`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.message).toMatch(/malformed/i);
  });
});
