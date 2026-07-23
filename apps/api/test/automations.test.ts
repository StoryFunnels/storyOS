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
});
