import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';

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
