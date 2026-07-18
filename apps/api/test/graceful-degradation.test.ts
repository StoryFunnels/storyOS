import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { billingSubscriptions } from '../src/db/schema';

/**
 * MN-193 — "never hold data hostage" is a positioning statement as much as a
 * behavior: a delinquent or canceled workspace must stay fully readable,
 * writable and exportable. Nothing in records/databases/export references
 * billing at all (grep-verified) — this test proves that with real HTTP
 * calls against a workspace whose billing_subscriptions row is directly
 * forced into 'past_due' and 'canceled', bypassing Stripe entirely (self-host
 * mode in tests has no real Stripe to drive these states through normally).
 */

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let recordId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

async function setBillingStatus(plan: 'pro' | 'free', status: string) {
  await db
    .insert(billingSubscriptions)
    .values({ workspaceId: wsId, plan, status: status as never, seats: 0 })
    .onConflictDoUpdate({ target: billingSubscriptions.workspaceId, set: { plan, status: status as never } });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'DegradationAdmin');
  wsId = (await as('POST', '/workspaces', { name: 'Degradation WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
  recordId = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Keep me' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('MN-193 — a past_due (dunning) workspace stays fully functional', () => {
  it('reads, writes and creates records exactly as normal', async () => {
    await setBillingStatus('pro', 'past_due');

    const read = await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().title).toBe('Keep me');

    const write = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { name: 'Still editable' },
    });
    expect(write.statusCode, write.body).toBe(200);

    const create = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'New during dunning' },
    });
    expect(create.statusCode, create.body).toBe(201);
  });

  it('CSV export still works', async () => {
    const res = await as('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Still editable');
  });
});

describe('MN-193 — a canceled (fully downgraded) workspace stays fully functional', () => {
  it('reads, writes and creates records exactly as normal', async () => {
    await setBillingStatus('free', 'canceled');

    const read = await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`);
    expect(read.statusCode, read.body).toBe(200);

    const write = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { name: 'Edited after cancellation' },
    });
    expect(write.statusCode, write.body).toBe(200);

    const create = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
      values: { name: 'Created after cancellation' },
    });
    expect(create.statusCode, create.body).toBe(201);
  });

  it('CSV export still works — canceling is never punished with a data lockout', async () => {
    const res = await as('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Edited after cancellation');
  });

  it('the database itself is not deleted or hidden', async () => {
    const res = await as('GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(res.statusCode, res.body).toBe(200);
  });
});
