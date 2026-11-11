import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { workspaces } from '../src/db/schema';
import { GithubService } from '../src/integrations/github.service';
import { LinearService } from '../src/integrations/linear.service';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { backfillSealedSettings } from '../src/integrations/settings-secrets-backfill.subscriber';
import { isSealedSetting, openSetting } from '../src/common/settings-secret';

/**
 * Ticket #1239 — integration credentials in `workspaces.settings` are sealed at rest. Saving one through the API stores it sealed,
 * the services still use the plaintext, and values written in plaintext before the change are read as-is and sealed by the backfill.
 */
let app: NestFastifyApplication;
let db: Db;
let owner: { token: string; email: string };

const SLACK = 'xoxb-sealed-test-token';
const SLACK_HOOK = 'https://hooks.slack.com/services/T000/B000/sealedtest';
const GH_TOKEN = 'ghp_sealedtesttoken';
const GH_SECRET = 'sealed-webhook-secret';
const LINEAR = 'lin_api_sealedtest';

const fx = async (method: string, url: string, payload?: unknown) => {
  const r = await call(app, owner.token, method, url, payload);
  if (r.statusCode >= 300) throw new Error(`fixture ${method} ${url}: ${r.statusCode} ${r.body}`);
  return r.json();
};
const rawSettings = async (ws: string) =>
  ((await db.query.workspaces.findFirst({ where: eq(workspaces.id, ws) }))!.settings ?? {}) as Record<string, Record<string, unknown> & unknown>;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  owner = await signUpUser(app, 'Sealed Owner');
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('#1239 integration secrets are sealed at rest', () => {
  it('saving through the API stores ciphertext, and the services still read the plaintext', async () => {
    const ws = (await fx('POST', '/workspaces', { name: 'Sealed WS' })).id;
    await fx('POST', `/workspaces/${ws}/integrations/slack`, { bot_token: SLACK, webhook_url: SLACK_HOOK });
    await fx('POST', `/workspaces/${ws}/integrations/github`, { token: GH_TOKEN, webhook_secret: GH_SECRET });
    await fx('POST', `/workspaces/${ws}/integrations/linear`, { api_key: LINEAR });
    const signing = await app.get(WebhooksService).workspaceSigningSecret(ws);

    const raw = await rawSettings(ws);
    const dump = JSON.stringify(raw);
    for (const plain of [SLACK, SLACK_HOOK, GH_TOKEN, GH_SECRET, LINEAR, signing!]) expect(dump).not.toContain(plain);
    for (const v of [raw.slack!.bot_token, raw.slack!.webhook_url, raw.github!.token, raw.github!.webhook_secret, raw.linear!.api_key, raw.webhook_signing_secret]) {
      expect(isSealedSetting(v)).toBe(true);
    }

    const gh = await app.get(GithubService).readConfig(ws);
    expect([gh.token, gh.webhook_secret]).toEqual([GH_TOKEN, GH_SECRET]);
    expect((await app.get(LinearService).readLinearSettings(ws)).api_key).toBe(LINEAR);
    expect(await app.get(WebhooksService).workspaceSigningSecret(ws)).toBe(signing);

    // A save that does not touch the secret keeps it sealed (no double seal, no plaintext round-trip).
    await fx('POST', `/workspaces/${ws}/integrations/github`, { repos: ['acme/site'] });
    await fx('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['ENG'] });
    const after = await rawSettings(ws);
    expect(openSetting(after.github!.token as string)).toBe(GH_TOKEN);
    expect(openSetting(after.linear!.api_key as string)).toBe(LINEAR);
    // The API response still never carries them.
    expect(JSON.stringify(await fx('GET', `/workspaces/${ws}`))).not.toContain('sealed:');
  });

  it('legacy plaintext is read as-is, then sealed by the backfill exactly once', async () => {
    const ws = (await fx('POST', '/workspaces', { name: 'Legacy WS' })).id;
    const legacy = {
      slack: { bot_token: SLACK, webhook_url: SLACK_HOOK },
      github: { token: GH_TOKEN, webhook_secret: GH_SECRET, repos: ['acme/site'] },
      linear: { api_key: LINEAR, team_keys: ['ENG'] },
      webhook_signing_secret: 'whsec_legacy',
    };
    await db.update(workspaces).set({ settings: { ...(await rawSettings(ws)), ...legacy } }).where(eq(workspaces.id, ws));
    expect((await app.get(GithubService).readConfig(ws)).token).toBe(GH_TOKEN);

    await backfillSealedSettings(db);
    const raw = await rawSettings(ws);
    expect(JSON.stringify(raw)).not.toContain(GH_TOKEN);
    expect(raw.github!.repos).toEqual(['acme/site']);
    expect(openSetting(raw.slack!.webhook_url as string)).toBe(SLACK_HOOK);
    expect(openSetting(raw.webhook_signing_secret as unknown as string)).toBe('whsec_legacy');
    expect((await app.get(LinearService).readLinearSettings(ws)).api_key).toBe(LINEAR);

    // A second run leaves this workspace's (already sealed) values untouched. Other test files share the database, so the
    // global count is not asserted.
    await backfillSealedSettings(db);
    expect(await rawSettings(ws)).toEqual(raw);
  });

  it('one workspace with an unreadable sealed secret does not break GitHub deliveries for the others', async () => {
    const broken = (await fx('POST', '/workspaces', { name: 'Broken key WS' })).id;
    await db.update(workspaces).set({ settings: { github: { webhook_secret: 'sealed:v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA' } } }).where(eq(workspaces.id, broken));
    const good = (await fx('POST', '/workspaces', { name: 'Good key WS' })).id;
    const secret = `good-${good}`;
    await fx('POST', `/workspaces/${good}/integrations/github`, { webhook_secret: secret, repos: ['acme/sealed'] });
    const body = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'acme/not-selected' }, commits: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
