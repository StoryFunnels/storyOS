import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automationJobs } from '../src/db/schema';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { AiFieldSubscriber } from '../src/records/ai-field.subscriber';
import type { ManagedAiClient, ManagedAiCompletion } from '../src/agents/managed-ai-client';

/**
 * #571 — AI-computed fields, end to end against a real Postgres. Exercises:
 * field-config validation (unknown field ref, self-reference, a 2-field
 * cycle through dependency_field_ids); the write-triggers-recompute pipeline
 * (create AND a dependency-field update, via the real domain-event ->
 * durable-job-queue path, never on read); a fixed-choice output rejecting a
 * model response outside the configured set (stored as an error, not a
 * value); and a formula reading the ai field's stored value like any other
 * field.
 *
 * The model call itself is faked via AiFieldSubscriber's own swappable
 * `client` property (same seam ManagedAiProposer/Tyron's chat client use) —
 * no real OpenAI call in this suite.
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let subscriber: AiFieldSubscriber;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: (payload ?? {}) as never,
  });
}

function fakeClient(text: string): ManagedAiClient {
  return {
    complete: async (): Promise<ManagedAiCompletion> => ({ text, tokensIn: 10, tokensOut: 5 }),
  };
}

/** Polls for the ai_field_recompute job the fire-and-forget domain-event
 * handler enqueues, then runs it — same async-wait convention
 * write-back-approval-gate.test.ts's waitForRuns() uses for its own
 * fire-and-forget subscriber. Matches on status 'queued' (never a row this
 * function has already ticked), since completed jobs are kept around for
 * history and a bare recordId/fieldId match would otherwise re-find and
 * no-op-tick the PRIOR call's already-succeeded row instead of waiting for
 * the new one — exactly the race a second call in the same test hits. */
async function waitForJobAndTick(recordId: string, fieldId: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const rows = await db.query.automationJobs.findMany({
      where: and(eq(automationJobs.kind, 'ai_field_recompute'), eq(automationJobs.status, 'queued')),
    });
    const match = rows.find((r) => {
      const p = r.payload as { recordId?: string; fieldId?: string };
      return p.recordId === recordId && p.fieldId === fieldId;
    });
    if (match) {
      await jobs.tick();
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no queued ai_field_recompute job found for record ${recordId} / field ${fieldId}`);
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  subscriber = app.get(AiFieldSubscriber);

  admin = await signUpUser(app, 'AiFieldOwner');
  wsId = (await inject('POST', '/workspaces', { name: 'AI Fields WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
});

afterAll(async () => {
  await app.close();
});

async function addField(display_name: string, type: string, config: Record<string, unknown> = {}) {
  const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name, type, config });
  return { id: res.json().id as string, apiName: res.json().apiName as string, status: res.statusCode, body: res.body };
}

describe('#571 AI-computed field: config validation', () => {
  it('rejects a prompt referencing an unknown field', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Bad AI Field',
      type: 'ai',
      config: { prompt: 'Summarize {Nonexistent Field}', output: { kind: 'text' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Nonexistent Field');
  });

  it('rejects an AI field that references its own field', async () => {
    const summary = await addField('Self Ref', 'ai', { prompt: 'placeholder', output: { kind: 'text' } });
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${summary.id}`, {
      config: { prompt: `Say hi to {${'Self Ref'}}`, output: { kind: 'text' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body.toLowerCase()).toContain('own field');
  });

  it('rejects a 2-field AI cycle (A depends on B, then B is edited to depend on A)', async () => {
    await addField('Notes AI1', 'text');
    const a = await addField('AI A', 'ai', { prompt: 'Read {Notes AI1}', output: { kind: 'text' } });
    expect(a.status, a.body).toBe(201);
    const b = await addField('AI B', 'ai', { prompt: `Read {AI A}`, output: { kind: 'text' } });
    expect(b.status, b.body).toBe(201);
    // Now try to make A depend on B — A -> B -> A is a cycle.
    const res = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${a.id}`, {
      config: { prompt: 'Read {AI B}', output: { kind: 'text' } },
    });
    expect(res.statusCode).toBe(422);
    expect(res.body.toLowerCase()).toContain('cycle');
  });

  it('rejects a prompt referencing a formula field — recompute cannot observe its writes', async () => {
    const raw = await addField('Raw AI2b', 'number');
    const formula = await addField('Doubled AI2b', 'formula', { expression: `{Raw AI2b} * 2` });
    expect(formula.status, formula.body).toBe(201);
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Summary AI2b',
      type: 'ai',
      config: { prompt: 'Describe {Doubled AI2b}', output: { kind: 'text' } },
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body.toLowerCase()).toContain('computed field');
    expect(raw.status).toBe(201);
  });

  it('creates a valid AI field and compiles dependency_field_ids', async () => {
    const dep = await addField('Company AI2', 'text');
    const field = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Tier AI2',
      type: 'ai',
      config: { prompt: 'Classify {Company AI2}', output: { kind: 'choice', options: ['A', 'B', 'C'] } },
    });
    expect(field.statusCode, field.body).toBe(201);
    expect((field.json().config as { dependency_field_ids: string[] }).dependency_field_ids).toEqual([dep.id]);
  });
});

describe('#571 AI-computed field: recompute is triggered by a write, never by a read', () => {
  it('recomputes on record CREATE — every ai field is a candidate since a fresh record has no prior value', async () => {
    const company = await addField('Company AI3', 'text');
    const tier = await addField('Tier AI3', 'ai', {
      prompt: 'Classify {Company AI3}',
      output: { kind: 'choice', options: ['Enterprise', 'SMB'] },
    });
    subscriber.client = fakeClient('Enterprise');

    const rec = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Acme', [company.apiName]: 'Acme Corp' },
    });
    await waitForJobAndTick(rec.json().id, tier.id);

    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`);
    expect(after.json().values[tier.apiName]).toBe('Enterprise');
  });

  it('recomputes when a DEPENDENCY field is written on an existing record', async () => {
    const company = await addField('Company AI4', 'text');
    const tier = await addField('Tier AI4', 'ai', {
      prompt: 'Classify {Company AI4}',
      output: { kind: 'choice', options: ['Enterprise', 'SMB'] },
    });
    subscriber.client = fakeClient('SMB');
    const rec = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Initial' } });
    await waitForJobAndTick(rec.json().id, tier.id); // the create-triggered run — drain it first

    subscriber.client = fakeClient('Enterprise');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`, {
      values: { [company.apiName]: 'Big Co' },
    });
    await waitForJobAndTick(rec.json().id, tier.id);

    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`);
    expect(after.json().values[tier.apiName]).toBe('Enterprise');
  });

  it('does NOT recompute when an UNRELATED field is written', async () => {
    const company = await addField('Company AI5', 'text');
    const unrelated = await addField('Unrelated AI5', 'text');
    const tier = await addField('Tier AI5', 'ai', {
      prompt: 'Classify {Company AI5}',
      output: { kind: 'text' },
    });
    subscriber.client = fakeClient('first value');
    const rec = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'X', [company.apiName]: 'Y' },
    });
    await waitForJobAndTick(rec.json().id, tier.id);

    subscriber.client = fakeClient('SHOULD NOT APPEAR');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`, {
      values: { [unrelated.apiName]: 'changed' },
    });
    await new Promise((r) => setTimeout(r, 200));
    await jobs.tick();

    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`);
    expect(after.json().values[tier.apiName]).toBe('first value');
  });
});

describe('#571 AI-computed field: fixed-choice output validation', () => {
  it('a model response outside the configured choices is stored as an error, not a value', async () => {
    const company = await addField('Company AI6', 'text');
    const tier = await addField('Tier AI6', 'ai', {
      prompt: 'Classify {Company AI6}',
      output: { kind: 'choice', options: ['Enterprise', 'SMB'] },
    });
    subscriber.client = fakeClient('Not A Real Choice');
    const rec = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Z', [company.apiName]: 'Z Corp' },
    });
    await waitForJobAndTick(rec.json().id, tier.id);

    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`);
    expect(after.json().values[tier.apiName]).toBeUndefined();

    const row = await db.query.records.findFirst({ where: (r, { eq: eqOp }) => eqOp(r.id, rec.json().id) });
    const computed = row!.computedValues as Record<string, unknown>;
    expect(computed[`${tier.id}:error`]).toContain('not one of the configured choices');
  });
});

describe('#571 AI-computed field: readable by a formula like any other field', () => {
  it('a formula referencing an ai field resolves its stored value', async () => {
    const company = await addField('Company AI7', 'text');
    const tier = await addField('Tier AI7', 'ai', {
      prompt: 'Classify {Company AI7}',
      output: { kind: 'text' },
    });
    subscriber.client = fakeClient('Gold');
    const rec = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'F', [company.apiName]: 'F Inc' },
    });
    await waitForJobAndTick(rec.json().id, tier.id);

    const formula = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Tier Label AI7',
      type: 'formula',
      config: { expression: `"Tier: " + {Tier AI7}` },
    });
    expect(formula.statusCode, formula.body).toBe(201);

    const after = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.json().id}`);
    expect(after.json().values[formula.json().apiName]).toBe('Tier: Gold');
  });
});
