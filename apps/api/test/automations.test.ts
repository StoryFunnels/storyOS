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

describe('#392 — scheduled rules can carry a sort + limit (top-N leaderboard)', () => {
  let leaderDbId: string;
  let engagementApi: string;

  async function forceDueAndTick(ruleId: string) {
    const { connectTestDb } = await import('./helpers/db');
    const { db, pool } = connectTestDb();
    const { automations } = await import('../src/db/schema');
    const { eq } = await import('drizzle-orm');
    await db.update(automations).set({ nextDueAt: new Date(Date.now() - 1000) }).where(eq(automations.id, ruleId));
    await engine.tick();
    await pool.end();
  }

  beforeAll(async () => {
    leaderDbId = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
      name: 'Leaderboard',
    })).json().id;
    const engagement = (await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/fields`, {
      display_name: 'Engagement', type: 'number', config: {},
    })).json();
    engagementApi = engagement.apiName;
  });

  it('a top-N rule comments on exactly the N highest-engagement records, ranked in order', async () => {
    for (const engagement of [10, 90, 40, 90, 20]) {
      await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/records`, {
        values: { name: `Post ${engagement}`, [engagementApi]: engagement },
      });
    }
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/automations`, {
      name: 'Promote the winners',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      sort: [{ field: engagementApi, direction: 'desc' }],
      limit: 3,
      actions: [{ type: 'add_comment', body_template: 'Top performer!' }],
    })).json();

    await forceDueAndTick(rule.id);

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${leaderDbId}/automations/${rule.id}/runs`)).json();
    const okRuns = runs.data.filter((r: { status: string }) => r.status === 'ok');
    expect(okRuns).toHaveLength(3); // exactly the limit, not every matching record
    // Ranks are exactly 1..3, one each — "why did it pick those" answered directly.
    expect(okRuns.map((r: { selectionRank: number }) => r.selectionRank).sort()).toEqual([1, 2, 3]);

    const records = (await inject('GET', `/workspaces/${wsId}/databases/${leaderDbId}/records?limit=200`)).json().data;
    for (const record of records) {
      const comments = (
        await inject('GET', `/workspaces/${wsId}/databases/${leaderDbId}/records/${record.id}/comments`)
      ).json().data;
      const shouldHaveWon = record.values[engagementApi] >= 40; // the top 3 of [10,90,40,90,20]
      expect(comments.length > 0, `${record.title} (engagement ${record.values[engagementApi]})`).toBe(shouldHaveWon);
    }
  });

  it('ties resolve deterministically by record id, and re-running picks the SAME records', async () => {
    const tiedDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
      name: 'Tied',
    })).json().id;
    const field = (await inject('POST', `/workspaces/${wsId}/databases/${tiedDb}/fields`, {
      display_name: 'Score', type: 'number', config: {},
    })).json();
    // Six records tied for the top spot — "top 5" must pick exactly 5, deterministically.
    for (let i = 0; i < 6; i++) {
      await inject('POST', `/workspaces/${wsId}/databases/${tiedDb}/records`, {
        values: { name: `Tied ${i}`, [field.apiName]: 100 },
      });
    }
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${tiedDb}/automations`, {
      name: 'Top 5 of a 6-way tie',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      sort: [{ field: field.apiName, direction: 'desc' }],
      limit: 5,
      actions: [{ type: 'add_comment', body_template: 'Selected' }],
    })).json();

    await forceDueAndTick(rule.id);
    const firstRuns = (await inject('GET', `/workspaces/${wsId}/databases/${tiedDb}/automations/${rule.id}/runs`)).json();
    const firstPicks = firstRuns.data.filter((r: { status: string }) => r.status === 'ok').map((r: { triggerRecordId: string }) => r.triggerRecordId).sort();
    expect(firstPicks).toHaveLength(5);

    // Force due again — the SAME 5 must be picked (record id ASC tiebreak).
    await forceDueAndTick(rule.id);
    const secondRuns = (await inject('GET', `/workspaces/${wsId}/databases/${tiedDb}/automations/${rule.id}/runs`)).json();
    const secondPicks = secondRuns.data
      .filter((r: { status: string }) => r.status === 'ok')
      .slice(0, 5)
      .map((r: { triggerRecordId: string }) => r.triggerRecordId)
      .sort();
    expect(secondPicks).toEqual(firstPicks);
  });

  it('a sort field deleted after the rule was created fails LOUDLY — an errored run naming the field, nothing selected', async () => {
    const volatileDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
      name: 'Volatile',
    })).json().id;
    const field = (await inject('POST', `/workspaces/${wsId}/databases/${volatileDb}/fields`, {
      display_name: 'Score', type: 'number', config: {},
    })).json();
    await inject('POST', `/workspaces/${wsId}/databases/${volatileDb}/records`, {
      values: { name: 'Should not be touched', [field.apiName]: 50 },
    });
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${volatileDb}/automations`, {
      name: 'Depends on a field about to vanish',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      sort: [{ field: field.apiName, direction: 'desc' }],
      limit: 5,
      actions: [{ type: 'add_comment', body_template: 'Selected' }],
    })).json();
    await inject('DELETE', `/workspaces/${wsId}/databases/${volatileDb}/fields/${field.id}`);

    await forceDueAndTick(rule.id);

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${volatileDb}/automations/${rule.id}/runs`)).json();
    expect(runs.data).toHaveLength(1);
    expect(runs.data[0].status).toBe('error');
    expect(runs.data[0].error).toContain(field.apiName); // names the field, not a generic failure
    expect(runs.data[0].triggerRecordId).toBeNull(); // rule-level failure, not attributed to any one record
  });

  it('sort/limit are rejected on a record-triggered rule — top-N has no meaning for a single record', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/automations`, {
      name: 'Invalid: top-N on record_created',
      trigger: { type: 'record_created' },
      sort: [{ field: engagementApi, direction: 'desc' }],
      limit: 5,
      actions: [{ type: 'add_comment', body_template: 'x' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('limit above the hard ceiling is rejected at create time', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/automations`, {
      name: 'Invalid: limit over ceiling',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      sort: [{ field: engagementApi, direction: 'desc' }],
      limit: 100_000,
      actions: [{ type: 'add_comment', body_template: 'x' }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('patching sort/limit onto a rule whose STORED trigger is not schedule is rejected too', async () => {
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${leaderDbId}/automations`, {
      name: 'Plain record-created rule',
      trigger: { type: 'record_created' },
      actions: [{ type: 'add_comment', body_template: 'x' }],
    })).json();
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${leaderDbId}/automations/${rule.id}`, {
      sort: [{ field: engagementApi, direction: 'desc' }],
      limit: 3,
    });
    expect(res.statusCode).toBe(422);
  });

  it('MUST KEEP WORKING: a scheduled rule with no sort/limit behaves exactly as before — every matching record runs, unranked', async () => {
    const plainDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
      name: 'Plain schedule',
    })).json().id;
    for (let i = 0; i < 4; i++) {
      await inject('POST', `/workspaces/${wsId}/databases/${plainDb}/records`, { values: { name: `Rec ${i}` } });
    }
    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${plainDb}/automations`, {
      name: 'No sort, no limit',
      trigger: { type: 'schedule', every: 'day', at: '09:00' },
      actions: [{ type: 'add_comment', body_template: 'Swept' }],
    })).json();
    expect(rule.sort ?? null).toBeNull();
    expect(rule.topNLimit ?? null).toBeNull();

    await forceDueAndTick(rule.id);

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${plainDb}/automations/${rule.id}/runs`)).json();
    const ok = runs.data.filter((r: { status: string }) => r.status === 'ok');
    expect(ok).toHaveLength(4); // every record, not top-N
    expect(ok.every((r: { selectionRank: number | null }) => r.selectionRank === null)).toBe(true);
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

  it('computes a number field from an expression (#342)', async () => {
    // Automations could set a number to a CONSTANT or copy one verbatim, but
    // never compute one: "{Remaining} - 1" was substituted to the text "4 - 1"
    // and the write failed validation. So a counter or a countdown — the most
    // ordinary rules there are — could not be written at all.
    const counter = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Times Contacted',
      type: 'number',
    })).json();
    const trigger = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Ping',
      type: 'text',
    })).json();

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Increment on ping',
      trigger: { type: 'record_updated', field_id: trigger.id },
      actions: [{ type: 'set_values', values: { [counter.apiName]: '{Times Contacted} + 1' } }],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Counts up', [counter.apiName]: 4 },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [trigger.apiName]: 'ping' },
    });
    await engine.settle(rec.id);
    await wait(80);

    const read = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    expect(read.values[counter.apiName], JSON.stringify(read.values)).toBe(5);

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

  it('leaves a TEXT field literal — only numbers are computed (#342)', async () => {
    // The regression this guards: text templating must keep doing exactly what
    // it did, or every existing rule that writes text changes meaning.
    const label = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Label 342',
      type: 'text',
    })).json();
    const trigger2 = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Ping2',
      type: 'text',
    })).json();

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Label it',
      trigger: { type: 'record_updated', field_id: trigger2.id },
      actions: [{ type: 'set_values', values: { [label.apiName]: '{Name} - 1' } }],
    })).json();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Widget' },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [trigger2.apiName]: 'ping' },
    });
    await engine.settle(rec.id);
    await wait(80);

    const read = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    // Literal substitution, NOT arithmetic — "Widget - 1", not an error or a number.
    expect(read.values[label.apiName]).toBe('Widget - 1');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
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

  it('a converging create loop finishes and stops on its own — no false loop-block (#246)', async () => {
    /*
     * #246's last acceptance criterion, and the case the ticket was opened for:
     * "create one Day per missing sprint day" written the way an author
     * naturally writes it — a rule that creates a record AND decrements the
     * very count that triggers it. That is a self-trigger, so before #275's
     * convergence guard the flat MAX_DEPTH=2 stopped it after two Days and the
     * author saw a loop-block on work that was never runaway.
     *
     * What this asserts is the whole point of the pair: the chain runs to
     * completion (five Days, not two), it stops because the RULE's own
     * condition stops matching — not because the guard cut it off — and the
     * run log contains no skip at all. `create_records` (above) sidesteps this
     * shape entirely; this test covers the shape itself, which is what the
     * community thread was actually stuck on.
     */
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const sprintDaysDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Sprint Days' })).json().id;
    const remaining = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Remaining',
      type: 'number',
      config: {},
    })).json();
    const remainingApi = remaining.apiName;

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Fill sprint days',
      trigger: { type: 'record_updated', field_id: remaining.id },
      // The stop condition is the author's, not the engine's.
      condition: { field: remainingApi, op: 'gt', value: 0 },
      actions: [
        { type: 'create_record', database_id: sprintDaysDb, values: { name: 'Day {Remaining}' } },
        // #342 — computed, because Remaining is a number field.
        { type: 'set_values', values: { [remainingApi]: '{Remaining} - 1' } },
      ],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const sprint = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Sprint 2', [remainingApi]: 0 },
    })).json();
    // The user edit that starts the chain: five days to fill.
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${sprint.id}`, {
      values: { [remainingApi]: 5 },
    });
    // Drain generously — the chain is five links deep, well past MAX_DEPTH.
    for (let i = 0; i < 30; i++) {
      await engine.settle(sprint.id);
      await wait(30);
    }

    const days = (await inject('POST', `/workspaces/${wsId}/databases/${sprintDaysDb}/records/query`, {})).json();
    expect(days.data.map((r: { title: string }) => r.title).sort(), 'one Day per missing day, not MAX_DEPTH of them').toEqual([
      'Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5',
    ]);

    // It stopped because Remaining reached 0, and it stopped there exactly.
    const after = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${sprint.id}`)).json();
    expect(after.values[remainingApi]).toBe(0);

    const runs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)).json();
    const skipped = runs.data.filter((r: { status: string }) => r.status === 'skipped');
    expect(skipped, 'a converging chain must never be loop-blocked').toEqual([]);
    expect(runs.data.filter((r: { status: string }) => r.status === 'ok')).toHaveLength(5);

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

describe('#230 create_record upsert — updates-or-skips a matching record instead of duplicating', () => {
  it('rejects a key_field_id that is not marked unique', async () => {
    const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const targetDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Contacts 230a',
    })).json();
    const emailField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Email',
      type: 'text',
      // deliberately NOT unique
    })).json();

    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Upsert without a unique key',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        {
          type: 'create_record',
          database_id: targetDb.id,
          values: { name: '{Name}', [emailField.apiName]: '{Name}@example.com' },
          upsert: { key_field_id: emailField.id },
        },
      ],
    });
    expect(res.statusCode).toBe(422);
    expect(res.body.toLowerCase()).toContain('unique');
  });

  it('updates the matching record instead of duplicating (default on_match)', async () => {
    const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const targetDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Contacts 230b',
    })).json();
    const emailField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Email',
      type: 'text',
      config: { unique: true },
    })).json();
    const tagField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Tag',
      type: 'text',
    })).json();

    const existing = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records`, {
      values: { name: 'Old Name', [emailField.apiName]: 'match@example.com', [tagField.apiName]: 'original' },
    })).json();

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Upsert on email — update',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        {
          type: 'create_record',
          database_id: targetDb.id,
          values: {
            name: '{Name}',
            [emailField.apiName]: 'match@example.com',
            [tagField.apiName]: 'refreshed',
          },
          upsert: { key_field_id: emailField.id, on_match: 'update' },
        },
      ],
    })).json();
    expect(rule.id, JSON.stringify(rule)).toBeTruthy();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Trigger 230b', [stateApi]: urgentId },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    // No duplicate — still exactly one record in the target database.
    const all = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records/query`, {})).json();
    expect(all.data).toHaveLength(1);

    const updated = (await inject('GET', `/workspaces/${wsId}/databases/${targetDb.id}/records/${existing.id}`)).json();
    expect(updated.values[tagField.apiName]).toBe('refreshed');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('leaves the matching record untouched when on_match is "skip"', async () => {
    const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const targetDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Contacts 230c',
    })).json();
    const emailField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Email',
      type: 'text',
      config: { unique: true },
    })).json();
    const tagField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Tag',
      type: 'text',
    })).json();

    await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records`, {
      values: { name: 'Keep Me', [emailField.apiName]: 'skip@example.com', [tagField.apiName]: 'untouched' },
    });

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Upsert on email — skip',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        {
          type: 'create_record',
          database_id: targetDb.id,
          values: {
            name: 'Should not overwrite',
            [emailField.apiName]: 'skip@example.com',
            [tagField.apiName]: 'would-be-overwritten',
          },
          upsert: { key_field_id: emailField.id, on_match: 'skip' },
        },
      ],
    })).json();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Trigger 230c', [stateApi]: urgentId },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    const all = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records/query`, {})).json();
    expect(all.data).toHaveLength(1);
    expect(all.data[0].title).toBe('Keep Me');
    expect(all.data[0].values[tagField.apiName]).toBe('untouched');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });

  it('creates a new record when nothing matches the key', async () => {
    const space = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const targetDb = (await inject('POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Contacts 230d',
    })).json();
    const emailField = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/fields`, {
      display_name: 'Email',
      type: 'text',
      config: { unique: true },
    })).json();

    const rule = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Upsert on email — no match yet',
      trigger: { type: 'record_updated', field_id: stateFieldId },
      actions: [
        {
          type: 'create_record',
          database_id: targetDb.id,
          values: { name: 'Brand New', [emailField.apiName]: 'new-230d@example.com' },
          upsert: { key_field_id: emailField.id },
        },
      ],
    })).json();

    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Trigger 230d', [stateApi]: urgentId },
    })).json();
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`, {
      values: { [stateApi]: doneId },
    });
    await engine.settle(rec.id);
    await wait(50);

    const all = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records/query`, {})).json();
    expect(all.data).toHaveLength(1);
    expect(all.data[0].title).toBe('Brand New');

    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}`, { enabled: false });
  });
});
