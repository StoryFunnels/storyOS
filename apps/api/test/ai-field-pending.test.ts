import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automationJobs, records as recordsTable } from '../src/db/schema';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { AiFieldSubscriber } from '../src/records/ai-field.subscriber';
import { AI_PENDING_STALE_MS, pendingAtKey, withoutStalePending } from '../src/records/ai-field-state';
import type { ManagedAiClient, ManagedAiCompletion } from '../src/agents/managed-ai-client';

/**
 * #925 — the API says a record's AI field is IN FLIGHT: `computed_values["<field_id>:pending_at"]`, written when the recompute is
 * enqueued, cleared when the job ends (success or failure), and read as not-pending once older than AI_PENDING_STALE_MS so a
 * worker that died mid-job cannot leave a cell "computing" for ever.
 */
let app: NestFastifyApplication;
let db: Db;
let jobs: JobRunnerService;
let subscriber: AiFieldSubscriber;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let dbId: string;
let plainDbId: string;

const inject = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });
const fakeClient = (text: string): ManagedAiClient => ({ complete: async (): Promise<ManagedAiCompletion> => ({ text, tokensIn: 1, tokensOut: 1 }) });
const failingClient = (message: string): ManagedAiClient => ({ complete: async () => { throw new Error(message); } });

async function queuedJob(recordId: string, fieldId: string) {
  for (let i = 0; i < 60; i++) {
    const rows = await db.query.automationJobs.findMany({ where: and(eq(automationJobs.kind, 'ai_field_recompute'), eq(automationJobs.status, 'queued')) });
    const match = rows.find((r) => { const p = r.payload as { recordId?: string; fieldId?: string }; return p.recordId === recordId && p.fieldId === fieldId; });
    if (match) return match;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('no queued job');
}
const computed = async (recordId: string, token = admin.token) =>
  (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, undefined, token)).json().computed_values as Record<string, unknown>;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  jobs = app.get(JobRunnerService);
  subscriber = app.get(AiFieldSubscriber);
  admin = await signUpUser(app, 'AiPendingOwner');
  guest = await signUpUser(app, 'AiPendingGuest');
  wsId = (await inject('POST', '/workspaces', { name: 'AI Pending WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })).json().id;
  plainDbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'No AI here' })).json().id;
  const other = (await inject('POST', `/workspaces/${wsId}/spaces`, { name: 'Guest space' })).json().id;
  const inv = await inject('POST', `/workspaces/${wsId}/invites`, { email: guest.email, role: 'guest', grants: [{ space_id: other, role: 'viewer' }] });
  expect(inv.statusCode, inv.body).toBe(201);
  expect((await inject('POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! }, guest.token)).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

let counter = 0;
async function aiField(opts: { kind?: 'text' | 'choice' } = {}) {
  const n = ++counter;
  const dep = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: `Company P${n}`, type: 'text', config: {} })).json();
  const out = opts.kind === 'choice' ? { kind: 'choice', options: ['A', 'B'] } : { kind: 'text' };
  const ai = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: `Summary P${n}`, type: 'ai', config: { prompt: `Summarise {Company P${n}}`, output: out } })).json();
  return { depApi: dep.apiName as string, aiId: ai.id as string, aiApi: ai.apiName as string };
}
async function settledRecord(field: { aiId: string }, client: ManagedAiClient) {
  subscriber.client = client;
  const rec = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: `Rec ${++counter}` } })).json();
  await queuedJob(rec.id, field.aiId);
  await jobs.tick();
  return rec.id as string;
}

describe('#925 the pending marker', () => {
  it('HAPPY PATH: editing a dependency sets the marker before the job runs; a GET returns it; success clears it and sets the value', async () => {
    const f = await aiField();
    const id = await settledRecord(f, fakeClient('first'));
    expect(await computed(id), 'a settled record is not pending').not.toHaveProperty(pendingAtKey(f.aiId));
    subscriber.client = fakeClient('second');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'Acme' } });
    await queuedJob(id, f.aiId); // the job exists, has NOT run
    const during = await computed(id);
    expect(typeof during[pendingAtKey(f.aiId)], 'pending_at is an ISO timestamp').toBe('string');
    expect(Number.isNaN(Date.parse(during[pendingAtKey(f.aiId)] as string))).toBe(false);
    const row = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${id}`)).json();
    expect(row.values[f.aiApi], 'the last good value is still served while pending').toBe('first');
    await jobs.tick();
    const after = await computed(id);
    expect(after).not.toHaveProperty(pendingAtKey(f.aiId));
    expect(after[f.aiId]).toBe('second');
    expect(typeof after[`${f.aiId}:computed_at`]).toBe('string');
    expect(after[`${f.aiId}:error`]).toBeNull();
  });

  it('FAILURE PATH: the marker clears and the error state is set, the last good value kept; never left pending', async () => {
    const f = await aiField();
    const id = await settledRecord(f, fakeClient('good value'));
    subscriber.client = failingClient('provider exploded');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'x' } });
    await queuedJob(id, f.aiId);
    expect(await computed(id)).toHaveProperty(pendingAtKey(f.aiId));
    await jobs.tick();
    const after = await computed(id);
    expect(after, 'the job failed: the marker must not stay set').not.toHaveProperty(pendingAtKey(f.aiId));
    expect(after[`${f.aiId}:error`]).toContain('provider exploded');
    expect(after[f.aiId], 'last good value kept').toBe('good value');
  });

  it('a model answer outside the configured choices also clears the marker and records the error', async () => {
    const f = await aiField({ kind: 'choice' });
    const id = await settledRecord(f, fakeClient('A'));
    subscriber.client = fakeClient('not a choice');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'y' } });
    await queuedJob(id, f.aiId);
    await jobs.tick();
    const after = await computed(id);
    expect(after).not.toHaveProperty(pendingAtKey(f.aiId));
    expect(String(after[`${f.aiId}:error`])).toContain('not one of the configured choices');
  });

  it('STALE CUTOFF: a worker killed mid-flight leaves a marker that reads as not-pending once it is older than the cutoff, and as pending while fresh', async () => {
    const f = await aiField();
    const id = await settledRecord(f, fakeClient('v'));
    subscriber.client = fakeClient('w');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'z' } });
    await queuedJob(id, f.aiId); // the job is never ticked: the worker "died" before finishing
    const setAge = (ms: number) => db.update(recordsTable).set({ computedValues: sql`${recordsTable.computedValues} || ${JSON.stringify({ [pendingAtKey(f.aiId)]: new Date(Date.now() - ms).toISOString() })}::jsonb` }).where(eq(recordsTable.id, id));
    await setAge(60_000);
    expect(await computed(id), 'one minute old: still pending').toHaveProperty(pendingAtKey(f.aiId));
    await setAge(AI_PENDING_STALE_MS + 60_000);
    expect(await computed(id), 'older than the cutoff: not pending').not.toHaveProperty(pendingAtKey(f.aiId));
  });

  it('a job that started BEFORE a newer edit cannot clear the newer edit\'s marker', async () => {
    const f = await aiField();
    const id = await settledRecord(f, fakeClient('v0'));
    subscriber.client = fakeClient('v1');
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'one' } });
    const job1 = await queuedJob(id, f.aiId);
    await new Promise((r) => setTimeout(r, 15));
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'two' } });
    const markerTwo = (await computed(id))[pendingAtKey(f.aiId)];
    expect((job1.payload as { pendingAt: string }).pendingAt).not.toBe(markerTwo);
    // the older job finishes while the newer edit is still waiting
    await (subscriber as unknown as { recompute: (p: unknown, h: unknown) => Promise<unknown> }).recompute(job1.payload, {});
    const mid = await computed(id);
    expect(mid[pendingAtKey(f.aiId)], 'the newer edit is still pending').toBe(markerTwo);
    expect(mid[f.aiId]).toBe('v1');
  });

  it('AUTHZ: a caller without read access to the record gets no marker (404, and the body names nothing)', async () => {
    const f = await aiField();
    const id = await settledRecord(f, fakeClient('s'));
    await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, { values: { [f.depApi]: 'q' } });
    await queuedJob(id, f.aiId);
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${id}`, undefined, guest.token);
    expect(res.statusCode, res.body).toBe(404);
    expect(res.body).not.toContain('pending_at');
  });

  it('MUST KEEP WORKING: a record in a database with no AI field has no marker, and a formula still resolves', async () => {
    const rec = (await inject('POST', `/workspaces/${wsId}/databases/${plainDbId}/records`, { values: { name: 'Plain' } })).json();
    const row = (await inject('GET', `/workspaces/${wsId}/databases/${plainDbId}/records/${rec.id}`)).json();
    expect(Object.keys(row.computed_values ?? {}).filter((k) => k.endsWith(':pending_at'))).toEqual([]);
  });
});

describe('#925 withoutStalePending (pure)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  it('keeps a fresh marker, drops a stale, malformed or non-string one, and leaves every other key alone', () => {
    const input = { 'a:pending_at': iso(1000), 'b:pending_at': iso(AI_PENDING_STALE_MS + 1), 'c:pending_at': 'soon', 'd:pending_at': 5, 'a': 'value', 'a:error': null, 'a:computed_at': iso(10) };
    const out = withoutStalePending(input, now);
    expect(Object.keys(out).sort()).toEqual(['a', 'a:computed_at', 'a:error', 'a:pending_at']);
  });
  it('returns the very same object when there is nothing to drop (no allocation for records with no AI fields)', () => {
    const plain = { x: 1 };
    expect(withoutStalePending(plain, now)).toBe(plain);
    expect(withoutStalePending(undefined, now)).toEqual({});
  });
});
