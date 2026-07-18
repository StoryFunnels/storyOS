import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { automations, fields } from '../src/db/schema';

/**
 * #249 — outbound-webhook Authorization headers must be write-only. Header VALUES
 * are never returned (any viewer, guests included), and editing an unrelated part
 * of a config must not clobber the stored credential.
 */

let app: NestFastifyApplication;
let db: Db;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let guestId: string;
let wsId: string;
let spaceId: string;
let dbId: string;
let buttonId: string;
let ruleId: string;

const SECRET = 'Bearer sk-live-do-not-leak-000';
const COOKIE = 'session=super-secret-cookie';

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}
const asAdmin = (method: string, url: string, payload?: unknown) => as(admin.token, method, url, payload);

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admin = await signUpUser(app, 'HookAdmin');
  guest = await signUpUser(app, 'HookGuest');
  guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await asAdmin('POST', '/workspaces', { name: 'Hook WS' })).json().id;
  spaceId = (await asAdmin('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await asAdmin('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tickets' })).json().id;

  // A button field whose send_webhook action carries credential headers.
  const button = await asAdmin('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Ping',
    type: 'button',
    config: {
      color: 'green',
      actions: [
        {
          type: 'send_webhook',
          url: 'https://hooks.example.com/ping',
          headers: { Authorization: SECRET, Cookie: COOKIE, 'Content-Type': 'application/json' },
        },
      ],
    },
  });
  expect(button.statusCode, button.body).toBe(201);
  buttonId = button.json().id;

  // An automation whose send_webhook action carries a credential header.
  const rule = await asAdmin('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
    name: 'Notify hook',
    trigger: { type: 'record_created' },
    actions: [{ type: 'send_webhook', url: 'https://hooks.example.com/auto', headers: { Authorization: SECRET } }],
  });
  expect(rule.statusCode, rule.body).toBe(201);
  ruleId = rule.json().id;

  // Invite the guest: viewer on the space (reaches the fields/introspection read)
  // and creator on the db (reaches the automations list — worst case for that read).
  const invite = await asAdmin('POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ space_id: spaceId, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
  const grant = await asAdmin('POST', `/workspaces/${wsId}/grants`, {
    user_id: guestId,
    database_id: dbId,
    role: 'creator',
  });
  expect(grant.statusCode, grant.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

/** The raw stored button config, straight from the row (bypasses presentation). */
async function storedButtonHeaders(): Promise<Record<string, string>> {
  const row = await db.query.fields.findFirst({ where: eq(fields.id, buttonId) });
  const config = row!.config as { actions: Array<{ type: string; headers?: Record<string, string> }> };
  return config.actions.find((a) => a.type === 'send_webhook')!.headers ?? {};
}
async function storedRuleHeaders(): Promise<Record<string, string>> {
  const row = await db.query.automations.findFirst({ where: eq(automations.id, ruleId) });
  const acts = row!.actions as Array<{ type: string; headers?: Record<string, string> }>;
  return acts.find((a) => a.type === 'send_webhook')!.headers ?? {};
}

function buttonActionsFromIntrospection(body: {
  fields: Array<{ id: string; config: { actions?: Array<Record<string, unknown>> } }>;
}) {
  return body.fields.find((f) => f.id === buttonId)!.config.actions!;
}

describe('#249 read side — header VALUES never leave', () => {
  it('button field config: admin never receives the secret header values', async () => {
    const res = await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(COOKIE);
    const webhook = buttonActionsFromIntrospection(res.json()).find((a) => a.type === 'send_webhook')!;
    expect(webhook.headers).toEqual({
      Authorization: { __keep: true },
      Cookie: { __keep: true },
      'Content-Type': 'application/json', // non-secret header stays readable
    });
  });

  it('button field config: a GUEST viewer never receives the secret header values', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(COOKIE);
    const webhook = buttonActionsFromIntrospection(res.json()).find((a) => a.type === 'send_webhook')!;
    expect(webhook.headers!.Authorization).toEqual({ __keep: true });
  });

  it('automation actions: admin never receives the secret header value', async () => {
    const res = await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}/automations`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const rule = res.json().data.find((r: { id: string }) => r.id === ruleId);
    expect(rule.actions[0].headers).toEqual({ Authorization: { __keep: true } });
  });

  it('automation actions: a GUEST never receives the secret header value', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/automations`);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET);
    const rule = res.json().data.find((r: { id: string }) => r.id === ruleId);
    expect(rule.actions[0].headers.Authorization).toEqual({ __keep: true });
  });
});

describe('#249 round-trip — an unrelated edit must not clobber the credential', () => {
  it('button config: reload, change color, save the whole config back → stored secret intact', async () => {
    // Load the way the UI does — the presented config with { __keep: true } flags.
    const loaded = (await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const config = loaded.fields.find((f: { id: string }) => f.id === buttonId).config;
    expect(config.actions[0].headers.Authorization).toEqual({ __keep: true });

    // Edit an UNRELATED part (color) and PATCH the whole config back verbatim.
    const patched = await asAdmin('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${buttonId}`, {
      config: { ...config, color: 'blue' },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const stored = await storedButtonHeaders();
    expect(stored.Authorization).toBe(SECRET); // NOT clobbered to a flag/empty
    expect(stored.Cookie).toBe(COOKIE);
    expect(stored['Content-Type']).toBe('application/json');
  });

  it('automation: reload, change name, save actions back → stored secret intact', async () => {
    const list = (await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}/automations`)).json();
    const rule = list.data.find((r: { id: string }) => r.id === ruleId);
    expect(rule.actions[0].headers.Authorization).toEqual({ __keep: true });

    const patched = await asAdmin('PATCH', `/workspaces/${wsId}/databases/${dbId}/automations/${ruleId}`, {
      name: 'Renamed hook',
      actions: rule.actions, // whole array back, headers still flagged
    });
    expect(patched.statusCode, patched.body).toBe(200);

    const stored = await storedRuleHeaders();
    expect(stored.Authorization).toBe(SECRET);
  });
});

describe('#249 UI contract — a header can be shown-as-set and replaced without ever reading it', () => {
  it('replacing the Authorization value with a new string persists the new value', async () => {
    const loaded = (await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}`)).json();
    const config = loaded.fields.find((f: { id: string }) => f.id === buttonId).config;
    const actions = config.actions.map((a: Record<string, unknown>) =>
      a.type === 'send_webhook'
        ? { ...a, headers: { ...(a.headers as object), Authorization: 'Bearer sk-live-rotated-111' } }
        : a,
    );
    const patched = await asAdmin('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${buttonId}`, {
      config: { ...config, actions },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    // New value never appears in the presented response.
    expect(patched.body).not.toContain('sk-live-rotated-111');
    expect((await storedButtonHeaders()).Authorization).toBe('Bearer sk-live-rotated-111');
    // Cookie was left as a flag → preserved.
    expect((await storedButtonHeaders()).Cookie).toBe(COOKIE);
  });
});

describe('#249 legacy configs — a plain string still works and is never leaked', () => {
  it('an automation created without ever presenting still hides its header on read', async () => {
    // Simulate a legacy row written before this change (raw string headers in jsonb).
    const legacy = await asAdmin('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
      name: 'Legacy hook',
      trigger: { type: 'record_created' },
      actions: [{ type: 'send_webhook', url: 'https://h/legacy', headers: { Authorization: 'Bearer legacy-xyz' } }],
    });
    expect(legacy.statusCode, legacy.body).toBe(201);
    const res = await asAdmin('GET', `/workspaces/${wsId}/databases/${dbId}/automations`);
    expect(res.body).not.toContain('legacy-xyz');
    const rule = res.json().data.find((r: { id: string }) => r.id === legacy.json().id);
    expect(rule.actions[0].headers.Authorization).toEqual({ __keep: true });
  });
});
