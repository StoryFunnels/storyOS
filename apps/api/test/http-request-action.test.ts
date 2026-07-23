import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automationJobs } from '../src/db/schema';
import { AutomationActionsService } from '../src/automations/actions.service';
import type { ActionContext } from '../src/automations/actions.service';
import { JobRunnerService } from '../src/automations/job-runner.service';

/**
 * MN-263 — the http_request action against a real Postgres (testcontainers)
 * AND a real local HTTP server (no mocked fetch): connection-auth merge,
 * {Field} template rendering, json-path capture writing back onto a real
 * record, and literal-value secret redaction in the persisted job artifact.
 *
 * SSRF coverage against real DNS/sockets lives in src/common/net-guard.test.ts
 * (unit, exhaustive range table) — this file only proves the pipeline wires
 * that guard in (a loopback target refused end-to-end, and the self-host
 * HTTP_ACTION_ALLOW_PRIVATE_CIDRS escape hatch actually working).
 */
describe('http_request automation action (MN-263)', () => {
  let app: NestFastifyApplication;
  let db: Db;
  let jobs: JobRunnerService;
  let actions: AutomationActionsService;
  let admin: { token: string; email: string };
  let wsId: string;
  let dbId: string;
  let numberFieldId: string;
  let numberApi: string;
  let textFieldId: string;
  let textApi: string;
  let server: Server;
  let serverUrl: string;
  let receivedRequests: Array<{ headers: IncomingMessage['headers']; body: string; url: string | undefined }>;
  let nextResponses: Array<{ status: number; body: string }>;

  async function inject(method: string, url: string, payload?: unknown) {
    return app.inject({
      method: method as never,
      url: `/api/v1${url}`,
      headers: authed(admin.token),
      payload: payload as never,
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    jobs = app.get(JobRunnerService);
    actions = app.get(AutomationActionsService);
    admin = await signUpUser(app, 'HttpAction');
    wsId = (await inject('POST', '/workspaces', { name: 'HTTP Action WS' })).json().id;
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Orders' })).json().id;
    const numberField = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'External Id', type: 'number', config: {},
      })
    ).json();
    numberFieldId = numberField.id;
    numberApi = numberField.apiName;
    const textField = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Tag', type: 'text', config: {},
      })
    ).json();
    textFieldId = textField.id;
    textApi = textField.apiName;

    receivedRequests = [];
    nextResponses = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), url: req.url });
        const next = nextResponses.shift() ?? { status: 200, body: '{}' };
        res.writeHead(next.status, { 'content-type': 'application/json' });
        // Echo the received Authorization header back into any JSON object
        // response — this is exactly the "the connection's token leaks back
        // through the response" scenario the literal-redaction step exists for.
        try {
          const parsed = JSON.parse(next.body) as Record<string, unknown>;
          res.end(JSON.stringify({ ...parsed, echoed_auth: req.headers.authorization ?? null }));
        } catch {
          res.end(next.body);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind to a port');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.close();
  });

  afterEach(() => {
    delete process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS;
    receivedRequests = [];
    nextResponses = [];
  });

  async function createRecord(title: string) {
    return (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: title } })).json();
  }

  async function createHttpConnection(auth: Record<string, unknown>) {
    const res = await inject('POST', `/workspaces/${wsId}/connections`, {
      provider: 'http',
      name: 'Test HTTP conn',
      auth,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  }

  function ctxFor(record: { id: string; title: string; values: Record<string, unknown> }): ActionContext {
    return {
      workspaceId: wsId,
      databaseId: dbId,
      record: record as never,
      actorId: admin.email,
      depth: 0,
      runId: randomUUID(),
    };
  }

  it('sends real auth, captures the JSON response onto the record, and redacts the token from the stored artifact', async () => {
    process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32';
    const token = 'secret-bearer-tok-abc123XYZ';
    const connectionId = await createHttpConnection({ auth_style: 'bearer', token });
    const record = await createRecord('Acme & Co');
    nextResponses.push({ status: 200, body: JSON.stringify({ id: 42, tag: 'shipped' }) });

    const effects = await actions.execute(
      [
        {
          type: 'http_request',
          method: 'POST',
          url: `${serverUrl}/orders/{Title}`,
          headers: { 'X-Custom': 'from-{Title}' },
          body_template: '{"note":"{Title}"}',
          connection_id: connectionId,
          capture: [
            { path: '$.id', target_field_id: numberFieldId },
            { path: 'tag', target_field_id: textFieldId },
          ],
        },
      ],
      ctxFor(record),
    );
    expect(effects[0]!.type).toBe('queued_job');

    await jobs.tick();

    expect(receivedRequests).toHaveLength(1);
    const seen = receivedRequests[0]!;
    expect(seen.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen.headers['x-custom']).toBe(`from-${record.title}`);
    expect(JSON.parse(seen.body)).toEqual({ note: record.title });

    const updated = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${record.id}`)).json();
    expect(updated.values[numberApi]).toBe(42);
    expect(updated.values[textApi]).toBe('shipped');

    const jobRow = await db.query.automationJobs.findFirst({
      where: eq(automationJobs.connectionId, connectionId),
    });
    expect(jobRow?.status).toBe('succeeded');
    const artifactText = JSON.stringify(jobRow?.artifact ?? {});
    // The literal token must never appear anywhere in the stored artifact.
    expect(artifactText.includes(token)).toBe(false);
  });

  it('refuses a loopback target with no allowlist — the job fails, the server never sees the request', async () => {
    const record = await createRecord('Blocked order');
    const effects = await actions.execute(
      [{ type: 'http_request', method: 'GET', url: `${serverUrl}/should-not-be-called` }],
      ctxFor(record),
    );
    expect(effects[0]!.type).toBe('queued_job');
    await jobs.tick();

    expect(receivedRequests).toHaveLength(0);
    const latest = await db.query.automationJobs.findFirst({
      where: eq(automationJobs.workspaceId, wsId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    expect(latest?.status).toBe('failed');
    expect(latest?.lastError).toMatch(/private address/);
  });

  it('retries a 5xx once, then succeeds on the next attempt', async () => {
    const record = await createRecord('Flaky order');
    process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32';
    nextResponses.push({ status: 503, body: '{"error":"try again"}' });
    nextResponses.push({ status: 200, body: '{"id":7}' });

    await actions.execute(
      [
        {
          type: 'http_request',
          method: 'GET',
          url: `${serverUrl}/flaky`,
          capture: [{ path: 'id', target_field_id: numberFieldId }],
        },
      ],
      ctxFor(record),
    );

    await jobs.tick(); // attempt 1 → 503, retryable, rescheduled
    let latest = await db.query.automationJobs.findFirst({
      where: eq(automationJobs.workspaceId, wsId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    expect(latest?.status).toBe('queued');
    expect(latest?.attempts).toBe(1);

    // Force the next-attempt clock so tick() claims it again immediately.
    await db.update(automationJobs).set({ nextAttemptAt: new Date(0) }).where(eq(automationJobs.id, latest!.id));
    await jobs.tick(); // attempt 2 → 200, succeeds

    latest = await db.query.automationJobs.findFirst({ where: eq(automationJobs.id, latest!.id) });
    expect(latest?.status).toBe('succeeded');
    expect(latest?.attempts).toBe(2);

    const updated = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${record.id}`)).json();
    expect(updated.values[numberApi]).toBe(7);
  });

  it('does not fail the job on a non-JSON response — captures nothing and notes the parse error', async () => {
    const record = await createRecord('Non-JSON order');
    process.env.HTTP_ACTION_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32';
    nextResponses.push({ status: 200, body: 'not json at all' });

    await actions.execute(
      [
        {
          type: 'http_request',
          method: 'GET',
          url: `${serverUrl}/text`,
          capture: [{ path: 'id', target_field_id: numberFieldId }],
        },
      ],
      ctxFor(record),
    );
    await jobs.tick();

    const latest = await db.query.automationJobs.findFirst({
      where: eq(automationJobs.workspaceId, wsId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    expect(latest?.status).toBe('succeeded');
    expect(JSON.stringify(latest?.artifact)).toMatch(/capture_error/);
  });

  it('refuses a non-http(s) scheme even for a rendered {Field} URL', async () => {
    const record = await createRecord('file target');
    await actions.execute(
      [{ type: 'http_request', method: 'GET', url: 'file:///etc/passwd' }],
      ctxFor(record),
    );
    await jobs.tick();
    const latest = await db.query.automationJobs.findFirst({
      where: eq(automationJobs.workspaceId, wsId),
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    expect(latest?.status).toBe('failed');
    expect(latest?.lastError).toMatch(/unsupported scheme/);
  });
});
