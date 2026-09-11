/**
 * #694 — durable, resumable bulk record jobs, the remaining half of #653's
 * chunking AC. Exercises: enqueue -> chunked processing via repeated tick()
 * calls -> final status; per-record failure reporting without losing
 * already-succeeded work; the restorable list feeding undo_batch_update's
 * REST sibling; and the actual resumability guarantee — a job stuck
 * 'running' (the process died mid-chunk) is reaped back to 'queued' and
 * resumes from its persisted cursor, not from scratch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { connectTestDb } from './helpers/db';
import { bulkRecordJobs } from '../src/db/schema';
import { BulkRecordJobsService } from '../src/records/bulk-record-jobs.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let jobs: BulkRecordJobsService;
const { db } = connectTestDb();

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function makeRecords(n: number, name = 'Bulk694') {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push((await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: `${name} ${i}` } })).json().id);
  }
  return ids;
}

/** Drain a job to a terminal status by calling tick() directly rather than
 *  waiting on the real 2s timer (mirrors JobRunnerService's own test convention). */
async function drain(maxTicks = 50) {
  for (let i = 0; i < maxTicks; i++) {
    await jobs.tick();
  }
}

beforeAll(async () => {
  app = await createTestApp();
  jobs = app.get(BulkRecordJobsService);
  admin = await signUpUser(app, 'BulkJobs694');
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '694 WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Bulk694 DB' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#694: enqueue + poll', () => {
  it('an update job processes every record across multiple chunks and reports succeeded', async () => {
    const ids = await makeRecords(450); // > one 200-chunk, forces multiple ticks
    const enqueue = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs`, {
      op: 'update',
      record_ids: ids,
      values: { name: 'Renamed by job' },
    });
    expect(enqueue.statusCode, enqueue.body).toBeLessThan(300);
    const jobId = enqueue.json().id;
    expect(enqueue.json().status).toBe('queued');
    expect(enqueue.json().total).toBe(450);

    await drain();

    const status = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs/${jobId}`)).json();
    expect(status.status).toBe('succeeded');
    expect(status.processed).toBe(450);
    expect(status.succeeded).toBe(450);
    expect(status.failed).toHaveLength(0);
    expect(status.restorable).toHaveLength(450);

    const check = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}`);
    expect(check.json().title).toBe('Renamed by job');
  });

  it('a delete job soft-deletes every record and reports succeeded', async () => {
    const ids = await makeRecords(30, 'DeleteMe694');
    const enqueue = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs`, {
      op: 'delete',
      record_ids: ids,
    });
    expect(enqueue.statusCode, enqueue.body).toBeLessThan(300);
    const jobId = enqueue.json().id;
    await drain();

    const status = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs/${jobId}`)).json();
    expect(status.status).toBe('succeeded');
    expect(status.succeeded).toBe(30);

    const check = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}`);
    expect(check.statusCode).toBe(404);
  });

  it('never silent partial completion: a failed id is reported, and the rest still succeed', async () => {
    const ids = await makeRecords(3, 'PartialFail694');
    const ghost = '00000000-0000-4000-8000-000000000694';
    const enqueue = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs`, {
      op: 'update',
      record_ids: [...ids, ghost],
      values: { name: 'Should mostly work' },
    });
    const jobId = enqueue.json().id;
    await drain();

    const status = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs/${jobId}`)).json();
    expect(status.status).toBe('partially_failed');
    expect(status.succeeded).toBe(3);
    expect(status.failed).toHaveLength(1);
    expect(status.failed[0].record_id).toBe(ghost);
    expect(status.processed).toBe(4);
  });

  it('the restorable list from a job works with the same undo endpoint #653 built', async () => {
    const ids = await makeRecords(2, 'UndoMe694');
    const enqueue = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs`, {
      op: 'update',
      record_ids: ids,
      values: { name: 'Changed for undo' },
    });
    await drain();
    const status = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs/${enqueue.json().id}`)).json();

    const undo = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-update-undo`, {
      restorable: status.restorable,
    });
    expect(undo.statusCode, undo.body).toBeLessThan(300);
    expect(undo.json().restored).toBe(2);

    const check = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${ids[0]}`);
    expect(check.json().title).toBe('UndoMe694 0');
  });

  it('MUST KEEP WORKING: the synchronous batch endpoint is unchanged and still available', async () => {
    const ids = await makeRecords(2, 'StillSync694');
    const res = await as(admin.token, 'PATCH', `/workspaces/${wsId}/databases/${dbId}/records/batch`, {
      record_ids: ids,
      values: { name: 'Sync patch' },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(res.json().updated).toBe(2);
  });
});

describe('#694: resumability — a crashed job resumes from its cursor, not from scratch', () => {
  it('a job stuck "running" past the reap window is reverted to "queued" and the NEXT tick continues from the persisted cursor', async () => {
    const ids = await makeRecords(250, 'Resume694'); // > one chunk (200)
    const enqueue = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records/batch-jobs`, {
      op: 'update',
      record_ids: ids,
      values: { name: 'Resumed' },
    });
    const jobId = enqueue.json().id;

    // Process exactly the first chunk (one tick), then simulate a crash: the
    // row is stuck 'running' with a stale started_at, as if the process died
    // right after claiming it for what WOULD be the second chunk.
    await jobs.tick();
    const midway = await db.query.bulkRecordJobs.findFirst({ where: eq(bulkRecordJobs.id, jobId) });
    expect(midway!.cursor).toBe(200); // first chunk done, persisted

    await db
      .update(bulkRecordJobs)
      .set({ status: 'running', startedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(bulkRecordJobs.id, jobId));

    // reap() (called at the top of every tick) must revert it, and the same
    // tick then resumes it from cursor=200 — NOT from 0.
    await jobs.tick();
    const afterReap = await db.query.bulkRecordJobs.findFirst({ where: eq(bulkRecordJobs.id, jobId) });
    expect(afterReap!.cursor).toBe(250); // second (final, 50-record) chunk done
    expect(afterReap!.status).toBe('succeeded');
    expect(afterReap!.succeeded).toBe(250); // not double-counted from re-processing chunk 1
  });
});
