import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { LinearService, fetchAllTeams, fetchTeamData } from '../src/integrations/linear.service';
import type { LinearFetcher } from '../src/integrations/linear.service';

/**
 * #902 — the Linear importer pages every connection to its end and refuses a copy that is short of Linear's own total.
 * It used to read `issues(first: 250)` once, so a team past 250 issues imported its first 250 and reported success.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-big', key: 'BIG', name: 'Big' };

describe('#902 paging, pure (no database)', () => {
  it('reads 600 issues, 300 labels, 120 cycles and 130 projects in full, over several pages each', async () => {
    const { fetcher, calls } = makeLinearFetcher([{
      ...TEAM,
      data: {
        labels: { nodes: Array.from({ length: 300 }, (_, i) => ({ id: `l${i}`, name: `l${i}`, color: null })) },
        cycles: { nodes: Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, name: null, number: i, startsAt: null, endsAt: null })) },
        projects: { nodes: Array.from({ length: 130 }, (_, i) => ({ id: `p${i}`, name: `p${i}`, description: null, state: 'started', targetDate: null, url: 'https://linear.app/acme/project/x' })) },
        issues: { nodes: manyIssues(600) },
      },
    }]);
    const data = await fetchTeamData(fetcher, 'k', TEAM);
    expect(data.issues.nodes).toHaveLength(600);
    expect(data.labels.nodes).toHaveLength(300);
    expect(data.cycles.nodes).toHaveLength(120);
    expect(data.projects.nodes).toHaveLength(130);
    expect(data.issueTotal).toBe(600);
    expect(calls.filter((c) => c === 'TeamIssues'), '600 issues at 50 a page').toHaveLength(12);
  });

  it('teams are paged too: a key past the first 50 teams is still found', async () => {
    const teams = Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, key: `K${i}`, name: `T${i}`, data: { ...empty, issues: { nodes: [] } } }));
    const found = await fetchAllTeams(makeLinearFetcher(teams).fetcher, 'k');
    expect(found).toHaveLength(60);
    expect(found.some((t) => t.key === 'K59')).toBe(true);
  });

  it('a count mismatch FAILS, naming both numbers, instead of returning a short copy', async () => {
    const { fetcher } = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(120) } } }], { issueCount: () => 121 });
    await expect(fetchTeamData(fetcher, 'k', TEAM)).rejects.toThrow(/BIG has 121 issues but 120 were fetched/);
  });

  it('a missing total, a missing pageInfo, and a cursor that does not advance are all errors, never "that was everything"', async () => {
    const base = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(120) } } }]).fetcher;
    const noTotal: LinearFetcher = async (q, v, k) => (q.includes('TeamIssueCount') ? { team: {} } : base(q, v, k));
    await expect(fetchTeamData(noTotal, 'k', TEAM)).rejects.toThrow(/did not report an issue total/);

    const noPageInfo: LinearFetcher = async (q, v, k) => {
      const r = (await base(q, v, k)) as { team?: { issues?: { pageInfo?: unknown } } };
      if (q.includes('TeamIssues')) delete r.team!.issues!.pageInfo;
      return r;
    };
    await expect(fetchTeamData(noPageInfo, 'k', TEAM)).rejects.toThrow(/no pageInfo for issues of BIG/);

    const stuck: LinearFetcher = async (q, v, k) => {
      const r = (await base(q, v, k)) as { team?: { issues?: { pageInfo: { hasNextPage: boolean; endCursor: string } } } };
      if (q.includes('TeamIssues')) r.team!.issues!.pageInfo = { hasNextPage: true, endCursor: 'same' };
      return r;
    };
    await expect(fetchTeamData(stuck, 'k', TEAM)).rejects.toThrow(/stopped advancing/);
  });

  it('an issue whose own label list is truncated fails the read rather than losing labels', async () => {
    const base = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: manyIssues(3) } } }]).fetcher;
    const truncated: LinearFetcher = async (q, v, k) => {
      const r = (await base(q, v, k)) as { team?: { issues?: { nodes: Array<{ labels: { pageInfo: { hasNextPage: boolean } } }> } } };
      if (q.includes('TeamIssues')) r.team!.issues!.nodes[1]!.labels.pageInfo.hasNextPage = true;
      return r;
    };
    await expect(fetchTeamData(truncated, 'k', TEAM)).rejects.toThrow(/BIG-2 has more than 50 labels/);
  });
});

describe('#902 through the service: dry-run preview, sync, idempotent re-sync, fail-before-write', () => {
  let app: NestFastifyApplication;
  let linear: LinearService;
  let admin: { token: string };
  let ws: string;
  const inject = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const projects = ['p-a', 'p-b', 'p-c'].map((id) => ({ id, name: `Project ${id}`, description: null, state: 'started', targetDate: null, url: 'https://linear.app/acme/project/x' }));

  beforeAll(async () => {
    app = await createTestApp();
    linear = app.get(LinearService);
    admin = await signUpUser(app, 'Linear Pager');
    ws = (await inject('POST', '/workspaces', { name: 'Linear Paging WS' })).json().id;
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['BIG'] })).statusCode).toBe(201);
  }, 120_000);
  afterAll(async () => { await app.close(); });

  const useTeam = (n: number, issueCount?: () => number) => {
    linear.fetcher = makeLinearFetcher(
      [{ ...TEAM, data: { ...empty, projects: { nodes: projects }, issues: { nodes: manyIssues(n, ['p-a', 'p-b', 'p-c', null]) } } }],
      { issueCount },
    ).fetcher;
  };
  const issueRecords = async () => {
    const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'Issues');
    if (!issuesDb) return null;
    return (await inject('POST', `/workspaces/${ws}/databases/${issuesDb.id}/records/aggregate`, { op: 'count' })).json().value as number;
  };

  it('a short copy fails the sync with 422 BEFORE anything is written', async () => {
    useTeam(600, () => 601);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toContain('has 601 issues but 600 were fetched');
    const spaces = (await inject('GET', `/workspaces/${ws}/spaces`)).json();
    expect(spaces.some((s: { name: string }) => s.name.includes('Linear')), 'nothing was written').toBe(false);
    const dry = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(dry.statusCode, 'the preview refuses too').toBe(422);
  });

  it('the preview shows the true count per team and per Linear project (600, not 250)', async () => {
    useTeam(600);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    const team = res.json().teams[0];
    expect(team).toMatchObject({ key: 'BIG', issues: 600, linear_issue_total: 600 });
    expect(team.issues_by_project).toEqual(expect.arrayContaining([
      { project_id: 'p-a', name: 'Project p-a', issues: 150 },
      { project_id: 'p-b', name: 'Project p-b', issues: 150 },
      { project_id: 'p-c', name: 'Project p-c', issues: 150 },
      { project_id: null, name: '(no project)', issues: 150 },
    ]));
    expect(res.json().will_create, 'the shared dry-run report counts them too').toBeGreaterThanOrEqual(600);
  });

  it('imports all 600 and reports fetched against Linear\'s total; a second sync updates, never duplicates', async () => {
    useTeam(600);
    const first = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ issues: 600, per_team: [{ key: 'BIG', issues_fetched: 600, linear_issue_total: 600 }] });
    const count1 = await issueRecords();
    const second = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(second.statusCode, second.body).toBe(201);
    expect(await issueRecords(), 'no duplicates').toEqual(count1);
    expect(count1, 'every issue, not the first 250').toBe(600);
  }, 240_000);
});
