import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService } from '../src/integrations/linear.service';
import { SlackSubscriptionsService } from '../src/integrations/slack-subscriptions.service';

/**
 * Ticket #1377 - the rule "an import is not news" proven through the REAL Linear sync (not only through the event stamps): a space
 * subscription is set BEFORE the first import, so the import has every chance to post and must not.
 *
 *   first (full) import of 3 issues ............................ 0 messages (no 5,000 "created" lines for a project import)
 *   scheduled INCREMENTAL run, one issue moved + one new ......... 1 message: the status change, "via sync"; the new issue posts nothing
 *   daily FULL read that moves another issue ..................... 0 messages (a full read touches every record)
 */
const HOUR = 3_600_000;
const TEAM = { id: 'team-slack', key: 'SL', name: 'Slack Sync' };
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const OLD = '2020-01-01T00:00:00.000Z';
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  ...manyIssues(1)[0]!, id: `s${n}`, identifier: `SL-${n}`, title: `Slack issue ${n}`, description: null, updatedAt: OLD, ...extra,
});

describe('a Slack subscription over a Linear mirror', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let svc: SlackSubscriptionsService;
  let db: Db;
  let admin: { token: string };
  let ws: string;
  const posted: string[] = [];
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const use = (issues: Array<Record<string, unknown>>) => {
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues } } }]).fetcher;
  };
  const later = (hours: number) => new Date(Date.now() + hours * HOUR);

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    svc = app.get(SlackSubscriptionsService);
    db = app.get<Db>(DB);
    svc.sendIntervalMs = 0;
    svc.retryDelaysMs = [0];
    svc.slack.fetcher = async (_url, init) => {
      posted.push((JSON.parse(init.body) as { text: string }).text);
      return { status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    admin = await signUpUser(app, 'Slack Sync Admin');
    ws = (await inject('POST', '/workspaces', { name: 'Slack Sync WS' })).json().id;
    expect((await inject('POST', `/workspaces/${ws}/integrations/slack`, { bot_token: 'xoxb-test', default_channel: 'general' })).statusCode).toBe(201);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['SL'] })).statusCode).toBe(201);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { auto_sync: { enabled: true } })).statusCode).toBe(201);
    // the sync imports into a space named "<team> (Linear)" when one exists: make it first and subscribe it before anything is imported
    const space = (await inject('POST', `/workspaces/${ws}/spaces`, { name: `${TEAM.name} (Linear)` })).json().id as string;
    const sub = await inject('POST', `/workspaces/${ws}/integrations/slack/subscriptions`, { space_id: space, channel: 'eng', events: ['created', 'status_changed', 'commented'] });
    expect(sub.statusCode, sub.body).toBe(201);
  }, 120_000);
  afterAll(async () => { await app.close(); });

  it('the first (full) import posts nothing, though every record is new', async () => {
    use([issue(1), issue(2), issue(3)]);
    await linear.tick();
    await svc.settle();
    const rows = (await inject('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Issues');
    const recs = (await inject('GET', `/workspaces/${ws}/databases/${rows.id}/records?limit=50`)).json().data as unknown[];
    expect(recs, 'the import did create the records').toHaveLength(3);
    expect(posted).toEqual([]);
  });

  it('a scheduled INCREMENTAL run posts the status change it carries (via sync) and nothing for the issue it created', async () => {
    const fresh = new Date(Date.now() + 5_000).toISOString();
    use([issue(1, { updatedAt: fresh, state: { type: 'started', name: 'In Progress' } }), issue(2), issue(3), issue(4, { updatedAt: fresh })]);
    await linear.tick(later(1.1));
    await svc.settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain('Slack issue 1');
    expect(posted[0]).toContain('In Progress');
    expect(posted[0]).toContain('via sync');
    expect(posted.join('\n')).not.toContain('Slack issue 4');
  });

  it('the daily FULL read posts nothing, even for a status change it carries', async () => {
    await db.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,sync_status,last_full_at}', to_jsonb(${new Date(Date.now() - 48 * HOUR).toISOString()}::text)) WHERE id = ${ws}`);
    const fresh = new Date(Date.now() + 10_000).toISOString();
    use([issue(1, { state: { type: 'started', name: 'In Progress' } }), issue(2, { updatedAt: fresh, state: { type: 'completed', name: 'Done' } }), issue(3), issue(4)]);
    await linear.tick(later(3));
    await svc.settle();
    const last = (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync.last_run;
    expect(last.mode, 'this run really was a full read').toBe('full');
    expect(posted).toHaveLength(1); // still just the incremental one
  });
});
