import { randomUUID, createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationJobs, connections, memberships, notifications, user } from '../src/db/schema';
import { ConnectionsService } from '../src/connections/connections.service';
import type { ConnectionFetcher } from '../src/connections/providers';
import { EntitlementsService } from '../src/billing/entitlements.service';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { seal } from '../src/common/secretbox';
import { verifySvixSignature } from '../src/connections/resend-webhook.controller';

/**
 * MN-256 — send_email, end to end against a real Postgres. Exercises: the
 * approval gate's send_email-specific default (external recipient → gated;
 * every recipient a workspace member → skipped, decided at RUN time off the
 * rendered {Field} value, not at save time); from-domain enforcement (a
 * connection missing its `from:` scope 422s at save, and one that loses its
 * from_address after the fact fails cleanly at send time); the message id
 * landing on the job's artifact; the daily cap's boundary; and the bounce
 * webhook's signature verification + connection-status degrade.
 *
 * Each scenario gets its OWN database (`setupScenario`) rather than sharing
 * one across the file: a `record_created` rule with no condition fires on
 * EVERY record created afterward, so a shared database would have earlier
 * tests' rules (some of them un-gated, per the very gating this file tests)
 * silently re-fire — and re-send — off a later test's own record creation.
 * Isolating per scenario is simpler than disabling/deleting each rule by hand.
 *
 * The Resend HTTP call itself is mocked via ConnectionsService.fetcher (the
 * same swappable seam resend.test.ts/connections.service.test.ts already
 * use), never a real network request — mirrors integrations/slack.service.ts's
 * own test pattern.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let adminId: string;
let member: { token: string; email: string };
let wsId: string;
let spaceId: string;

async function as(method: string, url: string, payload?: unknown, token: string = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: (payload ?? {}) as never,
  });
}

interface SentEmail {
  to: string[];
  cc?: string[];
  subject: string;
  from: string;
  reply_to?: string;
}

/** Every send this file triggers lands here — reset with `sent.length = 0`
 * immediately before the one call a given test cares about. */
const sent: SentEmail[] = [];

function fakeResendFetcher(): ConnectionFetcher {
  return async (url, init) => {
    if (url.endsWith('/emails')) {
      const body = JSON.parse(init.body ?? '{}') as SentEmail;
      sent.push(body);
      return { status: 200, json: async () => ({ id: `msg_${sent.length}` }), text: async () => '' };
    }
    return { status: 200, json: async () => ({ data: [] }), text: async () => '' };
  };
}

interface Scenario {
  dbId: string;
  emailFieldApiName: string;
  connectionId: string;
}

/** A fresh database (its own "Email" text field) + a fresh Resend connection,
 * in the shared workspace — isolates one test's automation rule from every
 * other test's records (see the file-level doc comment above). */
async function setupScenario(connectionOverrides: { scopes?: string[]; webhookSecret?: string } = {}): Promise<Scenario> {
  const dbId = (
    await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Leads ${randomUUID()}` })
  ).json().id;
  const emailField = (
    await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Email',
      type: 'text',
      config: {},
    })
  ).json();
  const auth = {
    api_key: 're_test_key',
    from_address: 'automations@example.com',
    ...(connectionOverrides.webhookSecret ? { webhook_secret: connectionOverrides.webhookSecret } : {}),
  };
  const [connection] = await db
    .insert(connections)
    .values({
      workspaceId: wsId,
      provider: 'resend',
      name: `Test Resend ${randomUUID()}`,
      authSealed: seal(JSON.stringify(auth)),
      scopes: connectionOverrides.scopes ?? ['domain:example.com', 'from:automations@example.com'],
      status: 'active',
      createdBy: adminId,
    })
    .returning();
  return { dbId, emailFieldApiName: emailField.apiName, connectionId: connection!.id };
}

async function createRule(
  scenario: Scenario,
  overrides: { require_approval?: boolean } = {},
  token: string = admin.token,
) {
  return as(
    'POST',
    `/workspaces/${wsId}/databases/${scenario.dbId}/automations`,
    {
      name: `Send email ${randomUUID()}`,
      trigger: { type: 'record_created' },
      actions: [
        {
          type: 'send_email',
          connection_id: scenario.connectionId,
          to: '{Email}',
          subject: 'Hello {Title}',
          body_markdown: 'Body for **{Title}**',
          ...overrides,
        },
      ],
    },
    token,
  );
}

async function createRecordAndSettle(scenario: Scenario, email: string, title = `Rec ${randomUUID()}`) {
  const rec = (
    await as('POST', `/workspaces/${wsId}/databases/${scenario.dbId}/records`, {
      values: { name: title, [scenario.emailFieldApiName]: email },
    })
  ).json();
  await engine.settle(rec.id);
  return rec as { id: string };
}

async function pendingApprovalFor(recordId: string, ruleId: string) {
  const rows = await db.query.approvals.findMany({ where: eq(approvals.recordId, recordId) });
  return rows.find((a) => a.status === 'pending' && a.ruleId === ruleId);
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  app.get(ConnectionsService).fetcher = fakeResendFetcher();

  admin = await signUpUser(app, 'SendEmailAdmin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as('POST', '/workspaces', { name: 'Send Email WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  member = await signUpUser(app, 'SendEmailMember');
  const memberId = (await db.query.user.findFirst({ where: eq(user.email, member.email) }))!.id;
  await db.insert(memberships).values({ workspaceId: wsId, userId: memberId, role: 'member', status: 'active' });
});

afterAll(async () => {
  await app.close();
});

describe('send_email approval-gate default (MN-256)', () => {
  it('an external recipient defaults to gated — pending approval, no job', async () => {
    const scenario = await setupScenario();
    const rule = (await createRule(scenario)).json() as { id: string };
    const rec = await createRecordAndSettle(scenario, 'outsider@external.com');

    const approval = await pendingApprovalFor(rec.id, rule.id);
    expect(approval, 'expected a pending approval').toBeTruthy();
    expect(approval!.previewText).toContain('outsider@external.com');

    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) });
    expect(jobRows).toHaveLength(0);
  });

  it('every rendered recipient resolving to a workspace member skips the gate — queued directly', async () => {
    const scenario = await setupScenario();
    const rule = (await createRule(scenario)).json() as { id: string };
    const rec = await createRecordAndSettle(scenario, member.email);

    const approval = await pendingApprovalFor(rec.id, rule.id);
    expect(approval).toBeUndefined();

    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) });
    expect(jobRows).toHaveLength(1);
    // Drain it now — JobRunnerService.tick() claims from the GLOBAL queued
    // set (never scoped to this test's database), so an un-ticked row here
    // would otherwise get claimed — and re-sent — by a LATER test's own tick().
    await jobs.tick();
  });

  it('an explicit require_approval: false is honored even for an external recipient (admin-saved)', async () => {
    const scenario = await setupScenario();
    const rule = (await createRule(scenario, { require_approval: false })).json() as { id: string };
    const rec = await createRecordAndSettle(scenario, 'outsider2@external.com');

    const approval = await pendingApprovalFor(rec.id, rule.id);
    expect(approval).toBeUndefined();
    const jobRows = await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) });
    expect(jobRows).toHaveLength(1);
    await jobs.tick(); // drain — see the previous test's own comment
  });

  it('a non-admin member cannot save require_approval: false on send_email (422)', async () => {
    const scenario = await setupScenario();
    const res = await createRule(scenario, { require_approval: false }, member.token);
    expect(res.statusCode).toBe(422);
  });

  it('a non-admin member CAN still save the default (unset) or an explicit true', async () => {
    const scenario = await setupScenario();
    const resDefault = await createRule(scenario, {}, member.token);
    expect(resDefault.statusCode).toBe(201);
    const resTrue = await createRule(scenario, { require_approval: true }, member.token);
    expect(resTrue.statusCode).toBe(201);
  });
});

describe('send_email connection requirements (MN-256)', () => {
  it('a connection with no from: scope 422s at save time', async () => {
    const scenario = await setupScenario({ scopes: ['domain:example.com'] }); // no from:
    const res = await createRule(scenario);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('from-address');
  });

  it('an unknown connection_id 422s', async () => {
    const scenario = await setupScenario();
    const res = await createRule({ ...scenario, connectionId: randomUUID() });
    expect(res.statusCode).toBe(422);
  });
});

describe('send_email execution + message id (MN-256)', () => {
  it('approve → job runs → Resend is called with the rendered fields → message_id lands on the job artifact', async () => {
    const scenario = await setupScenario();
    sent.length = 0;

    const rule = (await createRule(scenario)).json() as { id: string };
    const rec = await createRecordAndSettle(scenario, 'outsider3@external.com', 'Q3 Deal');
    const approval = await pendingApprovalFor(rec.id, rule.id);
    expect(approval).toBeTruthy();

    const approveRes = await as('POST', `/workspaces/${wsId}/approvals/${approval!.id}/approve`);
    expect(approveRes.statusCode).toBeLessThan(300);

    await jobs.tick();

    const jobRow = (await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) }))[0]!;
    expect(jobRow.status).toBe('succeeded');
    expect((jobRow.artifact as { message_id: string }).message_id).toBe('msg_1');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(['outsider3@external.com']);
    expect(sent[0]!.from).toBe('automations@example.com');
    expect(sent[0]!.subject).toBe('Hello Q3 Deal');
  });

  it('cc is included and reply_to is forwarded', async () => {
    const scenario = await setupScenario();
    sent.length = 0;

    const res = await as('POST', `/workspaces/${wsId}/databases/${scenario.dbId}/automations`, {
      name: `Send email ${randomUUID()}`,
      trigger: { type: 'record_created' },
      actions: [
        {
          type: 'send_email',
          connection_id: scenario.connectionId,
          to: '{Email}',
          cc: member.email,
          reply_to: 'support@example.com',
          subject: 'Hello {Title}',
          body_markdown: 'Body',
          require_approval: false,
        },
      ],
    });
    const rule = res.json() as { id: string };
    await createRecordAndSettle(scenario, member.email, 'Cc Test');
    await jobs.tick();

    const jobRow = (await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) }))[0]!;
    expect(jobRow.status).toBe('succeeded');
    expect(sent[0]!.cc).toEqual([member.email]);
    expect(sent[0]!.reply_to).toBe('support@example.com');
  });

  it('from-address enforcement at send time: a connection whose auth lost its from_address fails non-retryably', async () => {
    const scenario = await setupScenario();
    // Simulate the connection's own from_address disappearing after the rule
    // was saved (validate()'s scope check only runs at save time) — the
    // executor's own from-address check is the real run-time boundary.
    await db
      .update(connections)
      .set({ authSealed: seal(JSON.stringify({ api_key: 're_test_key' })) })
      .where(eq(connections.id, scenario.connectionId));

    const rule = (await createRule(scenario, { require_approval: false })).json() as { id: string };
    await createRecordAndSettle(scenario, 'outsider4@external.com');
    await jobs.tick();
    const jobRow = (await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) }))[0]!;
    expect(jobRow.status).toBe('failed');
    expect(jobRow.lastError).toContain('from_address');
  });

  it('too many recipients (to + cc) fails non-retryably rather than silently truncating', async () => {
    const scenario = await setupScenario();
    const res = await as('POST', `/workspaces/${wsId}/databases/${scenario.dbId}/automations`, {
      name: `Send email ${randomUUID()}`,
      trigger: { type: 'record_created' },
      actions: [
        {
          type: 'send_email',
          connection_id: scenario.connectionId,
          to: 'a@external.com,b@external.com,c@external.com,d@external.com',
          cc: 'e@external.com,f@external.com',
          subject: 'Hi',
          body_markdown: 'Body',
          require_approval: false,
        },
      ],
    });
    const rule = res.json() as { id: string };
    await createRecordAndSettle(scenario, 'unused@external.com');
    await jobs.tick();
    const jobRow = (await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) }))[0]!;
    expect(jobRow.status).toBe('failed');
    expect(jobRow.lastError).toContain('at most 5 recipients');
  });
});

describe('send_email daily cap (MN-256)', () => {
  afterEach(() => {
    const entitlements = app.get(EntitlementsService);
    // @ts-expect-error restoring the real prototype method after each test
    delete entitlements.emailDailyCap;
  });

  it('the (cap+1)th send fails clean with a "daily email cap reached" error and a one-time Inbox notice', async () => {
    // A fresh workspace too: the cap counts EVERY send_email job for the
    // WORKSPACE, not just one database, so a shared workspace would also
    // count every other scenario's already-succeeded sends today.
    const capWsId = (await as('POST', '/workspaces', { name: `Cap WS ${randomUUID()}` })).json().id;
    const capSpaceId = (await as('GET', `/workspaces/${capWsId}/spaces`)).json()[0].id;
    const capDbId = (
      await as('POST', `/workspaces/${capWsId}/databases`, { space_id: capSpaceId, name: 'Cap DB' })
    ).json().id;
    const [capConnection] = await db
      .insert(connections)
      .values({
        workspaceId: capWsId,
        provider: 'resend',
        name: 'Cap Resend',
        authSealed: seal(JSON.stringify({ api_key: 're_test_key', from_address: 'automations@example.com' })),
        scopes: ['domain:example.com', 'from:automations@example.com'],
        status: 'active',
        createdBy: adminId,
      })
      .returning();

    const entitlements = app.get(EntitlementsService);
    entitlements.emailDailyCap = async () => 1;

    const rule = (
      await as('POST', `/workspaces/${capWsId}/databases/${capDbId}/automations`, {
        name: 'Cap rule',
        trigger: { type: 'record_created' },
        actions: [
          {
            type: 'send_email',
            connection_id: capConnection!.id,
            // admin.email is trivially internal to their own fresh workspace —
            // gating isn't what this test is about.
            to: admin.email,
            subject: 'Cap test',
            body_markdown: 'Body',
            require_approval: false,
          },
        ],
      })
    ).json() as { id: string };

    async function createAndSettle(title: string) {
      const rec = (
        await as('POST', `/workspaces/${capWsId}/databases/${capDbId}/records`, { values: { name: title } })
      ).json();
      await engine.settle(rec.id);
      return rec as { id: string };
    }

    const rec1 = await createAndSettle('Cap 1');
    await jobs.tick();
    const jobs1 = await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) });
    expect(jobs1.find((j) => (j.payload as { ctx?: { recordId?: string } }).ctx?.recordId === rec1.id)?.status).toBe(
      'succeeded',
    );

    const rec2 = await createAndSettle('Cap 2');
    await jobs.tick();
    const jobs2 = await db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, rule.id) });
    const job2 = jobs2.find((j) => (j.payload as { ctx?: { recordId?: string } }).ctx?.recordId === rec2.id);
    expect(job2!.status).toBe('failed');
    expect(job2!.lastError).toContain('daily email cap reached');

    const notes = await db.query.notifications.findMany({
      where: and(eq(notifications.workspaceId, capWsId), eq(notifications.type, 'send_email_cap_reached')),
    });
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Resend bounce/complaint webhook degrades the connection (MN-256)', () => {
  function signSvix(webhookSecret: string, svixId: string, svixTimestamp: string, bodyStr: string): string {
    const secretBytes = Buffer.from(webhookSecret.replace(/^whsec_/, ''), 'base64');
    const signedContent = `${svixId}.${svixTimestamp}.${bodyStr}`;
    return `v1,${createHmac('sha256', secretBytes).update(signedContent).digest('base64')}`;
  }

  it('a verified bounce/complaint delivery increments errorStreak; 5 flips status to error', async () => {
    const webhookSecret = 'whsec_' + Buffer.from('test-secret-32-bytes-long-value!').toString('base64');
    const scenario = await setupScenario({ webhookSecret });

    for (let i = 0; i < 5; i++) {
      const svixId = `msg_${i}`;
      const svixTimestamp = String(Math.floor(Date.now() / 1000));
      const bodyStr = JSON.stringify({ type: 'email.bounced', data: { email_id: `e_${i}` } });
      const sig = signSvix(webhookSecret, svixId, svixTimestamp, bodyStr);
      expect(verifySvixSignature(webhookSecret, svixId, svixTimestamp, Buffer.from(bodyStr), sig)).toBe(true);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/resend/webhook/${scenario.connectionId}`,
        headers: {
          'content-type': 'application/json',
          'svix-id': svixId,
          'svix-timestamp': svixTimestamp,
          'svix-signature': sig,
        },
        payload: bodyStr,
      });
      expect(res.statusCode).toBe(200);
    }

    const updated = await db.query.connections.findFirst({ where: eq(connections.id, scenario.connectionId) });
    expect(updated!.errorStreak).toBeGreaterThanOrEqual(5);
    expect(updated!.status).toBe('error');
  });

  it('rejects a bad signature with 401 and never touches the connection', async () => {
    const webhookSecret = 'whsec_' + Buffer.from('another-secret-32-bytes-long-val').toString('base64');
    const scenario = await setupScenario({ webhookSecret });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/resend/webhook/${scenario.connectionId}`,
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_bad',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,not-a-real-signature',
      },
      payload: JSON.stringify({ type: 'email.bounced' }),
    });
    expect(res.statusCode).toBe(401);
    const unchanged = await db.query.connections.findFirst({ where: eq(connections.id, scenario.connectionId) });
    expect(unchanged!.errorStreak).toBe(0);
  });

  it('a connection with no webhook_secret configured 401s every delivery', async () => {
    const scenario = await setupScenario(); // no webhookSecret
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/providers/resend/webhook/${scenario.connectionId}`,
      headers: {
        'content-type': 'application/json',
        'svix-id': 'msg_x',
        'svix-timestamp': String(Math.floor(Date.now() / 1000)),
        'svix-signature': 'v1,anything',
      },
      payload: JSON.stringify({ type: 'email.bounced' }),
    });
    expect(res.statusCode).toBe(401);
  });
});
