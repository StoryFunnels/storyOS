import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';
import { EntitlementsService } from '../src/billing/entitlements.service';

let app: NestFastifyApplication;
let engine: AutomationsService;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let stateApi: string;
let stateFieldId: string;
let urgentId: string;
let doneId: string;
let notesApi: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService); // Nest already ran onModuleInit (interval skipped in test env)
  admin = await signUpUser(app, 'Automator');
  wsId = (await inject('POST', '/workspaces', { name: 'Auto WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;
  const state = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'State', type: 'select', config: {}, options: [{ label: 'Urgent' }, { label: 'Done' }],
  })).json();
  stateApi = state.apiName;
  stateFieldId = state.id;
  urgentId = state.options.find((o: { label: string }) => o.label === 'Urgent').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;
  const notes = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Notes', type: 'text', config: {},
  })).json();
  notesApi = notes.apiName;
});

afterAll(async () => {
  await app.close();
});

describe('automations (MN-047)', () => {
  it('field-scoped update rule fires only on that field and honors the condition', async () => {
    const rule = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Escalate urgent',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      condition: { field: stateApi, op: 'has', value: [urgentId] },
      actions: [{ type: 'add_comment', body_template: 'Escalated: {Title}' }],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Server down' },
    })).json();

    // Unrelated field change → no fire.
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [notesApi]: 'just a note' },
    });
    await engine.settle(rec.id);
    let comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(comments.data).toHaveLength(0);

    // State → Done: field matches, condition doesn't → no fire.
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(comments.data).toHaveLength(0);

    // State → Urgent: fires.
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: urgentId },
    });
    await engine.settle(rec.id);
    await wait(50);
    comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    expect(comments.data).toHaveLength(1);
    expect(comments.data[0].body[0].text).toBe('Escalated: Server down');

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}/runs`)).json();
    expect(runs.data.some((r: { status: string }) => r.status === 'ok')).toBe(true);
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}`, { enabled: false });
  });

  it('the loop-guard diagnostic names the rule and the rule it applies (#275)', async () => {
    // The old message was just "depth N — loop guard", which told an author
    // neither WHICH rule stopped nor what would have let it continue.
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const notesField = detail.fields.find((f: { apiName: string }) => f.apiName === notesApi);
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Diagnostic bait',
      trigger: { type: 'record_updated', field_id: notesField.id },
      actions: [{ type: 'set_values', values: { [notesApi]: '@now' } }],
    })).json();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Diagnostic target', [notesApi]: 'start' },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [notesApi]: 'user edit' },
    });
    for (let i = 0; i < 10; i++) {
      await engine.settle(rec.id);
      await wait(30);
    }

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)).json();
    const skipped = runs.data.filter((r: { status: string }) => r.status === 'skipped');
    expect(skipped.length, JSON.stringify(runs.data)).toBeGreaterThanOrEqual(1);
    expect(skipped[0].error).toContain('Diagnostic bait');
    expect(skipped[0].error).toMatch(/strictly decreases/);
    // A TEXT self-trigger can never converge, so it must still be halted.
    const ok = runs.data.filter((r: { status: string }) => r.status === 'ok');
    expect(ok.length).toBeLessThanOrEqual(3);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('self-retriggering rules stop at the depth guard', async () => {
    // Rule pokes Notes whenever Notes changes → would loop forever without the guard.
    const rule = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Loop bait',
      trigger: { type: 'record_updated', field_id: (await (async () => {
        const detail = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
        return detail.fields.find((f: { apiName: string }) => f.apiName === notesApi).id;
      })()) },
      actions: [{ type: 'set_values', values: { [notesApi]: '@now' } }], // @now changes every run — a real loop
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Loop target', [notesApi]: 'start' },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [notesApi]: 'user edit' },
    });
    // Let the chain drain (depth 0 → rule → depth 1 → rule → depth 2 skip).
    for (let i = 0; i < 10; i++) {
      await engine.settle(rec.id);
      await wait(30);
    }
    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}/runs`)).json();
    const skipped = runs.data.filter((r: { status: string }) => r.status === 'skipped');
    const ok = runs.data.filter((r: { status: string }) => r.status === 'ok');
    expect(skipped.length).toBeGreaterThanOrEqual(1); // loop guard engaged
    expect(ok.length).toBeLessThanOrEqual(3);
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.json().id}`, { enabled: false });
  });

  it('scheduled rules fire on tick over condition-matching records, and dry-run reports', async () => {
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Daily sweep',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      condition: { field: stateApi, op: 'has', value: [urgentId] },
      actions: [{ type: 'add_comment', body_template: 'Still urgent!' }],
    })).json();

    const urgent = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Sweep me', [stateApi]: urgentId },
    })).json();
    const calm = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Leave me', [stateApi]: doneId },
    })).json();

    // Dry-run first.
    const test = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/test`, {
      record_id: urgent.id,
    })).json();
    expect(test.would_run).toBe(true);

    // Force the schedule due and tick.
    const { connectTestDb } = await import('./helpers/db');
    const { db, pool } = connectTestDb();
    const { automations } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, rule.id));
    await engine.tick();
    await pool.end();

    const urgentComments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${urgent.id}/comments`)).json();
    expect(urgentComments.data.some((c: { body: Array<{ text: string }> }) => c.body[0].text === 'Still urgent!')).toBe(true);
    const calmComments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${calm.id}/comments`)).json();
    expect(calmComments.data).toHaveLength(0);

    // next_due_at advanced into the future.
    const rules = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations`)).json();
    const updated = rules.data.find((r: { id: string }) => r.id === rule.id);
    expect(new Date(updated.nextDueAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('failing rules auto-disable after 10 consecutive errors', async () => {
    // Bypass save-time validation by deleting the target field after creation.
    const doomed = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Doomed', type: 'number', config: {},
    })).json();
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Always fails',
      trigger: { type: 'record_created' },
      actions: [{ type: 'set_values', values: { [doomed.apiName]: 1 } }],
    })).json();
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/fields/${doomed.id}`);

    for (let i = 0; i < 11; i++) {
      const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: `Fail ${i}` },
      })).json();
      await engine.settle(rec.id);
      await wait(20);
    }
    const rules = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations`)).json();
    const updated = rules.data.find((r: { id: string }) => r.id === rule.id);
    expect(updated.enabled).toBe(false);
    expect(updated.failureStreak).toBeGreaterThanOrEqual(10);
  });
});

describe('MN-168 — entitlements wiring for the automations engine', () => {
  /** Stripe is unset in tests (self-host mode) — spy on the real method, same
   *  technique as agent-runs.test.ts, to prove which code path calls it. */
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

  it('a successful run checks the allowance and then counts against it', async () => {
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Metered rule',
      trigger: { type: 'record_created' },
      actions: [{ type: 'add_comment', body_template: 'noted' }],
    })).json();
    const { canSpy, recordSpy, restore } = spyEntitlements();
    try {
      const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: 'Meter me' },
      })).json();
      await engine.settle(rec.id);
      await wait(30);

      expect(canSpy).toHaveBeenCalledWith(wsId, 'automation_run');
      expect(recordSpy).toHaveBeenCalledExactlyOnceWith(wsId);
    } finally {
      restore();
      await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
    }
  });

  it('a run over its allowance is skipped BEFORE any action executes — never a crash', async () => {
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Over-quota rule',
      trigger: { type: 'record_created' },
      actions: [{ type: 'add_comment', body_template: 'should never post' }],
    })).json();
    const entitlements = app.get(EntitlementsService);
    const originalCan = entitlements.can.bind(entitlements);
    entitlements.can = vi.fn(async (workspaceId: string, capability) =>
      workspaceId === wsId ? false : originalCan(workspaceId, capability),
    );
    try {
      const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { name: 'Blocked' },
      })).json();
      await engine.settle(rec.id);
      await wait(30);

      const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
      expect(comments.data).toHaveLength(0); // the gated action never ran

      const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)).json();
      // MN-264: this branch now writes a distinct 'skipped_quota' status (not
      // the generic 'skipped' the depth-guard/record-gone branches use) so the
      // Runs page and quota meter can tell "hit the allowance" apart from
      // every other skip reason without parsing `error` text.
      const blocked = runs.data.find(
        (r: { status: string; error?: string }) => r.status === 'skipped_quota' && /allowance/i.test(r.error ?? ''),
      );
      expect(blocked, JSON.stringify(runs.data)).toBeTruthy();
    } finally {
      entitlements.can = originalCan;
      await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
    }
  });

  /**
   * MN-264 — the enforcement BOUNDARY itself, proven against the real
   * runRule() path (not just EntitlementsService.can() in isolation, which
   * entitlements.service.test.ts already covers at the unit level): the Nth
   * record-created run must complete 'ok' and count toward the allowance, and
   * the very next one — N+1 — must be skipped_quota, with no partial/garbled
   * state in between. Mocks entitlements.can() to flip false after N calls
   * (same technique the "over its allowance" test above uses), rather than
   * fighting Stripe-disabled test-env plumbing to get a real plan cap — the
   * plan-limit MATH itself (usage < limit) is entitlements.service.test.ts's
   * job, not this file's.
   */
  it('enforcement boundary: exactly the Nth run is ok, the N+1th is skipped_quota', async () => {
    const N = 3;
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Boundary rule',
      trigger: { type: 'record_created' },
      actions: [{ type: 'add_comment', body_template: 'counted' }],
    })).json();
    const entitlements = app.get(EntitlementsService);
    const originalCan = entitlements.can.bind(entitlements);
    let calls = 0;
    entitlements.can = vi.fn(async (workspaceId: string, capability) => {
      if (workspaceId !== wsId) return originalCan(workspaceId, capability);
      calls += 1;
      return calls <= N;
    });
    try {
      const recs: { id: string }[] = [];
      for (let i = 0; i < N + 1; i++) {
        const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
          values: { name: `Boundary ${i}` },
        })).json();
        await engine.settle(rec.id);
        await wait(20);
        recs.push(rec);
      }

      const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)).json();
      const ok = runs.data.filter((r: { status: string }) => r.status === 'ok');
      const quotaSkipped = runs.data.filter((r: { status: string }) => r.status === 'skipped_quota');
      expect(ok).toHaveLength(N); // exactly the first N — never fewer, never more
      expect(quotaSkipped).toHaveLength(1); // exactly the N+1th, not silently swallowed or duplicated

      // And the gated action itself only ran N times — proving the skip
      // happens BEFORE the action, not as an after-the-fact bookkeeping label.
      const lastRecComments = (
        await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recs[N]!.id}/comments`)
      ).json();
      expect(lastRecComments.data).toHaveLength(0);
    } finally {
      entitlements.can = originalCan;
      await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
    }
  });

  it('fires record_linked when the relation is set INLINE on a record update (#324)', async () => {
    // The reported inconsistency: the dedicated Links API fired the rule, but
    // setting the same relation inline on a record update did not — and nothing
    // on screen tells you which path a click took, so the rule looked flaky.
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const partsId = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Parts 324',
    })).json().id;
    const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: partsId,
      cardinality: 'many_to_many',
    })).json();
    const hostField: string = rel.field_a.id;
    const hostApi: string = rel.field_a.api_name ?? rel.field_a.apiName;

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Inline link announcer',
      trigger: { type: 'record_linked', relation_field_id: hostField, direction: 'link' },
      actions: [{ type: 'add_comment', body_template: 'INLINE-LINKED: {linked.Title}' }],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const part = (await inject('POST', `/workspaces/${wsId}/databases/${partsId}/records`, {
      values: { name: 'Widget' },
    })).json();
    const host = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Assembly' },
    })).json();

    // INLINE — the path that used to be silent.
    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${host.id}`, {
      values: { [hostApi]: [part.id] },
    });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
    await engine.settle(host.id);
    await wait(80);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${host.id}/comments`)).json();
    const texts = comments.data.map((c: { body: Array<{ text: string }> }) => c.body[0]?.text ?? '');
    const linked = texts.filter((t: string) => t.startsWith('INLINE-LINKED:'));

    // Fired at all — the fix.
    expect(linked, JSON.stringify(texts)).toHaveLength(1);
    // …and {linked.Title} resolved to the specific record, so direction and the
    // linked-record payload survived the new path (#270/#244 still hold).
    expect(linked[0]).toBe('INLINE-LINKED: Widget');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('ONE inline link does not run the same rule twice, and rollups stay right (#324)', async () => {
    // The hazard the fix had to avoid: the inline path already emits
    // record_updated carrying the same linkedRelations, and the rollup cascade
    // consumes BOTH event types. A naive extra emit would double the fan-out.
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const itemsId = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Items 324',
    })).json().id;
    const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: itemsId,
      cardinality: 'many_to_many',
    })).json();
    const hostField: string = rel.field_a.id;
    const hostApi: string = rel.field_a.api_name ?? rel.field_a.apiName;

    // A count rollup over the same relation — if the cascade ran twice this
    // still reads 1, so the real double-work signal is the RUN COUNT below.
    const rollup = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Item Count',
      type: 'rollup',
      config: { relation_field_id: hostField, op: 'count' },
    })).json();
    expect(rollup.id, JSON.stringify(rollup)).toBeTruthy();

    const linkRule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Count the runs',
      trigger: { type: 'record_linked', relation_field_id: hostField, direction: 'link' },
      actions: [{ type: 'add_comment', body_template: 'RUN' }],
    })).json();

    const item = (await inject('POST', `/workspaces/${wsId}/databases/${itemsId}/records`, {
      values: { name: 'One item' },
    })).json();
    const host = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Counts once' },
    })).json();

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${host.id}`, {
      values: { [hostApi]: [item.id] },
    });
    await engine.settle(host.id);
    await wait(120);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${host.id}/comments`)).json();
    const runs = comments.data
      .map((c: { body: Array<{ text: string }> }) => c.body[0]?.text ?? '')
      .filter((t: string) => t === 'RUN');
    // EXACTLY one. Two would mean one user action produced two runs of the same rule.
    expect(runs, JSON.stringify(comments.data)).toHaveLength(1);

    // And the rollup is correct — the cascade ran, just not twice.
    const read = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${host.id}`)).json();
    expect(read.values[rollup.apiName]).toBe(1);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${linkRule.id}`, { enabled: false });
  });

  it('record_linked trigger exposes the specific linked record to actions via {linked.Field} (#244)', async () => {
    // Two databases joined many-to-many: Tickets (host) ←→ Milestones. The rule
    // lives on the host but needs to read the MILESTONE it was just linked to —
    // impossible before #244, which only ever exposed the host record.
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const milestonesId = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: spaceId,
      name: 'Milestones',
    })).json().id;
    const targetApi = (await inject('POST', `/workspaces/${wsId}/databases/${milestonesId}/fields`, {
      display_name: 'Target',
      type: 'text',
      config: {},
    })).json().apiName;

    const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: milestonesId,
      cardinality: 'many_to_many',
    })).json();
    const hostRelationFieldId: string = rel.field_a.id; // the Tickets-side relation field

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Announce the linked milestone',
      trigger: { type: 'record_linked', relation_field_id: hostRelationFieldId },
      actions: [
        // interpolate path: {linked.Title} + a display-named field from the OTHER db.
        { type: 'add_comment', body_template: 'Linked to {linked.Title} (target {linked.Target})' },
        // typed whole-value path: copy the linked record's field straight onto the host.
        { type: 'set_values', values: { [notesApi]: '{linked.Target}' } },
      ],
    })).json();
    expect(rule.id).toBeTruthy();

    const milestone = (await inject('POST', `/workspaces/${wsId}/databases/${milestonesId}/records`, {
      values: { name: 'Q3 Launch', [targetApi]: '2026-09-01' },
    })).json();
    const ticket = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Ship it' },
    })).json();

    // Link the milestone to the ticket → fires the record_linked trigger.
    const link = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}/links/${hostRelationFieldId}`,
      { record_ids: [milestone.id] },
    );
    expect(link.statusCode, link.body).toBe(201);
    await engine.settle(ticket.id);
    await wait(50);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}/comments`)).json();
    expect(
      comments.data.some(
        (c: { body: Array<{ text: string }> }) => c.body[0]?.text === 'Linked to Q3 Launch (target 2026-09-01)',
      ),
    ).toBe(true);

    const host = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}`)).json();
    expect(host.values[notesApi]).toBe('2026-09-01');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('per-action conditions run exactly one of two opposing actions; a skip does not block later ones (#245)', async () => {
    // Two comment actions with opposing conditions. When Status = Done, the
    // first (urgent) is SKIPPED and the second (done) still runs — proving a
    // skip only drops its own action.
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Branch on status',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        { type: 'add_comment', body_template: 'URGENT path', condition: { field: stateApi, op: 'has', value: [urgentId] } },
        { type: 'add_comment', body_template: 'DONE path', condition: { field: stateApi, op: 'has', value: [doneId] } },
      ],
    })).json();
    expect(rule.id).toBeTruthy();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Branch me' },
    })).json();

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    const texts = comments.data.map((c: { body: Array<{ text: string }> }) => c.body[0]?.text);
    expect(texts).toContain('DONE path');
    expect(texts).not.toContain('URGENT path');

    // The urgent action is recorded as skipped (not failed) in the run's effects.
    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)).json();
    const okRun = runs.data.find((r: { status: string }) => r.status === 'ok');
    expect(okRun).toBeTruthy();
    expect(
      (okRun.effects ?? []).some((e: { type: string }) => e.type === 'skipped'),
      'the false-condition action is logged as skipped',
    ).toBe(true);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('create_records fans out N records from a dynamic count, with {index} (#246)', async () => {
    // The sprint-days case: one rule fires once and spawns one "Day" per the
    // trigger record's Count — no self-triggering loop, no script.
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const daysDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Days' })).json().id;
    const countApi = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Count',
      type: 'number',
      config: {},
    })).json().apiName;

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Spawn days',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        { type: 'create_records', database_id: daysDb, count: '{Count}', values: { name: 'Day {index}' } },
      ],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const ticket = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Sprint 1', [countApi]: 3 },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}`, {
      values: { [stateApi]: urgentId },
    });
    await engine.settle(ticket.id);
    await wait(50);

    const days = (await inject('POST', `/workspaces/${wsId}/databases/${daysDb}/records/query`, {})).json();
    expect(days.data).toHaveLength(3);
    expect(days.data.map((r: { title: string }) => r.title).sort()).toEqual(['Day 1', 'Day 2', 'Day 3']);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('record_linked condition tests the LINKED record — fires only when the linked record matches (#271)', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const msDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Milestones-271' })).json().id;
    const ms = (await inject('POST', `/workspaces/${wsId}/databases/${msDb}/fields`, {
      display_name: 'MStatus',
      type: 'select',
      config: {},
      options: [{ label: 'Active' }, { label: 'Inactive' }],
    })).json();
    const msStatusApi = ms.apiName;
    const activeId = ms.options.find((o: { label: string }) => o.label === 'Active').id;

    const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: msDb,
      cardinality: 'many_to_many',
    })).json();
    const hostRelField = rel.field_a.id;

    // Condition references a field on the LINKED (Milestones) database, not the host.
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Only active milestones',
      trigger: { type: 'record_linked', relation_field_id: hostRelField },
      condition: { field: msStatusApi, op: 'has', value: [activeId] },
      actions: [{ type: 'add_comment', body_template: 'Linked to an active milestone' }],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const activeMs = (await inject('POST', `/workspaces/${wsId}/databases/${msDb}/records`, {
      values: { name: 'M-active', [msStatusApi]: activeId },
    })).json();
    const inactiveMs = (await inject('POST', `/workspaces/${wsId}/databases/${msDb}/records`, {
      values: { name: 'M-inactive' },
    })).json();

    // Ticket A links an ACTIVE milestone → the linked-record condition matches → fires.
    const ticketA = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Ticket A' } })).json();
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ticketA.id}/links/${hostRelField}`, {
      record_ids: [activeMs.id],
    });
    await engine.settle(ticketA.id);
    await wait(50);
    const aComments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${ticketA.id}/comments`)).json();
    expect(aComments.data.some((c: { body: Array<{ text: string }> }) => c.body[0]?.text === 'Linked to an active milestone')).toBe(true);

    // Ticket B links an INACTIVE milestone → condition fails on the linked record → does NOT fire.
    const ticketB = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Ticket B' } })).json();
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ticketB.id}/links/${hostRelField}`, {
      record_ids: [inactiveMs.id],
    });
    await engine.settle(ticketB.id);
    await wait(50);
    const bComments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${ticketB.id}/comments`)).json();
    expect(bComments.data).toHaveLength(0);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('record_linked direction: a link-only rule fires on link not unlink, and vice versa (#270)', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const relDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Rel-270' })).json().id;
    const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
      database_a_id: dbId,
      database_b_id: relDb,
      cardinality: 'many_to_many',
    })).json();
    const hostRelField = rel.field_a.id;

    const linkRule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'On link only',
      trigger: { type: 'record_linked', relation_field_id: hostRelField, direction: 'link' },
      actions: [{ type: 'add_comment', body_template: 'LINKED' }],
    })).json();
    const unlinkRule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'On unlink only',
      trigger: { type: 'record_linked', relation_field_id: hostRelField, direction: 'unlink' },
      actions: [{ type: 'add_comment', body_template: 'UNLINKED' }],
    })).json();
    expect(linkRule.id, JSON.stringify(linkRule)).toBeTruthy();
    expect(unlinkRule.id, JSON.stringify(unlinkRule)).toBeTruthy();

    const other = (await inject('POST', `/workspaces/${wsId}/databases/${relDb}/records`, { values: { name: 'Other' } })).json();
    const ticket = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Dir ticket' } })).json();

    const textsFor = async () => {
      const c = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}/comments`)).json();
      return c.data.map((x: { body: Array<{ text: string }> }) => x.body[0]?.text);
    };

    // Link → only the link rule fires.
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}/links/${hostRelField}`, { record_ids: [other.id] });
    await engine.settle(ticket.id);
    await wait(50);
    let texts = await textsFor();
    expect(texts.filter((t: string) => t === 'LINKED')).toHaveLength(1);
    expect(texts).not.toContain('UNLINKED');

    // Unlink → only the unlink rule fires; the link rule does NOT fire again.
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${ticket.id}/links/${hostRelField}`, { record_ids: [other.id] });
    await engine.settle(ticket.id);
    await wait(50);
    texts = await textsFor();
    expect(texts.filter((t: string) => t === 'LINKED')).toHaveLength(1); // unchanged
    expect(texts.filter((t: string) => t === 'UNLINKED')).toHaveLength(1);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${linkRule.id}`, { enabled: false });
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${unlinkRule.id}`, { enabled: false });
  });

  it('interpolates tokens into NON-name fields of a create_record action (#339)', async () => {
    // The gap this pins: create_record templated `values.name` and nothing else,
    // so a text field asking for {changesSummary} stored those literal
    // characters — while the run still reported status ok. Only opening the
    // created record revealed it, which is why this asserts on a non-name field.
    const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const targetDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Followups 339',
    })).json();
    const noteField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Note',
      type: 'text',
    })).json();
    expect(noteField.id, JSON.stringify(noteField)).toBeTruthy();

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'File a followup',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        {
          type: 'create_record',
          database_id: targetDb.id,
          values: {
            name: 'Followup for {Name}',
            [noteField.apiName]: 'Ticket #{Number} — {changesSummary}',
          },
        },
      ],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Interpolate me', [stateApi]: urgentId },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    const created = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records/query`, {})).json();
    const row = created.data.find((r: { title: string }) => r.title.includes('Interpolate me'));
    expect(row, JSON.stringify(created.data)).toBeTruthy();

    const note = row.values[noteField.apiName] as string;
    // The literal token text is the bug; its absence is the fix.
    expect(note).not.toContain('{changesSummary}');
    expect(note).not.toContain('{Number}');
    expect(note).toContain('State');
    expect(note).toContain('Done');
    // #339 bug 2: {Number} is a system COLUMN, not a values key — it used to
    // render an em dash.
    expect(note).toContain(`#${rec.number}`);

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('{changesSummary} renders what actually changed, with select labels (#273)', async () => {
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Report the change',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [{ type: 'add_comment', body_template: 'Changed: {changesSummary}' }],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Summarize me', [stateApi]: urgentId },
    })).json();

    // Urgent → Done: the summary names the FIELD and both option LABELS (not ids).
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    const comments = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/comments`)).json();
    const text = comments.data.map((c: { body: Array<{ text: string }> }) => c.body[0]?.text).find((t: string) => t?.startsWith('Changed:'));
    expect(text, JSON.stringify(comments.data)).toBeTruthy();
    expect(text).toContain('State');
    expect(text).toContain('Urgent');
    expect(text).toContain('Done');
    expect(text).not.toContain(urgentId); // labels, never raw option ids

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });
});
