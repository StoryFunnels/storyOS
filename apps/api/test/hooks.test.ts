import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { AutomationsService } from '../src/automations/automations.service';
import { signPayload } from '../src/webhooks/webhook-sender';

let app: NestFastifyApplication;
let engine: AutomationsService;
let admin: { token: string; email: string };
let wsId: string;
let wsSlug: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

/** Raw, unauthenticated hit against the public receiver — no admin token. */
async function hook(
  workspaceSlug: string,
  hookToken: string,
  body: string,
  opts: { contentType?: string; signature?: string; timestamp?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/hooks/${workspaceSlug}/${hookToken}`,
    headers: {
      'content-type': opts.contentType ?? 'application/json',
      ...(opts.signature ? { 'x-storyos-signature': opts.signature } : {}),
      ...(opts.timestamp ? { 'x-storyos-timestamp': opts.timestamp } : {}),
    },
    payload: body,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  engine = app.get(AutomationsService);
  admin = await signUpUser(app, 'HookOperator');
  const ws = (await inject('POST', '/workspaces', { name: 'Hook WS' })).json();
  wsId = ws.id;
  wsSlug = ws.slug;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (
    await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Leads' })
  ).json().id;
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Email',
    type: 'email',
    config: {},
  });
});

afterAll(async () => {
  await app.close();
});

describe('webhook_received rules (MN-254)', () => {
  it('create mints a token + secret; the trigger cannot carry a condition', async () => {
    const withCondition = await inject(
      'POST',
      `/workspaces/${wsId}/databases/${dbId}/automations`,
      {
        name: 'No conditions yet',
        trigger: { type: 'webhook_received' },
        condition: { field: 'name', op: 'is_empty' },
        actions: [{ type: 'create_record', database_id: dbId, values: { name: 'x' } }],
      },
    );
    expect(withCondition.statusCode).toBe(422);

    const rule = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Inbound leads',
      trigger: { type: 'webhook_received' },
      actions: [
        {
          type: 'create_record',
          database_id: dbId,
          values: { name: '{payload.name}', email: '{payload.email}' },
        },
      ],
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const body = rule.json();
    expect(typeof body.hookToken).toBe('string');
    expect(body.hookToken.length).toBeGreaterThan(10);
    expect(typeof body.hookSecret).toBe('string');
    expect(body.hookSecret.startsWith('whin_')).toBe(true);
  });

  it('rejects record-dependent actions on a webhook_received rule', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Bad actions',
      trigger: { type: 'webhook_received' },
      actions: [{ type: 'set_values', values: { name: 'nope' } }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('valid POST creates the mapped record and a run row, dot-paths included', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Map lead',
        trigger: { type: 'webhook_received' },
        actions: [
          {
            type: 'create_record',
            database_id: dbId,
            values: { name: '{payload.contact.name}', email: '{payload.contact.email}' },
          },
        ],
      })
    ).json();

    const res = await hook(
      wsSlug,
      rule.hookToken,
      JSON.stringify({ contact: { name: 'Ada Lovelace', email: 'ada@example.com' } }),
    );
    expect(res.statusCode, res.body).toBe(202);
    const runId = res.json().run_id;
    expect(typeof runId).toBe('string');
    await engine.settleHook(runId);

    const runs = (
      await inject('GET', `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/runs`)
    ).json();
    const run = runs.data.find((r: { id: string }) => r.id === runId);
    expect(run?.status).toBe('ok');

    const records = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json();
    expect(records.data.some((r: { title: string }) => r.title === 'Ada Lovelace')).toBe(true);

    const lastPayload = (
      await inject(
        'GET',
        `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/last-payload`,
      )
    ).json();
    expect(lastPayload.last_hook_payload.contact.name).toBe('Ada Lovelace');
  });

  it('an array index in the payload path resolves correctly', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Map first answer',
        trigger: { type: 'webhook_received' },
        actions: [
          {
            type: 'create_record',
            database_id: dbId,
            values: { name: '{payload.answers.0.value}' },
          },
        ],
      })
    ).json();
    const res = await hook(
      wsSlug,
      rule.hookToken,
      JSON.stringify({ answers: [{ value: 'First answer' }, { value: 'Second' }] }),
    );
    expect(res.statusCode).toBe(202);
    await engine.settleHook(res.json().run_id);
    const records = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json();
    expect(records.data.some((r: { title: string }) => r.title === 'First answer')).toBe(true);
  });

  it('form-encoded bodies are converted to an object', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Form lead',
        trigger: { type: 'webhook_received' },
        actions: [
          { type: 'create_record', database_id: dbId, values: { name: '{payload.full_name}' } },
        ],
      })
    ).json();
    const res = await hook(wsSlug, rule.hookToken, 'full_name=Grace+Hopper&source=landing', {
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.statusCode, res.body).toBe(202);
    await engine.settleHook(res.json().run_id);
    const records = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records`)).json();
    expect(records.data.some((r: { title: string }) => r.title === 'Grace Hopper')).toBe(true);
  });

  it('an unknown token 404s with no detail', async () => {
    const res = await hook(wsSlug, 'not-a-real-token', '{}');
    expect(res.statusCode).toBe(404);
  });

  it('a tampered signature 401s when a secret is configured', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Signed rule',
        trigger: { type: 'webhook_received' },
        actions: [{ type: 'create_record', database_id: dbId, values: { name: 'from webhook' } }],
      })
    ).json();
    const body = JSON.stringify({ ok: true });
    const timestamp = Math.floor(Date.now() / 1000);
    const validSig = signPayload(rule.hookSecret, body, timestamp);

    const tampered = await hook(wsSlug, rule.hookToken, body, {
      signature: `sha256=${validSig.slice(0, -4)}0000`,
      timestamp: String(timestamp),
    });
    expect(tampered.statusCode).toBe(401);

    const missing = await hook(wsSlug, rule.hookToken, body, {});
    expect(missing.statusCode).toBe(401);

    const ok = await hook(wsSlug, rule.hookToken, body, {
      signature: `sha256=${validSig}`,
      timestamp: String(timestamp),
    });
    expect(ok.statusCode).toBe(202);
  });

  it('regenerating the hook invalidates the old token immediately', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Rotate me',
        trigger: { type: 'webhook_received' },
        actions: [{ type: 'create_record', database_id: dbId, values: { name: 'x' } }],
      })
    ).json();
    const oldToken = rule.hookToken;

    const regenerated = (
      await inject(
        'POST',
        `/workspaces/${wsId}/databases/${dbId}/automations/${rule.id}/regenerate-hook`,
        {},
      )
    ).json();
    expect(regenerated.hookToken).not.toBe(oldToken);

    const usingOld = await hook(wsSlug, oldToken, '{}');
    expect(usingOld.statusCode).toBe(404);

    const usingNew = await hook(wsSlug, regenerated.hookToken, '{}');
    expect(usingNew.statusCode).toBe(202);
  });

  it('an oversized body 413s', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Size capped',
        trigger: { type: 'webhook_received' },
        actions: [{ type: 'create_record', database_id: dbId, values: { name: 'x' } }],
      })
    ).json();
    const oversized = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
    const res = await hook(wsSlug, rule.hookToken, oversized);
    expect(res.statusCode).toBe(413);
  });

  it('429s once a single hook exceeds 60 requests in a minute', async () => {
    const rule = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Rate limited',
        trigger: { type: 'webhook_received' },
        actions: [{ type: 'create_record', database_id: dbId, values: { name: 'x' } }],
      })
    ).json();
    let sawTooMany = false;
    for (let i = 0; i < 65; i++) {
      const res = await hook(wsSlug, rule.hookToken, '{}');
      if (res.statusCode === 429) {
        sawTooMany = true;
        break;
      }
    }
    expect(sawTooMany).toBe(true);
  });
});
