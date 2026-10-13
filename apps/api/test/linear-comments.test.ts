import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService, fetchTeamData } from '../src/integrations/linear.service';

/**
 * #903 — Linear comments come across with their real author, time and body, are paged to the end, are idempotent, and
 * notify nobody. The decisions live in comments; a migration without them keeps the tickets and loses the history.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-c', key: 'CM', name: 'Comments' };
const comment = (n: number, issueId: string, extra: Record<string, unknown> = {}) => ({
  id: `c${n}`, body: `Comment **${n}** body`, createdAt: new Date(Date.UTC(2026, 8, 14, 10, 0, n)).toISOString(),
  url: `https://linear.app/acme/issue/CM-1#comment-c${n}`, user: { name: 'Tyron Dizon' }, botActor: null, externalUser: null, issue: { id: issueId }, ...extra,
});

describe('#903 reading comments (pure)', () => {
  it('pages 250 comments across several pages and fails on a comment whose issue was not read', async () => {
    const issues = manyIssues(2);
    const many = Array.from({ length: 250 }, (_, i) => comment(i, 'iss-0'));
    const ok = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues }, comments: many } }]);
    const data = await fetchTeamData(ok.fetcher, 'k', TEAM);
    expect(data.comments.nodes).toHaveLength(250);
    expect(ok.calls.filter((c) => c === 'TeamComments'), '250 at 100 a page').toHaveLength(3);
    const orphan = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues }, comments: [comment(1, 'iss-GONE')] } }]);
    await expect(fetchTeamData(orphan.fetcher, 'k', TEAM)).rejects.toThrow(/1 comments on issues that were not read/);
  });
});

describe('#903 importing comments', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let admin: { token: string };
  let ws: string;
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const use = (comments: Array<Record<string, unknown>>) => {
    linear = app.get(LinearService);
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(2) }, comments } }]).fetcher;
  };
  const issuesDb = async () => (await inject('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Issues');
  const commentsOf = async (title: string) => {
    const db = await issuesDb();
    const recs = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records?limit=10`)).json().data as Array<{ id: string; title: string }>;
    const rec = recs.find((r) => r.title === title)!;
    return (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}/comments`)).json().data as Array<{ body: { doc: unknown[] }; source: string; created_at: string }>;
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await signUpUser(app, 'Linear Commenter');
    ws = (await inject('POST', '/workspaces', { name: 'Linear Comments WS' })).json().id;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['CM'] })).statusCode).toBe(201);
  }, 120_000);
  afterAll(async () => { await app.close(); });

  it('the preview counts comments per team', async () => {
    use([comment(1, 'iss-0'), comment(2, 'iss-0'), comment(3, 'iss-1')]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().teams[0].comments).toBe(3);
  });

  it('every comment arrives with its real author, original time and body, marked as imported', async () => {
    use([
      comment(2, 'iss-0', { user: null, botActor: { name: 'GitHub' } }),
      comment(1, 'iss-0'),
      comment(3, 'iss-1', { user: null, externalUser: { name: 'Pat (external)' } }),
    ]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comments).toEqual({ fetched: 3, created: 3, already_present: 0 });
    const first = await commentsOf('Issue 1');
    expect(first.map((c) => JSON.stringify(c.body))).toHaveLength(2);
    // at the ORIGINAL time, not "now" (the comments list is newest-first)
    expect(first.map((c) => c.created_at)).toEqual(['2026-09-14T10:00:02.000Z', '2026-09-14T10:00:01.000Z']);
    const text = (c: { body: { doc: unknown[] } }) => JSON.stringify(c.body.doc);
    expect(text(first[1]!)).toContain('Tyron Dizon · 2026-09-14 10:00 UTC (from Linear)');
    expect(text(first[1]!)).toContain('Comment ');
    expect(text(first[0]!)).toContain('GitHub · 2026-09-14 10:00 UTC (from Linear)');
    expect(text(first[1]!), 'a link back to the original').toContain('https://linear.app/acme/issue/CM-1#comment-c1');
    expect(first.every((c) => c.source === 'automation'), 'not attributed to a person').toBe(true);
    const second = await commentsOf('Issue 2');
    expect(text(second[0]!)).toContain('Pat (external) · ');
  });

  it('is idempotent: a second sync adds nothing, and a comment deleted in StoryOS stays deleted', async () => {
    const before = await commentsOf('Issue 1');
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comments).toEqual({ fetched: 3, created: 0, already_present: 3 });
    expect(await commentsOf('Issue 1')).toHaveLength(before.length);
    // a person deletes one imported comment; a re-run must not bring it back
    const db = await issuesDb();
    const recs = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records?limit=10`)).json().data as Array<{ id: string; title: string }>;
    const rec = recs.find((r) => r.title === 'Issue 1')!;
    const list = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}/comments`)).json().data as Array<{ id: string }>;
    expect((await inject('DELETE', `/workspaces/${ws}/databases/${db.id}/records/${rec.id}/comments/${list[0]!.id}`)).statusCode).toBeLessThan(300);
    await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(await commentsOf('Issue 1'), 'the deleted one is not recreated').toHaveLength(before.length - 1);
  });

  it('imports notify nobody and write no activity', async () => {
    const db = app.get(DB) as Db;
    const notes = await db.execute(sql`select count(*)::int as n from notifications where workspace_id = ${ws}`);
    expect((notes.rows[0] as { n: number }).n).toBe(0);
    const events = await db.execute(sql`select count(*)::int as n from activity_events where workspace_id = ${ws} and type = 'comment.created'`);
    expect((events.rows[0] as { n: number }).n).toBe(0);
  });
});
