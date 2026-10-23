import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { FULL_REFRESH_HOURS, INCREMENTAL_OVERLAP_MINUTES, LinearService, planSyncMode } from '../src/integrations/linear.service';

/**
 * #1027 — a scheduled run reads only what Linear changed since the last success, with a full read once a day. The rule
 * that decides which is a pure function (table below); the rest proves the sync honours it end to end: what an
 * incremental run does NOT do (count check, left-scope), what it MUST still do (pick up a change, place a comment on an
 * unchanged issue) and that a failed run leaves the cursor where it was.
 */
const HOUR = 3_600_000;
const now = new Date('2026-10-24T12:00:00Z');
const status = (over: Record<string, unknown> = {}) => ({
  cursor_at: new Date(now.getTime() - HOUR).toISOString(),
  last_full_at: new Date(now.getTime() - 2 * HOUR).toISOString(),
  synced_teams: ['IN'],
  ...over,
});

describe('#1027 planSyncMode (pure)', () => {
  it('a scheduled run with a fresh cursor and the same teams is incremental, reading from a little BEFORE the cursor', () => {
    const plan = planSyncMode(status(), now, ['IN'], true);
    expect(plan.mode).toBe('incremental');
    expect(plan.since).toBe(new Date(now.getTime() - HOUR - INCREMENTAL_OVERLAP_MINUTES * 60_000).toISOString());
  });

  it.each([
    ['a manual run', () => planSyncMode(status(), now, ['IN'], false)],
    ['no status yet', () => planSyncMode(undefined, now, ['IN'], true)],
    ['no cursor', () => planSyncMode(status({ cursor_at: undefined }), now, ['IN'], true)],
    ['no full read ever recorded (an install from before this)', () => planSyncMode(status({ last_full_at: undefined }), now, ['IN'], true)],
    ['the last full read is a day old', () => planSyncMode(status({ last_full_at: new Date(now.getTime() - FULL_REFRESH_HOURS * HOUR).toISOString() }), now, ['IN'], true)],
    ['a team was added', () => planSyncMode(status(), now, ['IN', 'SF'], true)],
    ['a team was removed', () => planSyncMode(status({ synced_teams: ['IN', 'SF'] }), now, ['IN'], true)],
    ['the last run recorded no teams', () => planSyncMode(status({ synced_teams: [] }), now, ['IN'], true)],
    ['an unreadable cursor', () => planSyncMode(status({ cursor_at: 'not a date' }), now, ['IN'], true)],
  ])('is FULL for %s', (_name, plan) => {
    const p = plan();
    expect(p.mode).toBe('full');
    expect(p.since).toBeUndefined();
  });

  it('a day-old full read is still incremental one minute short of the limit (the boundary is where it says)', () => {
    const p = planSyncMode(status({ last_full_at: new Date(now.getTime() - FULL_REFRESH_HOURS * HOUR + 60_000).toISOString() }), now, ['IN'], true);
    expect(p.mode).toBe('incremental');
  });

  it('team order does not matter', () => {
    expect(planSyncMode(status({ synced_teams: ['SF', 'IN'] }), now, ['IN', 'SF'], true).mode).toBe('incremental');
  });
});

const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-inc', key: 'IN', name: 'Incremental' };
const OLD = '2020-01-01T00:00:00.000Z';
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  ...manyIssues(1)[0]!, id: `i${n}`, identifier: `IN-${n}`, title: `Issue ${n}`, description: null, updatedAt: OLD, ...extra,
});
const comment = (n: number, issueId: string, extra: Record<string, unknown> = {}) => ({
  id: `c${n}`, body: `Comment ${n}`, createdAt: new Date(Date.UTC(2026, 9, 24, 9, 0, n)).toISOString(), updatedAt: OLD,
  url: `https://linear.app/acme/issue/IN-1#comment-c${n}`, user: { name: 'Tyron Dizon' }, botActor: null, externalUser: null, issue: { id: issueId }, ...extra,
});

describe('#1027 incremental sync end to end', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let db: Db;
  let admin: { token: string };
  let ws: string;
  let fake: ReturnType<typeof makeLinearFetcher>;
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const use = (issues: Array<Record<string, unknown>>, comments: Array<Record<string, unknown>> = []) => {
    fake = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues }, comments } }]);
    linear.fetcher = fake.fetcher;
  };
  const cfg = async () => (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json();
  const stored = async () => {
    const r = (await db.execute(sql`SELECT settings->'linear'->'sync_status' AS s FROM workspaces WHERE id = ${ws}`)) as unknown as { rows: Array<{ s: Record<string, unknown> }> };
    return r.rows[0]!.s;
  };
  const issuesDb = async () => (await inject('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Issues');
  const records = async () => {
    const d = await issuesDb();
    return { db: d, rows: (await inject('GET', `/workspaces/${ws}/databases/${d.id}/records?limit=50`)).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }> };
  };
  const commentsOf = async (title: string) => {
    const { db: d, rows } = await records();
    const rec = rows.find((r) => r.title === title)!;
    return (await inject('GET', `/workspaces/${ws}/databases/${d.id}/records/${rec.id}/comments`)).json().data as unknown[];
  };
  const later = (hours: number) => new Date(Date.now() + hours * HOUR);

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    db = app.get<Db>(DB);
    admin = await signUpUser(app, 'Linear Incremental');
    ws = (await inject('POST', '/workspaces', { name: 'Linear Incremental WS' })).json().id;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['IN'] })).statusCode).toBe(201);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { auto_sync: { enabled: true } })).statusCode).toBe(201);
  }, 120_000);
  afterAll(async () => { await app.close(); });

  it('the FIRST scheduled run is a full read: it asks for the total, reads every issue, and sets the cursor', async () => {
    use([issue(1), issue(2), issue(3)], [comment(1, 'i1')]);
    await linear.tick();
    expect((await cfg()).sync.last_run).toMatchObject({ issues: 3, comments: 1, mode: 'full' });
    expect(fake.calls).toContain('TeamIssueCount');
    expect(fake.calls).not.toContain('TeamIssuesSince');
    const s = await stored();
    expect(s['cursor_at']).toBeTruthy();
    expect(s['last_full_at']).toBe(s['cursor_at']);
    expect(s['synced_teams']).toEqual(['IN']);
    expect((await records()).rows).toHaveLength(3);
  });

  it('the NEXT scheduled run is incremental and nothing changed: it fetches nothing, asks for no total, and loses nothing', async () => {
    use([issue(1), issue(2), issue(3)], [comment(1, 'i1')]);
    await linear.tick(later(1.1));
    expect((await cfg()).sync.last_run).toMatchObject({ issues: 0, comments: 0, mode: 'incremental' });
    expect(fake.calls).toContain('TeamIssuesSince');
    expect(fake.calls).toContain('TeamCommentsSince');
    expect(fake.calls, 'no total to compare on an incremental read').not.toContain('TeamIssueCount');
    expect((await records()).rows, 'the mirror is untouched').toHaveLength(3);
    expect(await commentsOf('Issue 1')).toHaveLength(1);
  });

  it('a changed issue and a new one are picked up; the unchanged ones are not re-read', async () => {
    const fresh = new Date(Date.now() + 5_000).toISOString();
    use([issue(1), issue(2, { title: 'Issue 2 renamed', updatedAt: fresh }), issue(3), issue(4, { updatedAt: fresh })]);
    await linear.tick(later(2.2));
    expect((await cfg()).sync.last_run).toMatchObject({ issues: 2, mode: 'incremental' });
    const titles = (await records()).rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Issue 1', 'Issue 2 renamed', 'Issue 3', 'Issue 4']);
  });

  it('a comment on an issue that did NOT change is placed through the mirror, not rejected as an orphan', async () => {
    const fresh = new Date(Date.now() + 5_000).toISOString();
    use([issue(1), issue(2, { title: 'Issue 2 renamed' }), issue(3), issue(4)], [comment(1, 'i1'), comment(2, 'i1', { updatedAt: fresh })]);
    await linear.tick(later(3.3));
    expect((await cfg()).sync.last_run).toMatchObject({ issues: 0, comments: 1, mode: 'incremental' });
    expect(await commentsOf('Issue 1'), 'the new comment landed on the unchanged issue').toHaveLength(2);
  });

  it('a comment on an issue the mirror has never seen FAILS the run, loudly, rather than dropping the comment', async () => {
    const fresh = new Date(Date.now() + 5_000).toISOString();
    use([issue(1), issue(2, { title: 'Issue 2 renamed' }), issue(3), issue(4)], [comment(9, 'i-never-seen', { updatedAt: fresh })]);
    await linear.tick(later(4.4));
    const c = await cfg();
    expect(c.sync.last_error).toMatch(/Comment c9 belongs to an issue that was not imported/);
  });

  it('a FAILED run leaves the cursor exactly where it was', async () => {
    const before = await stored();
    linear.fetcher = async () => { throw new Error('Linear API 500'); };
    await linear.tick(later(5.5));
    const after = await stored();
    expect(after['last_error']).toMatch(/Linear API 500/);
    expect(after['cursor_at'], 'not moved by a failure').toBe(before['cursor_at']);
    expect(after['last_full_at']).toBe(before['last_full_at']);
  });

  it('an issue that left Linear is NOT marked by an incremental run (absence proves nothing there) — only by the full one', async () => {
    use([issue(1), issue(3), issue(4)]); // issue 2 is gone; every remaining issue is unchanged
    await linear.tick(later(6.6));
    let r = (await cfg()).sync.last_run;
    expect(r).toMatchObject({ mode: 'incremental', left_scope: 0 });
    expect(String((await records()).rows.find((x) => x.title === 'Issue 2 renamed')!.values['linear_status'])).not.toMatch(/Left Linear scope/);

    // The day-old safety net. The planner reads the real clock, so age the recorded full read instead of faking the tick.
    const aged = new Date(Date.now() - (FULL_REFRESH_HOURS + 1) * HOUR).toISOString();
    await db.execute(sql`UPDATE workspaces SET settings = jsonb_set(settings, '{linear,sync_status,last_full_at}', to_jsonb(${aged}::text)) WHERE id = ${ws}`);
    await linear.tick(later(7.7));
    r = (await cfg()).sync.last_run;
    expect(r).toMatchObject({ mode: 'full', left_scope: 1 });
    expect(String((await records()).rows.find((x) => x.title === 'Issue 2 renamed')!.values['linear_status'])).toMatch(/Left Linear scope/);
  });

  it('a MANUAL Import is a full read even with a fresh cursor', async () => {
    use([issue(1), issue(3), issue(4)]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().mode).toBe('full');
    expect(fake.calls).toContain('TeamIssueCount');
    expect(fake.calls).not.toContain('TeamIssuesSince');
  });

  it('adding a team makes the next scheduled run FULL: the cursor knows nothing about the new team', async () => {
    const s = await stored();
    expect(s['synced_teams']).toEqual(['IN']);
    expect(planSyncMode(s as never, new Date(), ['IN', 'SF'], true).mode).toBe('full');
  });
});
