import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DEFAULT_LINEAR_IMPORT_OPTIONS, LINEAR_RECENT_DAYS, linearImportOptionsSchema, resolveLinearImportOptions } from '@storyos/schemas';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, matchesIssueFilter } from './helpers/linear-fake';
import { LinearService, planSyncMode } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';
import { LinearApiError } from '../src/integrations/linear-resilience';
import { chunked, closedRecentlyFilter, deriveQuery, openIssuesFilter, scopeCutoff, scopeFilter } from '../src/integrations/linear-import-scope';
import { historyShape } from './fixtures/linear-documented-shapes';

/**
 * Ticket #1393 — the Linear import SCOPE ("open issues + closed in the last 90 days", or everything) and the opt-in history.
 *
 * Every Linear response here comes from a HAND-WRITTEN fake in the documented GraphQL shape (test/helpers/linear-fake.ts, which
 * INTERPRETS the `IssueFilter` it is sent rather than assuming it, and throws on a key it cannot read). Nothing was recorded from the
 * live API: no Linear key existed. These tests prove what the importer ASKS for and does with the answers; they do not prove Linear
 * accepts `issueCount(filter:)` or the filter shapes with that cost.
 */
const NOW = Date.UTC(2026, 10, 27, 14, 0, 0);
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const KEY = 'lin_api_FAKEKEYFAKEKEY';

const ST = {
  todo: { type: 'unstarted', name: 'Todo' },
  doing: { type: 'started', name: 'In Progress' },
  backlog: { type: 'backlog', name: 'Backlog' },
  triage: { type: 'triage', name: 'Triage' },
  done: { type: 'completed', name: 'Done' },
  canceled: { type: 'canceled', name: 'Canceled' },
};
const issue = (key: string, n: number, state: { type: string; name: string }, over: Record<string, unknown> = {}) => ({
  id: `${key}-i${n}`, identifier: `${key}-${n}`, title: `${key} ${n}`, description: null,
  url: `https://linear.app/acme/issue/${key}-${n}`, estimate: null, priority: 0, state,
  labels: { nodes: [] }, assignee: null, parent: null, cycle: null, project: null,
  createdAt: daysAgo(900), updatedAt: daysAgo(2000), startedAt: null, completedAt: null, canceledAt: null, dueDate: null, ...over,
});

/** The team the scope tests read. 1-4, 6, 8, 9 are IN scope; 5 and 7 are not. */
const scTeam = () => {
  const issues = [
    issue('SC', 1, ST.doing, { createdAt: daysAgo(900) }), // open, years old: kept
    issue('SC', 2, ST.backlog), // open, ancient: kept
    issue('SC', 3, ST.triage), // open (triage is not closed): kept
    issue('SC', 4, ST.done, { completedAt: daysAgo(89) }), // closed 89 days ago: kept
    issue('SC', 5, ST.done, { completedAt: daysAgo(91) }), // closed 91 days ago: DROPPED
    issue('SC', 6, ST.canceled, { canceledAt: daysAgo(10) }), // canceled 10 days ago (no completedAt): kept
    issue('SC', 7, ST.canceled, { canceledAt: daysAgo(200) }), // canceled 200 days ago: DROPPED
    issue('SC', 8, ST.done, { completedAt: daysAgo(0) }), // closed today: kept
    issue('SC', 9, ST.done, { completedAt: daysAgo(LINEAR_RECENT_DAYS) }), // closed exactly at the cutoff: kept (the window is inclusive)
  ];
  return {
    issues,
    inScope: ['SC-i1', 'SC-i2', 'SC-i3', 'SC-i4', 'SC-i6', 'SC-i8', 'SC-i9'],
    outOfScope: ['SC-i5', 'SC-i7'],
    comments: issues.map((i, n) => ({ id: `c${n}`, body: `Comment on ${i.identifier}`, createdAt: daysAgo(500 - n), url: `https://linear.app/acme/issue/${i.identifier}#c${n}`, user: { name: 'Ada Example' }, botActor: null, externalUser: null, issue: { id: i.id } })),
    attachments: ['SC-i1', 'SC-i5', 'SC-i7'].map((issueId, n) => ({ id: `att${n}`, issueId, title: `Link ${n}`, subtitle: null, url: `https://example.com/doc-${n}`, sourceType: 'url', createdAt: daysAgo(300), updatedAt: daysAgo(300) })),
    history: {
      'SC-i1': [historyShape('h1', daysAgo(800), 'Backlog', 'In Progress', null)],
      'SC-i4': [historyShape('h4', daysAgo(95), 'In Progress', 'Done', null)],
      'SC-i5': [historyShape('h5', daysAgo(100), 'In Progress', 'Done', null)],
    },
    relationEdges: [
      { id: 'r1', type: 'blocks', issue: { id: 'SC-i1' }, relatedIssue: { id: 'SC-i2' } },
      { id: 'r2', type: 'related', issue: { id: 'SC-i1' }, relatedIssue: { id: 'SC-i5' } }, // into an out-of-scope issue
    ],
  };
};
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const withData = (sc: ReturnType<typeof scTeam>) => ({ id: 'team-SC', key: 'SC', name: 'Scope', data: { ...empty, issues: { nodes: sc.issues as never }, comments: sc.comments as never, attachments: sc.attachments as never, history: sc.history as never } });

/* ------------------------------------------------------------------ the options contract ------------------------------------------------------------------ */

describe('#1393 the import options (schema)', () => {
  it('nothing sent is the defaults: open + recent, history OFF', () => {
    expect(linearImportOptionsSchema.parse({})).toEqual({});
    expect(resolveLinearImportOptions(undefined)).toEqual(DEFAULT_LINEAR_IMPORT_OPTIONS);
    expect(resolveLinearImportOptions({})).toEqual({ scope: 'open_and_recent', include_history: false });
  });

  it('each option is accepted, and a field that is not sent keeps its fallback', () => {
    expect(linearImportOptionsSchema.parse({ scope: 'all', include_history: true })).toEqual({ scope: 'all', include_history: true });
    expect(resolveLinearImportOptions({ include_history: true })).toEqual({ scope: 'open_and_recent', include_history: true });
    expect(resolveLinearImportOptions({ scope: 'all' }, { scope: 'open_and_recent', include_history: true })).toEqual({ scope: 'all', include_history: true });
  });

  it.each([
    ['an unknown scope', { scope: 'last_year' }],
    ['a scope in the wrong case', { scope: 'All' }],
    ['a null scope', { scope: null }],
    ['history as a string', { include_history: 'yes' }],
    ['history as a number', { include_history: 1 }],
    ['a misspelt key (it would silently fall back to the default)', { include_histroy: true }],
    ['a stray key', { scope: 'all', depth: 3 }],
  ])('REJECTS %s', (_name, body) => {
    expect(linearImportOptionsSchema.safeParse(body).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ the filter, at its edges ------------------------------------------------------------------ */

describe('#1393 the default scope: what the filter KEEPS and what it DROPS', () => {
  const cutoff = scopeCutoff(NOW);
  const kept = (n: Record<string, unknown>) => matchesIssueFilter(n, scopeFilter(cutoff));
  const mk = (state: { type: string; name: string }, over: Record<string, unknown> = {}) => issue('X', 1, state, over);

  it('the cutoff is exactly 90 days before now', () => {
    expect(cutoff).toBe(daysAgo(90));
  });

  it('closed 89 days ago is KEPT, 91 days ago is DROPPED, exactly 90 is kept (inclusive)', () => {
    expect(kept(mk(ST.done, { completedAt: daysAgo(89) }))).toBe(true);
    expect(kept(mk(ST.done, { completedAt: daysAgo(91) }))).toBe(false);
    expect(kept(mk(ST.done, { completedAt: daysAgo(90) }))).toBe(true);
  });

  it('an OPEN issue of any age is kept, whatever its dates say (including one that still carries an old completedAt)', () => {
    for (const state of [ST.todo, ST.doing, ST.backlog, ST.triage]) expect(kept(mk(state, { createdAt: daysAgo(3000), updatedAt: daysAgo(3000) }))).toBe(true);
    expect(kept(mk(ST.doing, { completedAt: daysAgo(500) })), 'reopened: its state, not a stale date, decides').toBe(true);
  });

  it('a CANCELED issue counts as closed: recent is kept, old is dropped (it has a canceledAt, never a completedAt)', () => {
    expect(kept(mk(ST.canceled, { canceledAt: daysAgo(10) }))).toBe(true);
    expect(kept(mk(ST.canceled, { canceledAt: daysAgo(200) }))).toBe(false);
  });

  it('a closed issue with NO close date at all is dropped, not kept by accident', () => {
    expect(kept(mk(ST.done, { completedAt: null }))).toBe(false);
  });

  it('the two halves never overlap, so open + recently-closed is the scope\'s count', () => {
    const rows = scTeam().issues;
    const open = rows.filter((n) => matchesIssueFilter(n, openIssuesFilter()));
    const closedRecent = rows.filter((n) => matchesIssueFilter(n, closedRecentlyFilter(cutoff)));
    expect(open.filter((n) => closedRecent.includes(n))).toEqual([]);
    expect(open.length + closedRecent.length).toBe(rows.filter(kept).length);
    expect(rows.filter(kept).map((n) => n.id)).toEqual(scTeam().inScope);
  });

  it('ids are chunked without losing or repeating one', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const parts = chunked(ids, 100);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expect(parts.flat()).toEqual(ids);
    expect(chunked([])).toEqual([]);
  });

  it('a derived query whose base was reworded fails at load, not silently', () => {
    expect(() => deriveQuery('query A { x }', [['issues(first: 50)', 'issues(first: 50, filter: $f)']], 'A')).toThrow(/no longer derives/);
  });

  it('an incremental read keeps the scope AND narrows to what changed', () => {
    const rows = [issue('X', 1, ST.doing, { updatedAt: daysAgo(1) }), issue('X', 2, ST.doing, { updatedAt: daysAgo(30) }), issue('X', 3, ST.done, { completedAt: daysAgo(200), updatedAt: daysAgo(1) })];
    const f = { ...scopeFilter(cutoff), updatedAt: { gt: daysAgo(5) } };
    expect(rows.filter((n) => matchesIssueFilter(n, f)).map((n) => n.id)).toEqual(['X-i1']);
  });
});

describe('#1393 planSyncMode: a changed scope is a FULL read', () => {
  const now = new Date('2026-10-24T12:00:00Z');
  const status = { cursor_at: new Date(now.getTime() - 3_600_000).toISOString(), last_full_at: new Date(now.getTime() - 7_200_000).toISOString(), synced_teams: ['IN'] };
  it('is incremental while the options are the ones the last run used, and full the moment they are not', () => {
    expect(planSyncMode(status, now, ['IN'], true).mode).toBe('incremental');
    expect(planSyncMode(status, now, ['IN'], true, true).mode).toBe('incremental');
    expect(planSyncMode(status, now, ['IN'], true, false).mode, 'a widened scope has issues the cursor knows nothing about').toBe('full');
  });
});

/* ------------------------------------------------------------------ through the service ------------------------------------------------------------------ */

describe('#1393 through the service: scope and history', () => {
  let clockNow = NOW;
  let app: NestFastifyApplication;
  let linear: LinearService;
  let admin: { token: string };
  let n = 0;
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    linear.clock = () => clockNow;
    linear.random = () => 0;
    linear.sleep = async () => undefined;
    admin = await signUpUser(app, 'Linear Scope');
  }, 120_000);
  afterAll(async () => { await app.close(); });

  /** A fresh workspace connected to the given teams, so no test inherits another's mirror or stored options. */
  const freshWorkspace = async (teamKeys: string[] = ['SC']) => {
    n += 1;
    const ws = (await inject('POST', '/workspaces', { name: `Linear Scope WS ${n}` })).json().id as string;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: KEY, team_keys: teamKeys })).statusCode).toBe(201);
    return ws;
  };
  const titlesOf = async (ws: string, teamName = 'Scope') => {
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceName?: string }>;
    const issues = dbs.filter((d) => d.name === 'Issues');
    expect(issues.length).toBeGreaterThan(0);
    const rows: Array<{ title: string; values: Record<string, unknown> }> = [];
    for (const d of issues) rows.push(...((await inject('GET', `/workspaces/${ws}/databases/${d.id}/records?limit=100`)).json().data as typeof rows));
    void teamName;
    return rows;
  };
  const sync = (ws: string, body?: unknown) => inject('POST', `/workspaces/${ws}/integrations/linear/sync`, body);
  const names = (reqs: Array<{ name: string }>) => reqs.map((r) => r.name);
  const idsAsked = (reqs: Array<{ name: string; variables: Record<string, unknown> }>, name: string) =>
    reqs.filter((r) => r.name === name).flatMap((r) => (r.variables['ids'] as string[] | undefined) ?? []).sort();

  it('a caller that sends NO options gets the defaults: only the in-scope issues arrive, and no history is fetched', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges });
    linear.fetcher = fake.fetcher;
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    const report = res.json();
    expect(report.options).toMatchObject({ scope: 'open_and_recent', include_history: false, recent_days: 90, cutoff: daysAgo(90) });
    expect((await titlesOf(ws)).map((r) => r.title).sort()).toEqual(sc.inScope.map((id) => `SC ${id.replace('SC-i', '')}`).sort());
    expect(report.issues).toBe(7);
    expect(report.per_team).toEqual([{ key: 'SC', issues_fetched: 7, linear_issue_total: 7 }]);
    // Comments are always imported — for the issues that were imported, and for no others.
    expect(report.comments.fetched).toBe(7);
    // History OFF: not one history request.
    expect(names(fake.requests).filter((x) => x.startsWith('TeamIssueHistory') || x === 'IssueHistoryMore')).toEqual([]);
    expect(report.history).toMatchObject({ requested: false, issues: 0, rows: 0 });
  }, 120_000);

  it('attachments and relations are asked for EXACTLY the in-scope ids, and nothing is asked for an issue outside the scope', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges });
    linear.fetcher = fake.fetcher;
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(idsAsked(fake.requests, 'TeamAttachments')).toEqual([...sc.inScope].sort());
    expect(idsAsked(fake.requests, 'TeamRelations')).toEqual([...sc.inScope].sort());
    // The one attachment on an in-scope issue arrives; the two on out-of-scope issues were never asked for.
    expect(res.json().attachments.fetched).toBe(1);
    // The unscoped issue stream was never used for a scoped run.
    expect(fake.requests.filter((r) => r.name === 'TeamIssues').every((r) => r.variables['filter'] !== undefined)).toBe(true);
  }, 120_000);

  it('include_history: the history read is asked for exactly the in-scope ids, and only their history is written', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges });
    linear.fetcher = fake.fetcher;
    const res = await sync(ws, { include_history: true });
    expect(res.statusCode, res.body).toBe(201);
    expect(idsAsked(fake.requests, 'TeamIssueHistory')).toEqual([...sc.inScope].sort());
    // SC-i1 and SC-i4 are in scope and have one state change each; SC-i5's is out of scope and is never read (7 issues were read, 2 rows written).
    expect(res.json().history).toMatchObject({ requested: true, kept: true, issues: 7, rows: 2 });
    expect(res.json().options.include_history).toBe(true);
  }, 120_000);

  it('scope "all" reads everything with the plain queries (no filter, no id list), and history stays off unless asked', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges });
    linear.fetcher = fake.fetcher;
    const res = await sync(ws, { scope: 'all' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().issues).toBe(9);
    expect(res.json().options).toMatchObject({ scope: 'all', include_history: false, cutoff: null, recent_days: null });
    expect(fake.requests.filter((r) => /^Team(Issues|IssueCount|Comments|Attachments|Relations)$/.test(r.name)).every((r) => r.variables['filter'] === undefined && r.variables['ids'] === undefined && r.variables['issue'] === undefined)).toBe(true);
    expect(names(fake.requests).some((x) => x.startsWith('TeamIssueHistory'))).toBe(false);
    expect((await titlesOf(ws))).toHaveLength(9);
  }, 120_000);

  it('scope "all" + include_history reads the history of every issue', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges });
    linear.fetcher = fake.fetcher;
    const res = await sync(ws, { scope: 'all', include_history: true });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().history).toMatchObject({ requested: true, issues: 9, rows: 3 });
  }, 120_000);

  it('the scope\'s OWN count is checked: a filtered total that disagrees with what was read refuses the import and writes nothing', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    linear.fetcher = makeLinearFetcher([withData(sc)], { scopedIssueCount: () => 8 }).fetcher;
    const res = await sync(ws);
    expect(res.statusCode).toBe(422);
    expect(res.body).toMatch(/has 8 issues but 7 were fetched/);
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ name: string }>;
    expect(dbs.filter((d) => d.name === 'Issues'), 'no team space was written').toHaveLength(0);
  }, 120_000);

  it.each([
    ['an unknown scope', { scope: 'last_year' }],
    ['history as a string', { include_history: 'yes' }],
    ['an unknown key', { scope: 'all', include_histroy: true }],
    ['an array', ['all']],
  ])('REJECTS %s with a 4xx, before anything is read, locked or written', async (_name, body) => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)]);
    linear.fetcher = fake.fetcher;
    const res = await sync(ws, body);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);
    expect(fake.requests, 'Linear was never called').toHaveLength(0);
    const cfg = (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json();
    expect(cfg.sync.running).toBe(false);
    expect(cfg.sync.last_attempt_at, 'a refused request is not an attempt').toBeNull();
    expect((await sync(ws)).statusCode, 'a normal run still works afterwards').toBe(201);
  }, 120_000);

  it('a default-scope run does NOT mark the older records "left Linear": absence under a filter proves nothing', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    expect((await sync(ws, { scope: 'all' })).statusCode).toBe(201);
    // Narrow to the default: SC-5 and SC-7 are not read any more, but they are not gone from Linear.
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    const res = await sync(ws, { scope: 'open_and_recent' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().left_scope).toBe(0);
    expect(res.json().left_scope_checked).toBe(false);
    const rows = await titlesOf(ws);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => String(r.values['linear_status'] ?? '').startsWith('Left')), 'nothing was marked as having left Linear').toEqual([]);
  }, 120_000);

  it('KEPT: a run with scope "all" still marks an issue Linear no longer returns', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    expect((await sync(ws, { scope: 'all' })).statusCode).toBe(201);
    const gone = { ...sc, issues: sc.issues.filter((i) => i.id !== 'SC-i7'), comments: sc.comments.filter((c) => (c.issue as { id: string }).id !== 'SC-i7') };
    linear.fetcher = makeLinearFetcher([withData(gone as never)]).fetcher;
    const res = await sync(ws, { scope: 'all' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ left_scope: 1, left_scope_checked: true });
  }, 120_000);

  it('the choice is remembered: the config shows it, and a later run that sends nothing uses it (the scheduled mirror too)', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    expect((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().import_options, 'before any import: the defaults, not yet chosen').toEqual({ scope: 'open_and_recent', include_history: false, chosen: false });
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    expect((await sync(ws, { scope: 'all', include_history: true })).statusCode).toBe(201);
    expect((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().import_options).toEqual({ scope: 'all', include_history: true, chosen: true });
    const fake = makeLinearFetcher([withData(sc)]);
    linear.fetcher = fake.fetcher;
    const again = await sync(ws);
    expect(again.json().options).toMatchObject({ scope: 'all', include_history: true });
    expect(again.json().issues).toBe(9);
  }, 120_000);

  it('a workspace that imported before this existed (no stored choice) keeps getting everything, with history, until someone chooses', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    // Simulate the old importer: a successful run on record and no stored choice.
    const settings = linear as unknown as { readLinear(w: string): Promise<Record<string, unknown>>; writeLinear(w: string, s: Record<string, unknown>): Promise<void> };
    const before = await settings.readLinear(ws);
    await settings.writeLinear(ws, { ...before, sync_status: { last_success_at: daysAgo(3) } });
    expect((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().import_options).toEqual({ scope: 'all', include_history: true, chosen: false });
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().options).toMatchObject({ scope: 'all', include_history: true });
    expect(res.json().issues).toBe(9);
  }, 120_000);

  it('the PREVIEW shows the count for EACH option, in a handful of requests per team, and the choices the screen offers', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    const fake = makeLinearFetcher([withData(sc)]);
    linear.fetcher = fake.fetcher;
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    const preview = res.json();
    expect(preview.teams[0].issues_by_scope).toEqual({ all: 9, open_and_recent: 7, open: 3, closed_recent: 4 });
    expect(preview.teams[0].issues, 'the existing total field is unchanged').toBe(9);
    expect(preview.import_choices).toMatchObject({ scopes: ['open_and_recent', 'all'], default: { scope: 'open_and_recent', include_history: false }, recent_days: 90, cutoff: daysAgo(90) });
    const perTeam = preview.requests - 1; // minus the team list
    expect(perTeam, 'count, states, labels and the two scope counts').toBeLessThanOrEqual(5);
    expect(names(fake.requests).includes('TeamIssues'), 'the preview never walks issues').toBe(false);
    // The scope counts are ONE aliased request, filtered the way the import filters.
    const asked = fake.requests.find((r) => r.name === 'TeamScopeCounts')!;
    expect(asked.variables['open']).toEqual(openIssuesFilter());
    expect(asked.variables['closedRecent']).toEqual(closedRecentlyFilter(daysAgo(90)));
  }, 120_000);

  it('the detailed preview carries the same per-option counts', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    linear.fetcher = makeLinearFetcher([withData(sc)], { relationEdges: sc.relationEdges }).fetcher;
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run?detail=full`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().teams[0].issues_by_scope).toEqual({ all: 9, open_and_recent: 7, open: 3, closed_recent: 4 });
  }, 120_000);

  it('an unfinished import resumes under the options it started with; asking for different ones starts over', async () => {
    const ws = await freshWorkspace(['SC', 'TW']);
    const sc = scTeam();
    const two = { id: 'team-TW', key: 'TW', name: 'Two', data: { ...empty, issues: { nodes: [issue('TW', 1, ST.todo), issue('TW', 2, ST.done, { completedAt: daysAgo(400) })] as never } } };
    const limited = () => new LinearApiError('Linear rate limit exceeded (RATELIMITED)', { kind: 'rate_limited', status: 400, code: 'RATELIMITED', resetAtMs: NOW + 40 * 60_000, paused: true } as never);
    let paused = true;
    const base = makeLinearFetcher([withData(sc), two]);
    const failing: LinearFetcher = async (q, v, k) => { if (paused && v['id'] === 'team-TW' && q.includes('query TeamIssues(')) throw limited(); return base.fetcher(q, v, k); };
    linear.fetcher = failing;
    const first = await sync(ws, { scope: 'all' });
    expect(first.statusCode, first.body).toBe(422);
    expect((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync.progress.teams_done).toEqual(['SC']);
    paused = false;
    // Nothing sent: it continues the paused "all" import (SC is skipped), and TW is read in full.
    const resumed = await sync(ws);
    expect(resumed.statusCode, resumed.body).toBe(201);
    expect(resumed.json().options.scope).toBe('all');
    expect(resumed.json().resumed.skipped_teams).toEqual(['SC']);
    expect(resumed.json().per_team.find((t: { key: string }) => t.key === 'TW').issues_fetched, 'TW read under "all": the old closed issue is there').toBe(2);
  }, 120_000);

  it('asking for DIFFERENT options than the paused import used does not continue it', async () => {
    const ws = await freshWorkspace(['SC', 'TW']);
    const sc = scTeam();
    const two = { id: 'team-TW', key: 'TW', name: 'Two', data: { ...empty, issues: { nodes: [issue('TW', 1, ST.todo)] as never } } };
    const limited = () => new LinearApiError('Linear rate limit exceeded (RATELIMITED)', { kind: 'rate_limited', status: 400, code: 'RATELIMITED', resetAtMs: NOW + 40 * 60_000, paused: true } as never);
    let paused = true;
    const base = makeLinearFetcher([withData(sc), two]);
    linear.fetcher = async (q, v, k) => { if (paused && v['id'] === 'team-TW' && q.includes('query TeamIssues(')) throw limited(); return base.fetcher(q, v, k); };
    expect((await sync(ws, { scope: 'all' })).statusCode).toBe(422);
    paused = false;
    const res = await sync(ws, { scope: 'open_and_recent' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().resumed, 'a different scope is a different import').toBeNull();
    expect(res.json().per_team.map((t: { key: string }) => t.key)).toEqual(['SC', 'TW']);
  }, 120_000);

  it('a resumed DEFAULT-scope import keeps the cutoff it started with, even hours later: every team of one import is cut at the same instant', async () => {
    const ws = await freshWorkspace(['SC', 'TW']);
    const sc = scTeam();
    const two = { id: 'team-TW', key: 'TW', name: 'Two', data: { ...empty, issues: { nodes: [issue('TW', 1, ST.todo), issue('TW', 2, ST.done, { completedAt: daysAgo(89.9) })] as never } } };
    let paused = true;
    const base = makeLinearFetcher([withData(sc), two]);
    linear.fetcher = async (q, v, k) => {
      if (paused && v['id'] === 'team-TW' && q.includes('query TeamIssues(')) throw new LinearApiError('Linear rate limit exceeded (RATELIMITED)', { kind: 'rate_limited', status: 400, code: 'RATELIMITED', resetAtMs: NOW + 40 * 60_000, paused: true } as never);
      return base.fetcher(q, v, k);
    };
    clockNow = NOW;
    expect((await sync(ws)).statusCode).toBe(422);
    paused = false;
    clockNow = NOW + 6 * 3_600_000; // six hours on: a fresh cutoff would now be 6 hours later, and TW's issue closed 89.9 days before NOW would fall out of it
    const res = await sync(ws);
    clockNow = NOW;
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().options.cutoff, 'the resumed import keeps the first run\'s cutoff').toBe(daysAgo(90));
    expect(res.json().per_team.find((t: { key: string }) => t.key === 'TW').issues_fetched).toBe(2);
  }, 120_000);

  it('a scheduled (incremental) run keeps the scope: a changed in-scope issue arrives, a changed out-of-scope one does not', async () => {
    const ws = await freshWorkspace();
    const sc = scTeam();
    linear.fetcher = makeLinearFetcher([withData(sc)]).fetcher;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { auto_sync: { enabled: true } })).statusCode).toBe(201);
    expect((await sync(ws)).statusCode).toBe(201);
    const edited = new Date(Date.now() + 5_000).toISOString(); // the scheduler and the cursor run on the real clock; only the scope's cutoff is pinned
    const touched = sc.issues.map((i) => (i.id === 'SC-i1' || i.id === 'SC-i5' ? { ...i, title: `${i.title} (edited)`, updatedAt: edited } : i));
    const fake = makeLinearFetcher([withData({ ...sc, issues: touched } as never)]);
    linear.fetcher = fake.fetcher;
    await linear.tick(new Date(Date.now() + 70 * 60_000));
    const asked = fake.requests.filter((r) => r.name === 'TeamIssuesSince');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((r) => (r.variables['filter'] as Record<string, unknown>)['updatedAt'] !== undefined && (r.variables['filter'] as Record<string, unknown>)['or'] !== undefined), 'the changed-since read is ALSO scoped').toBe(true);
    const titles = (await titlesOf(ws)).map((r) => r.title);
    expect(titles).toContain('SC 1 (edited)');
    expect(titles, 'the out-of-scope issue was never imported, edited or not').not.toContain('SC 5 (edited)');
    expect(titles).toHaveLength(7);
  }, 120_000);
});

/* ------------------------------------------------------------------ the rate budget ------------------------------------------------------------------ */

describe('#1393 against a rate budget: the default fits, "Everything" pauses and resumes', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let admin: { token: string };
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

  /**
   * Five teams of 400 issues each: 40 open, 20 closed in the last 90 days, 340 closed long ago. Linear's real allowance is far larger
   * (documented as 5,000 requests an hour per key); this fake grants a run only BUDGET requests so the difference shows at test size: the
   * default scope takes 77 requests for the 300 issues it reads, "Everything" takes 252 for 2,000. A request past the budget is answered
   * with RATELIMITED and a reset 40 minutes away (too long to sit and wait, so the run must PAUSE).
   */
  const KEYS = ['ISSUE', 'QUA', 'PRO', 'UXC', 'INT'];
  const BUDGET = 150;
  const big = (key: string) => {
    const issues = [
      ...Array.from({ length: 40 }, (_, i) => issue(key, i + 1, i % 2 ? ST.doing : ST.todo)),
      ...Array.from({ length: 20 }, (_, i) => issue(key, 41 + i, ST.done, { completedAt: daysAgo(1 + i) })),
      ...Array.from({ length: 340 }, (_, i) => issue(key, 61 + i, ST.done, { completedAt: daysAgo(100 + i) })),
    ];
    return { id: `team-${key}`, key, name: key, data: { ...empty, issues: { nodes: issues as never }, comments: issues.map((x, i) => ({ id: `${key}c${i}`, body: 'c', createdAt: daysAgo(50), url: 'https://linear.app/x', user: { name: 'Ada Example' }, botActor: null, externalUser: null, issue: { id: x.id } })) as never } };
  };
  let used = 0;
  const budgeted = (): LinearFetcher => {
    const base = makeLinearFetcher(KEYS.map(big)).fetcher;
    return async (q, v, k) => {
      used += 1;
      if (used > BUDGET) throw new LinearApiError('Linear rate limit exceeded (RATELIMITED)', { kind: 'rate_limited', status: 400, code: 'RATELIMITED', resetAtMs: NOW + 40 * 60_000, paused: true } as never);
      return base(q, v, k);
    };
  };

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    linear.clock = () => NOW;
    linear.random = () => 0;
    linear.sleep = async () => undefined;
    admin = await signUpUser(app, 'Linear Budget');
  }, 120_000);
  afterAll(async () => { await app.close(); });

  const workspace = async (name: string) => {
    const ws = (await inject('POST', '/workspaces', { name })).json().id as string;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: KEY, team_keys: KEYS })).statusCode).toBe(201);
    return ws;
  };
  const issueTotal = async (ws: string) => {
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string }>;
    let total = 0;
    for (const d of dbs.filter((x) => x.name === 'Issues')) total += (await inject('POST', `/workspaces/${ws}/databases/${d.id}/records/aggregate`, { op: 'count' })).json().value as number;
    return total;
  };

  it('the DEFAULT import of five teams completes in one run, inside the budget', async () => {
    const ws = await workspace('Budget default');
    used = 0;
    linear.fetcher = budgeted();
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().issues).toBe(5 * 60);
    expect(res.json().resumed).toBeNull();
    expect(used, `${used} requests for 300 of 2000 issues`).toBeLessThan(BUDGET);
    expect(used, 'the default is at least 2x cheaper than reading everything').toBeLessThan(252 / 2);
    expect(await issueTotal(ws)).toBe(5 * 60);
  }, 240_000);

  it('"Everything" does not fit one run: it PAUSES (not an error state), keeps the teams it finished, and the re-run completes it', async () => {
    const ws = await workspace('Budget everything');
    used = 0;
    linear.fetcher = budgeted();
    const first = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`, { scope: 'all' });
    expect(first.statusCode, first.body).toBe(422);
    expect(first.body).toContain('Paused');
    expect(first.body).toContain('RATELIMITED');
    const status = (await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync;
    expect(status.paused).toMatchObject({ code: 'RATELIMITED', until: new Date(NOW + 40 * 60_000).toISOString() });
    const done = status.progress.teams_done as string[];
    expect(done.length, 'some teams finished before the budget ran out').toBeGreaterThan(0);
    expect(done.length).toBeLessThan(KEYS.length);
    expect(await issueTotal(ws), 'the finished teams are kept, whole').toBe(done.length * 400);
    // Budget refilled, each time: a re-run (no body) continues the same "Everything" import. It may pause again - it never starts over, and it
    // always gets further - until it is done.
    let doneBefore = done;
    let finished: { resumed: { skipped_teams: string[] }; options: { scope: string } } | undefined;
    for (let run = 0; run < 4 && !finished; run++) {
      used = 0;
      linear.fetcher = budgeted();
      const again = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
      if (again.statusCode === 201) {
        finished = again.json();
        expect(finished!.resumed.skipped_teams, 'it skipped exactly the teams already done').toEqual(doneBefore);
        expect(finished!.options.scope).toBe('all');
      } else {
        expect(again.statusCode, again.body).toBe(422);
        expect(again.body).toContain('Paused');
        const progress = ((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync.progress.teams_done as string[]);
        expect(progress.length, 'each run gets further than the one before').toBeGreaterThan(doneBefore.length);
        expect(await issueTotal(ws), 'the teams done are whole, and none is written twice').toBe(progress.length * 400);
        doneBefore = progress;
      }
    }
    expect(finished, 'the import completed within four budgets').toBeDefined();
    expect(await issueTotal(ws), 'every issue exactly once').toBe(5 * 400);
    expect((await inject('GET', `/workspaces/${ws}/integrations/linear`)).json().sync.paused).toBeNull();
  }, 240_000);
});
