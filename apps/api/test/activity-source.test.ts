import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';
import { DB } from '../src/db/db.module';
import { activityEvents } from '../src/db/schema';
import type { Db } from '../src/db/client';

/**
 * #481 — activity_events had no `source` column at all: the activity panel
 * would say "Ievgen Krasovytskyi created this record" about a record an
 * automation created, a specific and false attribution rendered identically
 * to a true one. This file proves the fix end to end (a real automation rule
 * actually running, not a unit-level source-parameter check) and the one
 * MUST-KEEP-WORKING rule the whole feature depends on: a row written before
 * this column existed reads as null, never as a retconned 'human'.
 */
let app: NestFastifyApplication;
let engine: AutomationsService;
let db: Db;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  db = app.get(DB);
  admin = await signUpUser(app, 'ActivitySource');
  wsId = (await inject('POST', '/workspaces', { name: 'Activity Source WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('#481 activity_events source — end to end, not unit-level', () => {
  it('a rule-triggered create_record records source "automation", not "human"', async () => {
    const targetDb = (
      await inject('POST', `/workspaces/${wsId}/databases`, { space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id, name: 'Followups' })
    ).json();

    const rule = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'File a followup',
      trigger: { type: 'record_created' },
      actions: [{ type: 'create_record', database_id: targetDb.id, values: { name: 'Followup for {Name}' } }],
    });
    expect(rule.statusCode, rule.body).toBe(201);

    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Trigger me' } })
    ).json();
    await engine.settle(rec.id);
    await wait(50);

    const created = (await inject('POST', `/workspaces/${wsId}/databases/${targetDb.id}/records/query`, {})).json();
    const followup = created.data.find((r: { title: string }) => r.title.includes('Trigger me'));
    expect(followup, JSON.stringify(created.data)).toBeTruthy();

    const activity = (
      await inject('GET', `/workspaces/${wsId}/databases/${targetDb.id}/records/${followup.id}/activity`)
    ).json();
    const createdEvent = activity.data.find((e: { type: string }) => e.type === 'record.created');
    expect(createdEvent, 'the followup must have its own record.created event').toBeTruthy();
    expect(createdEvent.source).toBe('automation');

    // MUST KEEP WORKING (#481): the record that fired the rule is a normal
    // session write and still reads "human" — the rule firing off it must not
    // retroactively relabel the trigger record's own history.
    const triggerActivity = (
      await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/activity`)
    ).json();
    const triggerCreated = triggerActivity.data.find((e: { type: string }) => e.type === 'record.created');
    expect(triggerCreated.source).toBe('human');
  });

  it('a row written before this column existed reads as null, never defaulted to "human"', async () => {
    const rec = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Pre-existing row' } })
    ).json();

    // Simulate the historical case directly: a row with source left NULL,
    // exactly what every activity_events row looked like before this
    // migration — nobody can retroactively know what wrote it.
    await db
      .update(activityEvents)
      .set({ source: null })
      .where(eq(activityEvents.recordId, rec.id));

    const activity = (
      await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}/activity`)
    ).json();
    const createdEvent = activity.data.find((e: { type: string }) => e.type === 'record.created');
    expect(createdEvent.source).toBeNull();
  });
});
