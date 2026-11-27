import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { connectTestDb } from './helpers/db';
import { buildRunCredentialWorld } from './helpers/run-credential-fixture';
import type { RunCredentialWorld } from './helpers/run-credential-fixture';
import { SlackSubscriptionsService } from '../src/integrations/slack-subscriptions.service';

/**
 * Ticket #1377 / ADR-0021 section 7 - a Slack channel subscription's destination is fixed by an ADMIN, so a write made with an agent's RUN
 * CREDENTIAL is not held for approval: the message goes as configured and is LOGGED with the agent and the run (`outward.slack_subscription`),
 * exactly like the Slack mirror of an @mention. Proof for the `logged` verdict in helpers/outward-audit.ts FANOUT_CONSUMERS.
 *
 * Real fixture (a Runner paired and a wake claimed over HTTP: the credential is the one production mints); a person's identical write is
 * the control, so "no log row" for a person cannot be a fixture that could not have seen one.
 */
let app: NestFastifyApplication;
let w: RunCredentialWorld;
let svc: SlackSubscriptionsService;
const { pool } = connectTestDb();
const posted: Array<{ channel?: string; text: string }> = [];

const outwardLog = async (recordId: string) =>
  (await pool.query("select source, agent_id, agent_name, run_id, runner_name, payload from activity_events where type = 'outward.slack_subscription' and payload->'object'->>'id' = $1", [recordId])).rows as Array<Record<string, unknown>>;

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(SlackSubscriptionsService);
  svc.sendIntervalMs = 0;
  svc.retryDelaysMs = [0];
  svc.slack.fetcher = async (_url, init) => {
    posted.push(JSON.parse(init.body) as { channel?: string; text: string });
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  w = await buildRunCredentialWorld(app, pool, 'Subs1377');
  expect((await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/slack`, { bot_token: 'xoxb-test', default_channel: 'general' })).statusCode).toBe(201);
  const sub = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/integrations/slack/subscriptions`, { database_id: w.ticketsDbId, channel: 'eng', events: ['created'] });
  expect(sub.statusCode, sub.body).toBe(201);
}, 180_000);
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('a subscription posts for an agent run credential as configured, says via agent, and logs it with the agent and the run', () => {
  it('the agent\'s create: one message, "via agent", and an outward.slack_subscription row naming the agent, the run and the Runner', async () => {
    posted.length = 0;
    const res = await w.as(w.credential, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records`, { values: { name: 'Made by the agent' } });
    expect(res.statusCode, res.body).toBe(201);
    const recordId = res.json().id as string;
    await svc.settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).toContain('Made by the agent');
    expect(posted[0]!.text).toContain('via agent');
    const rows = await outwardLog(recordId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'agent', agent_id: w.agentId, agent_name: 'Subs1377 bot', runner_name: 'audit machine' });
    expect(rows[0]!['run_id']).toBeTruthy();
  });

  it('CONTROL: a person\'s identical create posts too, with no agent log row', async () => {
    posted.length = 0;
    const res = await w.as(w.admin.token, 'POST', `/workspaces/${w.ws}/databases/${w.ticketsDbId}/records`, { values: { name: 'Made by a person' } });
    expect(res.statusCode, res.body).toBe(201);
    await svc.settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.text).not.toContain('via agent');
    expect(await outwardLog(res.json().id as string)).toHaveLength(0);
  });
});
