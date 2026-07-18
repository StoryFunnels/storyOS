import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AgentsService } from '../src/agents/agents.service';
import { AgentTriggerSubscriber } from '../src/agents/trigger.subscriber';
import type { AgentRuntime } from '../src/agents/agent-runtime';
import { GithubService } from '../src/integrations/github.service';

let app: NestFastifyApplication;
let subscriber: AgentTriggerSubscriber;
let admin: { token: string; email: string };
let wsId: string;
let ticketsDbId: string;
let statelessDbId: string;
let agentsDbId: string;
let runsDbId: string;
let stateFieldId: string;
let stateApi: string;
let inProgressId: string;
let inReviewId: string;
let doneId: string;

const SECRET = 'a-very-secret-webhook-key-42';

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Post a delivery. `body` is sent as an exact byte string — never re-serialized
 * — because the whole point of the signature is that it covers those bytes.
 */
async function deliver(
  event: string,
  payload: unknown,
  opts: { signature?: string | null; body?: string } = {},
) {
  const body = opts.body ?? JSON.stringify(payload);
  const signature = opts.signature === undefined ? sign(body) : opts.signature;
  return app.inject({
    method: 'POST',
    url: '/api/v1/integrations/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      ...(signature ? { 'x-hub-signature-256': signature } : {}),
    },
    payload: body,
  });
}

/** A pull_request delivery payload. */
function prPayload(opts: {
  action: string;
  number: number;
  branch: string;
  merged?: boolean;
  body?: string;
  title?: string;
  state?: 'open' | 'closed';
}) {
  return {
    action: opts.action,
    repository: { full_name: 'acme/site' },
    pull_request: {
      number: opts.number,
      title: opts.title ?? `PR #${opts.number}`,
      state: opts.state ?? (opts.action === 'closed' ? 'closed' : 'open'),
      merged: opts.merged ?? false,
      merged_at: opts.merged ? '2026-07-17T00:00:00Z' : null,
      draft: false,
      html_url: `https://github.com/acme/site/pull/${opts.number}`,
      body: opts.body ?? null,
      user: { login: 'dana' },
      head: { ref: opts.branch, sha: 'deadbeef' },
    },
  };
}

async function createTicket(name: string, dbId = ticketsDbId) {
  const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; number: number; values: Record<string, unknown> };
}

async function getTicket(id: string, dbId = ticketsDbId) {
  return (await as('GET', `/workspaces/${wsId}/databases/${dbId}/records/${id}`)).json();
}

async function pullRecords() {
  const dbs = (await as('GET', `/workspaces/${wsId}/databases`)).json();
  const pullsDb = dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
  if (!pullsDb) return [];
  const list = (await as('GET', `/workspaces/${wsId}/databases/${pullsDb.id}/records?limit=100`)).json();
  return list.data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
}

beforeAll(async () => {
  app = await createTestApp();
  subscriber = app.get(AgentTriggerSubscriber);
  // No test may reach the real api.github.com. Installed before anything runs so
  // a checks lookup can never turn into a live network call.
  app.get(GithubService).fetcher = async () => ({ state: 'pending' });
  admin = await signUpUser(app, 'Hooky');
  wsId = (await as('POST', '/workspaces', { name: 'Webhook WS' })).json().id;

  const ensured = await as('POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;
  runsDbId = ensured.json().runsDb.id;

  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  ticketsDbId = (
    await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })
  ).json().id;
  statelessDbId = (
    await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Notes' })
  ).json().id;

  const state = (
    await as('POST', `/workspaces/${wsId}/databases/${ticketsDbId}/fields`, {
      display_name: 'State',
      type: 'select',
      config: {},
      options: [{ label: 'Todo' }, { label: 'In Progress' }, { label: 'In Review' }, { label: 'Done' }],
    })
  ).json();
  stateFieldId = state.id;
  stateApi = state.apiName;
  inProgressId = state.options.find((o: { label: string }) => o.label === 'In Progress').id;
  inReviewId = state.options.find((o: { label: string }) => o.label === 'In Review').id;
  doneId = state.options.find((o: { label: string }) => o.label === 'Done').id;

  const saved = await as('POST', `/workspaces/${wsId}/integrations/github`, {
    webhook_secret: SECRET,
    link_database_id: ticketsDbId,
  });
  expect(saved.statusCode, saved.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('signature verification (#42, the security core)', () => {
  it('accepts a delivery signed with the workspace secret', async () => {
    const res = await deliver('ping', { zen: 'Keep it logically awesome' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pong).toBe(true);
  });

  it('401s an invalid signature', async () => {
    const res = await deliver('ping', { zen: 'x' }, { signature: `sha256=${'0'.repeat(64)}` });
    expect(res.statusCode).toBe(401);
  });

  it('401s a signature made with the wrong secret', async () => {
    const body = JSON.stringify({ zen: 'x' });
    const res = await deliver('ping', null, { body, signature: sign(body, 'not-the-secret') });
    expect(res.statusCode).toBe(401);
  });

  it('401s a missing signature', async () => {
    const res = await deliver('ping', { zen: 'x' }, { signature: null });
    expect(res.statusCode).toBe(401);
  });

  it('401s a malformed signature header (no length-mismatch crash)', async () => {
    const res = await deliver('ping', { zen: 'x' }, { signature: 'sha256=short' });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The tamper test. Sign body A, send body B. If verification ever moves off
   * the raw bytes — or off the *sent* bytes — this is what catches it.
   */
  it('401s a tampered body carrying a valid-for-the-original signature', async () => {
    const original = JSON.stringify(prPayload({ action: 'opened', number: 900, branch: 'story-1' }));
    const tampered = original.replace('"acme/site"', '"evil/repo"');
    expect(tampered).not.toBe(original);
    const res = await deliver('pull_request', null, {
      body: tampered,
      signature: sign(original),
    });
    expect(res.statusCode).toBe(401);
  });

  /**
   * The positive half of the raw-body proof, and the assertion that actually
   * pins the implementation: these bytes are valid JSON that does NOT survive a
   * parse → stringify round-trip (extra whitespace). A handler that hashed
   * `JSON.stringify(req.body)` would compute a different digest and 401 here.
   */
  it('accepts a body whose exact bytes do not survive a JSON round-trip', async () => {
    const canonical = JSON.stringify({ zen: 'raw bytes matter' });
    const raw = `{  "zen"  :  "raw bytes matter"  }`;
    expect(raw).not.toBe(canonical);
    expect(JSON.parse(raw)).toEqual(JSON.parse(canonical));

    // Sanity: the signature over the raw bytes and over the canonical form differ,
    // so this test can only pass if the server hashed what we actually sent.
    expect(sign(raw)).not.toBe(sign(canonical));

    const res = await deliver('ping', null, { body: raw, signature: sign(raw) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().pong).toBe(true);

    // …and the canonical signature must be rejected for those same raw bytes.
    const wrong = await deliver('ping', null, { body: raw, signature: sign(canonical) });
    expect(wrong.statusCode).toBe(401);
  });

  it('never processes the payload of an unverified delivery', async () => {
    const ticket = await createTicket('Must not move');
    const body = JSON.stringify(
      prPayload({ action: 'opened', number: 901, branch: `story-${ticket.number}` }),
    );
    const res = await deliver('pull_request', null, { body, signature: sign(body, 'wrong-secret') });
    expect(res.statusCode).toBe(401);

    // No state moved, and no PR record was written.
    expect((await getTicket(ticket.id)).values[stateApi] ?? null).toBe(null);
    expect((await pullRecords()).some((p) => p.values.number === 901)).toBe(false);
  });
});

describe('linking (AC 2)', () => {
  it('links a story-<n> branch to the record with that public number', async () => {
    const ticket = await createTicket('Branch linked');
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 10, branch: `story-${ticket.number}` }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(ticket.id);
  });

  it('matches the branch case-insensitively and inside a slug', async () => {
    const ticket = await createTicket('Sluggy');
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 11, branch: `feat/STORY-${ticket.number}-some-slug` }),
    );
    expect(res.json().linked_record_id).toBe(ticket.id);
  });

  it('does not match a near-miss branch name', async () => {
    const ticket = await createTicket('Near miss');
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 12, branch: `history-${ticket.number}` }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().linked_record_id).toBe(null);
  });

  it('links via a record URL in the PR body', async () => {
    const ticket = await createTicket('URL linked');
    const res = await deliver(
      'pull_request',
      prPayload({
        action: 'opened',
        number: 13,
        branch: 'chore/no-magic-name',
        body: `Fixes http://localhost:3000/w/${wsId}/d/${ticketsDbId}/r/url-linked-${ticket.number}\n\nSee ya.`,
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(ticket.id);
  });

  it('is a 200 no-op when the branch matches nothing', async () => {
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 14, branch: 'story-999999' }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(null);
  });
});

describe('PR records (AC 3) + idempotency', () => {
  it('stores the PR as a record with its status and checks', async () => {
    const ticket = await createTicket('Has a PR');
    await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 20, branch: `story-${ticket.number}`, title: 'Add thing' }),
    );

    const pr = (await pullRecords()).find((p) => p.values.number === 20);
    expect(pr, 'PR record exists').toBeTruthy();
    expect(pr!.title).toBe('Add thing');
    expect(pr!.values.repo).toBe('acme/site');
    expect(pr!.values.branch).toBe(`story-${ticket.number}`);
    expect(pr!.values.url).toBe('https://github.com/acme/site/pull/20');
    expect(pr!.values.state).toBeTruthy();
    // No PAT configured yet → checks are honestly Unknown, not blank and not a guess.
    const dbs = (await as('GET', `/workspaces/${wsId}/databases`)).json();
    const pullsDb = dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
    const checksOptions = (await as('GET', `/workspaces/${wsId}/databases/${pullsDb.id}`))
      .json()
      .fields.find((f: { apiName: string }) => f.apiName === 'checks').options;
    expect(pr!.values.checks).toBe(
      checksOptions.find((o: { label: string }) => o.label === 'Unknown').id,
    );
    // The PR row points back at the linked record.
    const linkedTitles = (pr!.values.linked_record as Array<{ id: string }> | undefined) ?? [];
    expect(linkedTitles.map((l) => l.id)).toContain(ticket.id);
  });

  /**
   * From here on the workspace has a PAT configured. There is deliberately no
   * API to *clear* a token, so the safe stub fetcher from beforeAll is what
   * keeps every later test off the network.
   */
  it('reads the real checks state when a PAT is configured', async () => {
    const github = app.get(GithubService);
    const asked: string[] = [];
    github.fetcher = async (path) => {
      asked.push(path);
      return { state: 'success' };
    };
    await as('POST', `/workspaces/${wsId}/integrations/github`, { token: 'ghp_test' });

    try {
      const ticket = await createTicket('Checked');
      await deliver(
        'pull_request',
        prPayload({ action: 'opened', number: 22, branch: `story-${ticket.number}` }),
      );
      expect(asked).toContain('/repos/acme/site/commits/deadbeef/status');

      const pr = (await pullRecords()).find((p) => p.values.number === 22)!;
      const checksField = (await as('GET', `/workspaces/${wsId}/databases`)).json();
      const pullsDb = checksField.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
      const checks = (await as('GET', `/workspaces/${wsId}/databases/${pullsDb.id}`))
        .json()
        .fields.find((f: { apiName: string }) => f.apiName === 'checks');
      const success = checks.options.find((o: { label: string }) => o.label === 'Success').id;
      expect(pr.values.checks).toBe(success);
    } finally {
      github.fetcher = async () => ({ state: 'pending' });
    }
  });

  it('falls back to Unknown checks when the GitHub read fails — never loses the delivery', async () => {
    const github = app.get(GithubService);
    github.fetcher = async () => {
      throw new Error('GitHub is down');
    };
    try {
      const ticket = await createTicket('Checks exploded');
      const res = await deliver(
        'pull_request',
        prPayload({ action: 'opened', number: 23, branch: `story-${ticket.number}` }),
      );
      // The state automation — the point of the delivery — still happened.
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().state_applied).toBe('In Progress');
      expect((await getTicket(ticket.id)).values[stateApi]).toBe(inProgressId);
    } finally {
      github.fetcher = async () => ({ state: 'pending' });
    }
  });

  it('redelivery updates the same PR record instead of duplicating it', async () => {
    const ticket = await createTicket('Redelivered');
    const payload = prPayload({
      action: 'opened',
      number: 21,
      branch: `story-${ticket.number}`,
      title: 'First title',
    });
    await deliver('pull_request', payload);
    const first = (await pullRecords()).filter((p) => p.values.number === 21);
    expect(first).toHaveLength(1);

    // GitHub redelivers the identical event…
    await deliver('pull_request', payload);
    expect((await pullRecords()).filter((p) => p.values.number === 21)).toHaveLength(1);

    // …and a later event for the same PR updates that same row.
    await deliver(
      'pull_request',
      prPayload({
        action: 'closed',
        number: 21,
        branch: `story-${ticket.number}`,
        merged: true,
        title: 'Renamed title',
      }),
    );
    const after = (await pullRecords()).filter((p) => p.values.number === 21);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(first[0]!.id);
    expect(after[0]!.title).toBe('Renamed title');
  });
});

describe('state automation (AC 4)', () => {
  it('opened → In Progress, through the records path', async () => {
    const ticket = await createTicket('Opening');
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 30, branch: `story-${ticket.number}` }),
    );
    expect(res.json().state_applied).toBe('In Progress');
    expect((await getTicket(ticket.id)).values[stateApi]).toBe(inProgressId);
  });

  it('review_requested → In Review', async () => {
    const ticket = await createTicket('Reviewing');
    await deliver(
      'pull_request',
      prPayload({ action: 'review_requested', number: 31, branch: `story-${ticket.number}` }),
    );
    expect((await getTicket(ticket.id)).values[stateApi]).toBe(inReviewId);
  });

  it('closed+merged → Done; closed-without-merge moves nothing', async () => {
    const merged = await createTicket('Merging');
    await deliver(
      'pull_request',
      prPayload({ action: 'closed', number: 32, branch: `story-${merged.number}`, merged: true }),
    );
    expect((await getTicket(merged.id)).values[stateApi]).toBe(doneId);

    const abandoned = await createTicket('Abandoned');
    await deliver(
      'pull_request',
      prPayload({ action: 'closed', number: 33, branch: `story-${abandoned.number}`, merged: false }),
    );
    expect((await getTicket(abandoned.id)).values[stateApi] ?? null).toBe(null);
  });

  it('skips cleanly when the linked database has no state field', async () => {
    // The Notes database has no select field to move.
    const note = await createTicket('Stateless', statelessDbId);
    const res = await deliver(
      'pull_request',
      prPayload({
        action: 'opened',
        number: 34,
        branch: 'chore/x',
        body: `See http://localhost:3000/w/${wsId}/d/${statelessDbId}/r/${note.number}`,
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(note.id);
    expect(res.json().state_applied).toBe(null);
  });

  it('skips cleanly when the configured option does not exist', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { opened: 'Nonexistent State' },
    });
    const ticket = await createTicket('Unknown option');
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 35, branch: `story-${ticket.number}` }),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state_applied).toBe(null);
    expect((await getTicket(ticket.id)).values[stateApi] ?? null).toBe(null);

    // Restore the defaults for the rest of the suite.
    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { opened: 'In Progress' },
    });
  });

  it('honours a custom mapping', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { opened: 'Todo' },
    });
    const ticket = await createTicket('Custom map');
    await deliver(
      'pull_request',
      prPayload({ action: 'opened', number: 36, branch: `story-${ticket.number}` }),
    );
    const todo = (await as('GET', `/workspaces/${wsId}/databases/${ticketsDbId}`))
      .json()
      .fields.find((f: { id: string }) => f.id === stateFieldId)
      .options.find((o: { label: string }) => o.label === 'Todo').id;
    expect((await getTicket(ticket.id)).values[stateApi]).toBe(todo);

    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { opened: 'In Progress' },
    });
  });
});

describe('the payoff: a webhook-driven transition fires an agent trigger (#212)', () => {
  it('dispatches a Run when a merged PR moves the record to Done', async () => {
    // An agent bound to Tickets → Done.
    const scopeField = (await as('GET', `/workspaces/${wsId}/databases/${agentsDbId}`))
      .json()
      .fields.find((f: { apiName: string }) => f.apiName === 'scopes');
    const agent = (
      await as('POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
        values: {
          name: 'Merge watcher',
          enabled: true,
          scopes: [scopeField.options.find((o: { label: string }) => o.label === 'read').id],
        },
      })
    ).json();

    const binding = await as('POST', `/workspaces/${wsId}/agents/triggers`, {
      agent: agent.id,
      database_id: ticketsDbId,
      state_field_id: stateFieldId,
      state_option_id: doneId,
    });
    expect(binding.statusCode, binding.body).toBe(201);

    // A runtime that just records that it ran — the dispatch is what's under test.
    const runtime: AgentRuntime = {
      runClass: 'non_ai',
      // eslint-disable-next-line require-yield
      async *execute() {
        return;
      },
    };
    const agentsService = app.get(AgentsService);
    const original = agentsService.runtimeFor;
    agentsService.runtimeFor = () => runtime;

    try {
      const ticket = await createTicket('Merge me');
      const res = await deliver(
        'pull_request',
        prPayload({ action: 'closed', number: 40, branch: `story-${ticket.number}`, merged: true }),
      );
      expect(res.json().state_applied).toBe('Done');
      expect((await getTicket(ticket.id)).values[stateApi]).toBe(doneId);

      // Dispatch is fire-and-forget off the event bus — settle the chain first.
      await subscriber.settle(ticket.id);

      const runs = (await as('GET', `/workspaces/${wsId}/databases/${runsDbId}/records?limit=100`))
        .json()
        .data.filter((r: { values: Record<string, unknown> }) =>
          ((r.values.agent as Array<{ id: string }> | undefined) ?? []).some((l) => l.id === agent.id),
        );
      expect(runs, 'the merged webhook dispatched a Run').toHaveLength(1);
      expect(runs[0].values.trigger).toBeTruthy();
    } finally {
      agentsService.runtimeFor = original;
    }
  });
});

describe('secret handling (AC 6)', () => {
  it('never returns the webhook secret from the integration config', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().has_webhook_secret).toBe(true);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().webhook_secret).toBeUndefined();
  });

  it('never returns it from the save response either', async () => {
    const res = await as('POST', `/workspaces/${wsId}/integrations/github`, {
      webhook_secret: SECRET,
    });
    expect(res.body).not.toContain(SECRET);
  });

  it('redacts it out of the workspace settings blob (per redactSecrets)', async () => {
    const res = await as('GET', `/workspaces/${wsId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.json().settings.github.webhook_secret).toBe('[redacted]');
  });
});

/**
 * App-native tenant resolution (this change). With GITHUB_APP_WEBHOOK_SECRET set,
 * the ONE App secret verifies every delivery and the workspace is resolved from
 * the payload's installation.id — no per-workspace secret, no PAT. The env var is
 * read live, so we toggle it per-test and the legacy suite above runs untouched.
 */
describe('App-native path (env GITHUB_APP_WEBHOOK_SECRET set)', () => {
  const APP_SECRET = 'app-instance-webhook-secret-native-247';
  const INSTALLATION_ID = 55501234;

  function signApp(body: string, secret = APP_SECRET) {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  async function deliverApp(
    event: string,
    payload: unknown,
    opts: { body?: string; signature?: string | null } = {},
  ) {
    const body = opts.body ?? JSON.stringify(payload);
    const signature = opts.signature === undefined ? signApp(body) : opts.signature;
    return app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        ...(signature ? { 'x-hub-signature-256': signature } : {}),
      },
      payload: body,
    });
  }

  /** Attach the installation object GitHub App deliveries carry — the tenant key. */
  function withInstallation(payload: Record<string, unknown>, id = INSTALLATION_ID) {
    return { ...payload, installation: { id } };
  }

  beforeAll(async () => {
    // This workspace has connected an installation; the App secret now verifies.
    await app.get(GithubService).saveInstallationId(wsId, INSTALLATION_ID);
  });
  beforeEach(() => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = APP_SECRET;
  });
  afterEach(() => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  });

  it('verifies with the App secret AND resolves the workspace by installation.id', async () => {
    const ticket = await createTicket('App native');
    const res = await deliverApp(
      'pull_request',
      withInstallation(prPayload({ action: 'opened', number: 200, branch: `story-${ticket.number}` })),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(ticket.id);
    expect(res.json().state_applied).toBe('In Progress');
    expect((await getTicket(ticket.id)).values[stateApi]).toBe(inProgressId);
  });

  it('401s a delivery signed with the WRONG secret on the App path — nothing processed', async () => {
    const ticket = await createTicket('Wrong app secret');
    const body = JSON.stringify(
      withInstallation(prPayload({ action: 'opened', number: 201, branch: `story-${ticket.number}` })),
    );
    const res = await deliverApp('pull_request', null, {
      body,
      signature: signApp(body, 'not-the-app-secret'),
    });
    expect(res.statusCode).toBe(401);
    expect((await getTicket(ticket.id)).values[stateApi] ?? null).toBe(null);
    expect((await pullRecords()).some((p) => p.values.number === 201)).toBe(false);
  });

  /**
   * The #42 raw-body guard, now with the secret coming from env. Exact bytes that
   * do NOT survive a JSON round-trip must verify; the canonical-form signature for
   * those same bytes must be rejected. A `ping` needs no installation.
   */
  it('raw-body round-trip still holds with the env secret (exact bytes verify, canonical sig rejected)', async () => {
    const canonical = JSON.stringify({ zen: 'raw bytes matter' });
    const raw = `{  "zen"  :  "raw bytes matter"  }`;
    expect(raw).not.toBe(canonical);
    expect(signApp(raw)).not.toBe(signApp(canonical));

    const ok = await deliverApp('ping', null, { body: raw, signature: signApp(raw) });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().pong).toBe(true);

    const bad = await deliverApp('ping', null, { body: raw, signature: signApp(canonical) });
    expect(bad.statusCode).toBe(401);
  });

  it('unknown installation.id → 200 no-op (not 500, not a wrong-workspace write)', async () => {
    const ticket = await createTicket('Orphan installation');
    const res = await deliverApp(
      'pull_request',
      withInstallation(
        prPayload({ action: 'opened', number: 202, branch: `story-${ticket.number}` }),
        99999999, // no workspace has connected this installation
      ),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skipped).toBe('unknown_installation');
    expect((await getTicket(ticket.id)).values[stateApi] ?? null).toBe(null);
    expect((await pullRecords()).some((p) => p.values.number === 202)).toBe(false);
  });

  it('precedence: a delivery valid only under the legacy per-workspace secret is rejected on the App path', async () => {
    const ticket = await createTicket('Legacy sig under app path');
    const body = JSON.stringify(
      withInstallation(prPayload({ action: 'opened', number: 203, branch: `story-${ticket.number}` })),
    );
    // `sign` (top of file) uses the per-workspace SECRET — valid on the legacy
    // path, but the App path trusts only the env secret.
    const res = await deliverApp('pull_request', null, { body, signature: sign(body) });
    expect(res.statusCode).toBe(401);
    expect((await getTicket(ticket.id)).values[stateApi] ?? null).toBe(null);
  });

  it('never leaks the env webhook secret through the config/settings responses', async () => {
    const cfg = await as('GET', `/workspaces/${wsId}/integrations/github`);
    expect(cfg.body).not.toContain(APP_SECRET);
    expect(cfg.json().webhook_secret).toBeUndefined();
    const settings = await as('GET', `/workspaces/${wsId}`);
    expect(settings.body).not.toContain(APP_SECRET);
  });
});

describe('other events', () => {
  it('acks an unhandled event without touching anything', async () => {
    const res = await deliver('issues', { action: 'opened', repository: { full_name: 'acme/site' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().skipped).toBe('unhandled_event');
  });

  it('handles a push on a story branch (no state move by default)', async () => {
    const ticket = await createTicket('Pushed to');
    const res = await deliver('push', {
      ref: `refs/heads/story-${ticket.number}`,
      repository: { full_name: 'acme/site' },
      commits: [{ message: 'wip' }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().linked_record_id).toBe(ticket.id);
    expect(res.json().state_applied).toBe(null);
  });

  it('handles pull_request_review with a configured mapping', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { review_approved: 'Done' },
    });
    const ticket = await createTicket('Approved');
    const res = await deliver('pull_request_review', {
      action: 'submitted',
      repository: { full_name: 'acme/site' },
      review: { state: 'approved' },
      pull_request: prPayload({ action: 'x', number: 50, branch: `story-${ticket.number}` })
        .pull_request,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state_applied).toBe('Done');
    expect((await getTicket(ticket.id)).values[stateApi]).toBe(doneId);

    await as('POST', `/workspaces/${wsId}/integrations/github`, {
      state_automation: { review_approved: null },
    });
  });
});
