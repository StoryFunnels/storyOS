import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { connections, memberships } from '../src/db/schema';
import { seal } from '../src/common/secretbox';
import { CalendarSyncService } from '../src/calendar-sync/calendar-sync.service';
import { GithubService } from '../src/integrations/github.service';
import { SlackSubscriptionsService } from '../src/integrations/slack-subscriptions.service';

/**
 * Ticket #1377 (Vera's mutation: removing the wrap in the GitHub or the Calendar inbound sync left the suite green). Both inbound syncs
 * write records as `source: automation` through RecordsService.create, which is NOT an import by itself: each must run as an import run,
 * or a subscribed space gets one "created" message per synced record. A SPACE subscription is the worst case, so that is what is set.
 */
let app: NestFastifyApplication;
let svc: SlackSubscriptionsService;
let db: Db;
let admin: { token: string };
let ws: string;
const posted: string[] = [];
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const subscribeSpace = async (spaceId: string) => {
  const res = await inject('POST', `/workspaces/${ws}/integrations/slack/subscriptions`, { space_id: spaceId, channel: 'eng', events: ['created', 'status_changed'] });
  expect(res.statusCode, res.body).toBe(201);
};

beforeAll(async () => {
  app = await createTestApp();
  svc = app.get(SlackSubscriptionsService);
  db = app.get<Db>(DB);
  svc.sendIntervalMs = 0;
  svc.retryDelaysMs = [0];
  svc.slack.fetcher = async (_u, init) => {
    posted.push((JSON.parse(init.body) as { text: string }).text);
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  admin = await signUpUser(app, 'Inbound Syncs Admin');
  ws = (await inject('POST', '/workspaces', { name: 'Inbound Syncs WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/slack`, { bot_token: 'xoxb-test', default_channel: 'general' })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('Google Calendar inbound sync', () => {
  it('creates and updates records from Google events and posts 0 messages; a person\'s create in the same database posts 1', async () => {
    const spaceId = (await inject('POST', `/workspaces/${ws}/spaces`, { name: 'Calendar space' })).json().id as string;
    const tpl = await inject('POST', `/workspaces/${ws}/templates/calendar/apply`, { space_id: spaceId, include_samples: false });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const databaseId = tpl.json().databases.calendar as string;
    const fields = tpl.json().fields as Record<string, string>;
    await subscribeSpace(spaceId);
    const [connection] = await db
      .insert(connections)
      .values({
        workspaceId: ws, provider: 'google-calendar', name: 'Inbound Calendar', authSealed: seal(JSON.stringify({ access_token: 't' })),
        scopes: ['https://www.googleapis.com/auth/calendar'], status: 'active',
        createdBy: (await db.query.memberships.findFirst({ where: eq(memberships.workspaceId, ws) }))?.userId,
      })
      .returning();
    let summary = 'Imported planning session';
    const calendar = app.get(CalendarSyncService);
    calendar.fetcher = async (input) => {
      if (typeof input === 'string' && input.includes('/events?')) {
        return new Response(
          JSON.stringify({ items: [
            { id: 'ev-1', status: 'confirmed', summary, description: 'x', updated: new Date(Date.now() - 60_000).toISOString(), start: { date: '2026-07-25' }, end: { date: '2026-07-27' } },
            { id: 'ev-2', status: 'confirmed', summary: 'Second event', description: 'y', updated: new Date(Date.now() - 60_000).toISOString(), start: { date: '2026-08-01' }, end: { date: '2026-08-02' } },
          ] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected Calendar request: ${String(input)}`);
    };
    const binding = await inject('POST', `/workspaces/${ws}/integrations/google-calendar/bindings`, {
      connection_id: connection!.id, database_id: databaseId, calendar_id: 'primary', calendar_name: 'Primary',
      start_field_id: fields['calendar.start'], end_field_id: fields['calendar.end'], description_field_id: fields['calendar.description'], direction: 'pull',
    });
    expect(binding.statusCode, binding.body).toBe(201);
    posted.length = 0;
    const sync = await inject('POST', `/workspaces/${ws}/integrations/google-calendar/bindings/${binding.json().id}/sync`);
    expect(sync.statusCode, sync.body).toBe(201);
    const rows = (await inject('GET', `/workspaces/${ws}/databases/${databaseId}/records?limit=50`)).json().data as unknown[];
    expect(rows, 'the sync did create the records').toHaveLength(2);
    summary = 'Renamed in Google';
    expect((await inject('POST', `/workspaces/${ws}/integrations/google-calendar/bindings/${binding.json().id}/sync`)).statusCode).toBe(201);
    await svc.settle();
    expect(posted, 'an inbound calendar sync posts nothing').toEqual([]);
    expect((await inject('POST', `/workspaces/${ws}/databases/${databaseId}/records`, { values: { name: 'By a person' } })).statusCode).toBe(201);
    await svc.settle();
    expect(posted).toHaveLength(1);
  });
});

describe('GitHub inbound sync', () => {
  it('a second sync that creates a new issue and a new PR and closes an issue posts 0 messages; a person\'s create in the same database posts 1', async () => {
    const issues: Array<Record<string, unknown>> = [
      { number: 1, title: 'Fix header overflow', state: 'open', html_url: 'https://github.com/acme/site/issues/1', labels: [], assignee: null },
    ];
    const pulls: Array<Record<string, unknown>> = [
      { number: 10, title: 'Fix overflow', state: 'open', merged_at: null, html_url: 'https://github.com/acme/site/pull/10', user: { login: 'dana' }, head: { ref: 'fix/1-header' } },
    ];
    app.get(GithubService).fetcher = async (path) => {
      if (path.includes('/issues?')) return issues;
      if (path.includes('/pulls?')) return pulls;
      throw new Error(`unexpected path ${path}`);
    };
    expect((await inject('POST', `/workspaces/${ws}/integrations/github`, { token: 'ghp_test', repos: ['acme/site'] })).statusCode).toBe(201);
    // the first sync provisions the GitHub space and its databases; subscribe that space, then sync again with changes
    expect((await inject('POST', `/workspaces/${ws}/integrations/github/sync`)).statusCode).toBe(201);
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId?: string; space_id?: string }>;
    const issuesDb = dbs.find((d) => d.name === 'GitHub Issues')!;
    const spaceId = (issuesDb.spaceId ?? issuesDb.space_id)!;
    expect(spaceId).toBeTruthy();
    await subscribeSpace(spaceId);
    posted.length = 0;
    issues.push({ number: 2, title: 'Brand new issue', state: 'open', html_url: 'https://github.com/acme/site/issues/2', labels: [], assignee: null });
    issues[0] = { ...issues[0]!, state: 'closed' };
    pulls.push({ number: 11, title: 'Brand new PR', state: 'open', merged_at: null, html_url: 'https://github.com/acme/site/pull/11', user: { login: 'max' }, head: { ref: 'chore/new' } });
    const second = await inject('POST', `/workspaces/${ws}/integrations/github/sync`);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().issues).toBe(2);
    expect(second.json().pulls).toBe(2);
    const list = (await inject('GET', `/workspaces/${ws}/databases/${issuesDb.id}/records?limit=50`)).json().data as Array<{ title: string }>;
    expect(list.map((r) => r.title), 'the sync created the new issue').toContain('Brand new issue');
    await svc.settle();
    expect(posted, 'an inbound GitHub sync posts nothing').toEqual([]);
    expect((await inject('POST', `/workspaces/${ws}/databases/${issuesDb.id}/records`, { values: { name: 'By a person' } })).statusCode).toBe(201);
    await svc.settle();
    expect(posted).toHaveLength(1);
  });
});
