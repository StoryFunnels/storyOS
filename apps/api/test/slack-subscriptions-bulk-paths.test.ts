import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { ConnectionsService } from '../src/connections/connections.service';
import { SourcesService } from '../src/sources/sources.service';
import { SlackSubscriptionsService } from '../src/integrations/slack-subscriptions.service';
import type { ConnectionFetcher } from '../src/connections/providers';

/**
 * Ticket #1377 (sent back by Vera) - every BULK way a record is written other than a person typing must post nothing to a Slack channel
 * subscription: a source sync (Shopify, Apify, engagement), a CSV import, a template's sample data. A subscribed SPACE is the worst case
 * (it covers every database in it), so that is what is subscribed. A person's own create is the control in each test.
 */
let app: NestFastifyApplication;
let svc: SlackSubscriptionsService;
let sources: SourcesService;
let admin: { token: string };
let ws: string;
let spaceId: string;
const posted: string[] = [];
const inject = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: { ...authed(admin.token), ...headers }, payload: payload as never });

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(SlackSubscriptionsService);
  sources = app.get(SourcesService);
  svc.sendIntervalMs = 0;
  svc.retryDelaysMs = [0];
  svc.slack.fetcher = async (_u, init) => {
    posted.push((JSON.parse(init.body) as { text: string }).text);
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  app.get(ConnectionsService).fetcher = (async () => ({ status: 200, json: async () => ({}), text: async () => '' })) as ConnectionFetcher;
  admin = await signUpUser(app, 'Bulk Paths Admin');
  ws = (await inject('POST', '/workspaces', { name: 'Bulk Paths WS' })).json().id;
  spaceId = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/slack`, { bot_token: 'xoxb-test', default_channel: 'general' })).statusCode).toBe(201);
  const sub = await inject('POST', `/workspaces/${ws}/integrations/slack/subscriptions`, { space_id: spaceId, channel: 'eng', events: ['created', 'status_changed', 'commented'] });
  expect(sub.statusCode, sub.body).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('bulk writes that are not a person typing post nothing', () => {
  it('a source sync (Apify) creates and updates records and posts 0 messages; a person\'s create in the same database posts 1', async () => {
    const dbId = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Synced pages' })).json().id as string;
    const field = async (n: string) => (await inject('POST', `/workspaces/${ws}/databases/${dbId}/fields`, { display_name: n, type: 'text', config: {} })).json() as { id: string };
    const url = await field('URL');
    const title = await field('Title');
    const conn = await inject('POST', `/workspaces/${ws}/connections`, { provider: 'apify', name: 'Apify bulk', auth: { api_key: 'apify_test_token' } });
    expect(conn.statusCode, conn.body).toBe(201);
    const src = await inject('POST', `/workspaces/${ws}/databases/${dbId}/sources`, {
      name: 'pages', connection_id: conn.json().id, provider_source: 'apify.actor',
      config: { actor_id: 'apify/website-content-crawler', input: {}, monthly_run_cap: 5 },
      field_mapping: { url: url.id, title: title.id }, external_key_field_id: url.id, schedule: '15m',
    });
    expect(src.statusCode, src.body).toBe(201);
    let items = [{ url: 'https://a.example', title: 'A' }, { url: 'https://b.example', title: 'B' }, { url: 'https://c.example', title: 'C' }];
    sources.fetcher = async (u, init) => {
      const method = init.method ?? 'GET';
      if (method === 'POST' && u.includes('/acts/') && !u.includes('actor-runs')) return { status: 200, json: async () => ({ data: { id: 'run_1' } }), text: async () => '' };
      if (u.includes('/actor-runs/')) return { status: 200, json: async () => ({ data: { id: 'run_1', status: 'SUCCEEDED', defaultDatasetId: 'ds_1', usageTotalUsd: 0.01, stats: { computeUnits: 0.01 } } }), text: async () => '' };
      if (u.includes('/datasets/')) return { status: 200, json: async () => items, text: async () => '' };
      throw new Error(`unexpected ${method} ${u}`);
    };
    posted.length = 0;
    const first = await inject('POST', `/workspaces/${ws}/databases/${dbId}/sources/${src.json().id}/sync-now`);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual(expect.objectContaining({ status: 'ok', created: 3 }));
    items = [{ url: 'https://a.example', title: 'A renamed' }, ...items.slice(1)];
    const second = await inject('POST', `/workspaces/${ws}/databases/${dbId}/sources/${src.json().id}/sync-now`);
    expect(second.statusCode, second.body).toBe(201);
    await svc.settle();
    expect(posted, 'a sync must post nothing').toEqual([]);
    // control: the same database, a person
    expect((await inject('POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: 'By a person' } })).statusCode).toBe(201);
    await svc.settle();
    expect(posted).toHaveLength(1);
  });

  it('a CSV import posts nothing (it suppresses events altogether), and a template\'s sample data posts nothing', async () => {
    const dbId = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: spaceId, name: 'Imported rows' })).json().id as string;
    const boundary = 'X-B';
    const csv = 'Name\nOne\nTwo\nThree';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="mapping"\r\n\r\n${JSON.stringify([{ column: 'Name', to: { kind: 'title' } }])}\r\n--${boundary}\r\nContent-Disposition: form-data; name="dry_run"\r\n\r\nfalse\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    posted.length = 0;
    const res = await inject('POST', `/workspaces/${ws}/databases/${dbId}/import`, body, { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect(res.statusCode, res.body).toBe(201);
    const rows = (await inject('GET', `/workspaces/${ws}/databases/${dbId}/records?limit=50`)).json().data as unknown[];
    expect(rows, 'the import wrote the rows').toHaveLength(3);
    const tpl = await inject('POST', `/workspaces/${ws}/templates/funnels/apply`, { space_id: spaceId, include_samples: true });
    expect(tpl.statusCode, tpl.body).toBe(201);
    expect(tpl.json().sample_records, 'the template did create sample records').toBeGreaterThan(0);
    await svc.settle();
    expect(posted).toEqual([]);
  });
});
