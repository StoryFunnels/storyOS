import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { approvals, automationJobs, connections, user } from '../src/db/schema';
import { AutomationsService } from '../src/automations/automations.service';
import { JobRunnerService } from '../src/automations/job-runner.service';
import { PostSocialActionService } from '../src/automations/post-social.action';
import { seal } from '../src/common/secretbox';
import { SOURCE_PUSH_ACTION_CLASS } from '../src/action-gates/action-gates.service';
import { PUBLISH_EXTERNALLY_ACTION_CLASS, actionClassOf } from '../src/action-gates/action-classes';

/**
 * #781 — `publish_externally` is a named action class, and `post_social` resolves to it.
 *
 * THE PREMISE THIS TICKET WAS WRITTEN ON WAS FALSE, and the first describe block below
 * is the proof. #781's AC2 speaks of post_social's "existing approval-gated-by-default
 * behaviour". There was none: `execute()` only defaulted send_email to gated, so a
 * post_social action with `require_approval` left unset was QUEUED AND PUBLISHED with
 * no approval at all, while #42's own title says "approval-gated by default". The
 * save-time rule (only an admin may turn approval OFF) existed; the default it guards
 * did not. Moving the gate into the class is therefore not a pure refactor: it also
 * makes the documented default true.
 */
let app: NestFastifyApplication;
let db: Db;
let engine: AutomationsService;
let jobs: JobRunnerService;
let admin: { token: string; email: string };
let adminId: string;
let wsId: string;
let spaceId: string;

const published: Array<{ url: string; body: unknown }> = [];

const as = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: (payload ?? {}) as never });

/** Each scenario gets its own database: a record_created rule with no condition fires on EVERY later record. */
async function scenario() {
  const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `Posts ${randomUUID().slice(0, 6)}` })).json().id;
  const [connection] = await db
    .insert(connections)
    .values({
      workspaceId: wsId,
      provider: 'x',
      name: `X ${randomUUID()}`,
      authSealed: seal(JSON.stringify({ access_token: 'x-tok' })),
      status: 'active',
      createdBy: adminId,
    })
    .returning();
  return { dbId, connectionId: connection!.id };
}
const createRule = (s: { dbId: string; connectionId: string }, overrides: Record<string, unknown> = {}) =>
  as(admin.token, 'POST', `/workspaces/${wsId}/databases/${s.dbId}/automations`, {
    name: `Post ${randomUUID()}`,
    trigger: { type: 'record_created' },
    actions: [{ type: 'post_social', connection_id: s.connectionId, target: 'x', text: 'Launch: {Title}', ...overrides }],
  });
async function createRecordAndSettle(dbId: string, title = `Rec ${randomUUID().slice(0, 6)}`) {
  const rec = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: title } })).json();
  await engine.settle(rec.id);
  return rec as { id: string };
}
const pendingFor = async (recordId: string, ruleId: string) =>
  (await db.query.approvals.findMany({ where: eq(approvals.recordId, recordId) })).find((a) => a.status === 'pending' && a.ruleId === ruleId);
const jobsFor = (ruleId: string) => db.query.automationJobs.findMany({ where: eq(automationJobs.ruleId, ruleId) });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  engine = app.get(AutomationsService);
  jobs = app.get(JobRunnerService);
  // Never a real network call: the X API is replaced at the executor's own seam.
  app.get(PostSocialActionService).fetcher = (async (url: string, init?: { body?: unknown }) => {
    published.push({ url: String(url), body: init?.body });
    return { status: 201, text: async () => '', json: async () => ({ data: { id: '1850000000000000001' } }), headers: new Headers() };
  }) as unknown as typeof fetch;

  admin = await signUpUser(app, 'PublishExternallyAdmin');
  adminId = (await db.query.user.findFirst({ where: eq(user.email, admin.email) }))!.id;
  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Publish WS' })).json().id;
  spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('#781 — post_social is approval-gated BY DEFAULT, expressed through the class', () => {
  it('left at the default, a post is HELD for approval and nothing is published', async () => {
    const s = await scenario();
    const rule = (await createRule(s)).json() as { id: string };
    const before = published.length;
    const rec = await createRecordAndSettle(s.dbId);

    const approval = await pendingFor(rec.id, rule.id);
    expect(approval, 'a default post_social must wait for approval').toBeTruthy();
    expect(approval!.previewText).toContain('Post to x');
    expect(await jobsFor(rule.id)).toHaveLength(0);
    expect(published.length).toBe(before); // the thing that must never happen: a public post nobody approved
  });

  it('an explicit require_approval: true is held too', async () => {
    const s = await scenario();
    const rule = (await createRule(s, { require_approval: true })).json() as { id: string };
    const rec = await createRecordAndSettle(s.dbId);
    expect(await pendingFor(rec.id, rule.id)).toBeTruthy();
    expect(await jobsFor(rule.id)).toHaveLength(0);
  });

  it('an admin who explicitly turns approval OFF gets an immediate post — exactly one', async () => {
    const s = await scenario();
    const rule = (await createRule(s, { require_approval: false })).json() as { id: string };
    const before = published.length;
    const rec = await createRecordAndSettle(s.dbId);

    expect(await pendingFor(rec.id, rule.id)).toBeUndefined();
    expect(await jobsFor(rule.id)).toHaveLength(1);
    await jobs.tick();
    expect(published.length - before).toBe(1);
  });

  it('approving the held post publishes it exactly once (the approved path is unchanged)', async () => {
    const s = await scenario();
    const rule = (await createRule(s)).json() as { id: string };
    const rec = await createRecordAndSettle(s.dbId, 'Big news');
    const approval = (await pendingFor(rec.id, rule.id))!;

    const before = published.length;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/approvals/${approval.id}/approve`);
    expect(res.statusCode, res.body).toBeLessThan(300);
    await jobs.tick();
    expect(published.length - before).toBe(1);
    expect(String(published.at(-1)!.body)).toContain('Launch: Big news');
  });
});

describe('#781 — the class registry', () => {
  it('publish_externally is registered and post_social resolves to it', () => {
    expect(PUBLISH_EXTERNALLY_ACTION_CLASS).toBe('publish_externally');
    expect(actionClassOf('post_social')).toBe(PUBLISH_EXTERNALLY_ACTION_CLASS);
  });

  it('is a CLASS WITH ONE MEMBER, stated plainly: no other automation action resolves to it', () => {
    for (const type of ['send_email', 'send_slack_message', 'send_webhook', 'http_request', 'run_agent', 'set_values', 'create_record']) {
      expect(actionClassOf(type), type).toBeNull();
    }
  });

  it("source_push's class from #944 is untouched", () => {
    expect(SOURCE_PUSH_ACTION_CLASS).toBe('source_push');
  });
});
