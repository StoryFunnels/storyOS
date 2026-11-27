import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, grant, joinAs, setRestricted } from './helpers/members';
import type { Person } from './helpers/members';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { LinearService } from '../src/integrations/linear.service';

/**
 * Ticket #1364 — Linear project milestones: a Milestones database per team space, linked to Projects, with every
 * issue's milestone link.
 *
 * ALL FIXTURES HERE ARE HAND-WRITTEN FROM LINEAR'S DOCUMENTED GRAPHQL SHAPE (`Project.projectMilestones`,
 * `Issue.projectMilestone`). None is a capture from the live API: no Linear key was available. What the fake proves is
 * that the importer is correct against that shape, not that the shape is what Linear returns today.
 */
const OLD = '2020-01-01T00:00:00.000Z';
const prj = (n: number) => ({ id: `prj-${n}`, name: `Project ${n}`, description: null, state: 'started', targetDate: null, url: `https://linear.app/acme/project/p${n}` });
const ms = (n: number, projectId: string, extra: Record<string, unknown> = {}) => ({
  id: `ms-${n}`, projectId, name: `Milestone ${n}`, description: null, targetDate: '2026-12-01', sortOrder: n * 10 + 0.5, ...extra,
});
const base = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] } };
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  ...manyIssues(1)[0]!, id: `i${n}`, identifier: `MS-${n}`, title: `Issue ${n}`, updatedAt: OLD, ...extra,
});
type Ms = ReturnType<typeof ms>;

let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
const inject = (method: string, url: string, payload?: unknown) => call(app, admin.token, method, url, payload);
const useTeams = (teams: Array<{ id: string; key: string; name: string; projects: unknown[]; milestones: Ms[]; issues: Array<Record<string, unknown>> }>) => {
  const made = makeLinearFetcher(teams.map((t) => ({ id: t.id, key: t.key, name: t.name, data: { ...base, projects: { nodes: t.projects }, issues: { nodes: t.issues }, milestones: t.milestones } })));
  linear.fetcher = made.fetcher;
  return made;
};
const team = (key: string, name: string, projects: unknown[], milestones: Ms[], issues: Array<Record<string, unknown>>) => ({ id: `team-${key}`, key, name, projects, milestones, issues });
const dbNamed = async (space: string, name: string) => {
  const spaceId = (await inject('GET', `/workspaces/${ws}/spaces`)).json().find((s: { name: string }) => s.name === space)?.id;
  return (await inject('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string; spaceId?: string; space_id?: string }) => d.name === name && (d.spaceId ?? d.space_id) === spaceId);
};
const rows = async (databaseId: string) => (await inject('GET', `/workspaces/${ws}/databases/${databaseId}/records?limit=200`)).json().data as Array<{ id: string; title: string; values: Record<string, unknown> }>;
const linksOf = async (databaseId: string, recordTitle: string, apiName: string) => {
  const full = (await inject('GET', `/workspaces/${ws}/databases/${databaseId}`)).json();
  const field = (full.fields as Array<{ id: string; apiName: string }>).find((f) => f.apiName === apiName);
  if (!field) return null;
  const rec = (await rows(databaseId)).find((r) => r.title === recordTitle)!;
  const res = await inject('GET', `/workspaces/${ws}/databases/${databaseId}/records/${rec.id}/links/${field.id}`);
  return (res.json().data as Array<{ title: string }>).map((r) => r.title).sort();
};
const syncNow = async () => {
  const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Linear Milestones');
  ws = (await inject('POST', '/workspaces', { name: 'Linear Milestones WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['MS'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1364 a sync brings milestones, linked to their projects and issues', () => {
  it('the preview counts DISTINCT milestones, per team, and writes nothing', async () => {
    useTeams([team('MS', 'Milestones', [prj(1), prj(2)], [ms(1, 'prj-1'), ms(2, 'prj-1'), ms(3, 'prj-2')], [issue(1, { projectMilestone: { id: 'ms-1' }, project: { id: 'prj-1' } }), issue(2), issue(3, { projectMilestone: { id: 'ms-gone' } })])]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run?detail=full`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().milestones).toEqual({
      distinct: 3, projects_on_several_teams: 0,
      per_team: [{ key: 'MS', milestones: 3, issues_with_milestone: 2, issues_with_unreadable_milestone: 1 }],
    });
    // 3 milestone records are part of what a sync would create (will_create counts them, with the issues, projects ...)
    expect(res.json().will_create).toBe(3 + 2 + 3);
    expect(await dbNamed('Milestones (Linear)', 'Milestones')).toBeUndefined();
  });

  it('first sync: Milestones database, each milestone linked to its project, each issue linked to its milestone', async () => {
    useTeams([team('MS', 'Milestones', [prj(1), prj(2)],
      [ms(1, 'prj-1', { description: 'Ship the **beta**' }), ms(2, 'prj-1'), ms(3, 'prj-2', { targetDate: null })],
      [issue(1, { projectMilestone: { id: 'ms-1' }, project: { id: 'prj-1' } }), issue(2, { projectMilestone: { id: 'ms-3' }, project: { id: 'prj-2' } }), issue(3)])]);
    const summary = await syncNow();
    expect(summary.milestones).toMatchObject({ distinct: 3, written: 3, orphaned: 0, not_in_linear: 0, issue_links: { linked: 2, unplaced: 0 }, per_team: [{ key: 'MS', milestones: 3, written: 3, issue_links: 2, unplaced: 0 }] });
    expect(summary.warnings ?? []).toEqual([]);

    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    expect(milestonesDb).toBeTruthy();
    const list = await rows(milestonesDb.id);
    expect(list.map((r) => r.title).sort()).toEqual(['Milestone 1', 'Milestone 2', 'Milestone 3']);
    const m1 = list.find((r) => r.title === 'Milestone 1')!;
    expect(m1.values).toMatchObject({ linear_id: 'ms-1', target_date: '2026-12-01', sort_order: 10.5 });
    expect(list.find((r) => r.title === 'Milestone 3')!.values['target_date'] ?? null).toBeNull();
    // the description is the record's rich-text body
    const doc = (await inject('GET', `/workspaces/${ws}/databases/${milestonesDb.id}/records/${m1.id}/document`)).json();
    expect(JSON.stringify(doc.content)).toContain('beta');

    expect(await linksOf(milestonesDb.id, 'Milestone 1', 'project')).toEqual(['Project 1']);
    expect(await linksOf(milestonesDb.id, 'Milestone 3', 'project')).toEqual(['Project 2']);
    const issuesDb = await dbNamed('Milestones (Linear)', 'Issues');
    expect(await linksOf(issuesDb.id, 'Issue 1', 'milestone')).toEqual(['Milestone 1']);
    expect(await linksOf(issuesDb.id, 'Issue 2', 'milestone')).toEqual(['Milestone 3']);
    expect(await linksOf(issuesDb.id, 'Issue 3', 'milestone')).toEqual([]);
  });

  it('a second sync changes nothing: no duplicate milestone, no second Milestones database', async () => {
    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    await syncNow();
    expect((await rows(milestonesDb.id))).toHaveLength(3);
    const all = (await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ name: string }>;
    expect(all.filter((d) => d.name === 'Milestones')).toHaveLength(1);
  });

  it('Linear is the owner: a rename, a retarget, a moved issue and a CLEARED milestone all follow Linear', async () => {
    useTeams([team('MS', 'Milestones', [prj(1), prj(2)],
      [ms(1, 'prj-1', { name: 'Beta (renamed)', targetDate: '2027-01-15' }), ms(2, 'prj-1'), ms(3, 'prj-2', { targetDate: null })],
      [issue(1, { projectMilestone: { id: 'ms-2' }, project: { id: 'prj-1' } }), issue(2, { project: { id: 'prj-2' } }), issue(3)])]);
    await syncNow();
    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    const renamed = (await rows(milestonesDb.id)).find((r) => r.values['linear_id'] === 'ms-1')!;
    expect(renamed.title).toBe('Beta (renamed)');
    expect(renamed.values['target_date']).toBe('2027-01-15');
    const issuesDb = await dbNamed('Milestones (Linear)', 'Issues');
    expect(await linksOf(issuesDb.id, 'Issue 1', 'milestone')).toEqual(['Milestone 2']);
    expect(await linksOf(issuesDb.id, 'Issue 2', 'milestone')).toEqual([]); // Linear cleared it
  });

  it('a milestone deleted in Linear is KEPT and reported, never silently deleted or silently counted as present', async () => {
    useTeams([team('MS', 'Milestones', [prj(1), prj(2)], [ms(1, 'prj-1', { name: 'Beta (renamed)' }), ms(2, 'prj-1')], [issue(1, { project: { id: 'prj-1' } }), issue(2), issue(3)])]);
    const summary = await syncNow();
    expect(summary.milestones).toMatchObject({ distinct: 2, written: 2, not_in_linear: 1 });
    expect(summary.warnings.some((w: string) => w.includes('1 milestone record(s) no longer exist in Linear') && w.includes('Milestone 3'))).toBe(true);
    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    expect((await rows(milestonesDb.id))).toHaveLength(3);
  });

  it('an issue naming a milestone the read did not return is COUNTED and warned, and its existing link is left alone', async () => {
    const issuesDb = await dbNamed('Milestones (Linear)', 'Issues');
    useTeams([team('MS', 'Milestones', [prj(1)], [ms(1, 'prj-1', { name: 'Beta (renamed)' }), ms(2, 'prj-1')], [issue(1, { projectMilestone: { id: 'ms-2' }, project: { id: 'prj-1' } })])]);
    await syncNow();
    expect(await linksOf(issuesDb.id, 'Issue 1', 'milestone')).toEqual(['Milestone 2']);
    useTeams([team('MS', 'Milestones', [prj(1)], [ms(1, 'prj-1', { name: 'Beta (renamed)' }), ms(2, 'prj-1')], [issue(1, { projectMilestone: { id: 'ms-elsewhere' }, project: { id: 'prj-1' } })])]);
    const summary = await syncNow();
    expect(summary.milestones.issue_links).toEqual({ linked: 0, unplaced: 1 });
    expect(summary.warnings.some((w: string) => w.includes('1 issue(s) name 1 milestone(s) this read did not return'))).toBe(true);
    expect(await linksOf(issuesDb.id, 'Issue 1', 'milestone')).toEqual(['Milestone 2']);
  });
});

describe('#1364 a milestone whose project the team read does not hold', () => {
  it('is COUNTED and warned about, not imported and not dropped silently', async () => {
    const made = useTeams([team('MS', 'Milestones', [prj(1)], [ms(1, 'prj-1')], [issue(1)])]);
    const real = made.fetcher;
    linear.fetcher = async (query, variables, key) => {
      const data = (await real(query, variables, key)) as { team?: { projects?: { nodes: Array<Record<string, unknown>> } } };
      // Linear's project list changed between the two reads: the milestone read names a project the first read never returned.
      if (query.includes('query TeamProjectMilestones')) data.team!.projects!.nodes.push({ id: 'prj-ghost', projectMilestones: { nodes: [{ id: 'ms-ghost', name: 'Ghost milestone', description: null, targetDate: null, sortOrder: 1 }], pageInfo: { hasNextPage: false, endCursor: null } } });
      return data;
    };
    const summary = await syncNow();
    expect(summary.milestones).toMatchObject({ distinct: 2, written: 1, orphaned: 1 });
    expect(summary.warnings.some((w: string) => w.includes('"Ghost milestone"') && w.includes('prj-ghost'))).toBe(true);
    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    expect((await rows(milestonesDb.id)).some((r) => r.title === 'Ghost milestone')).toBe(false);
  });
});

describe('#1364 paging and cross-team projects', () => {
  it('a project with more milestones than one nested page is read to the end (and the count says so)', async () => {
    const many = Array.from({ length: 125 }, (_, i) => ms(1000 + i, 'prj-big'));
    const made = useTeams([team('MS', 'Milestones', [prj(1)].concat([{ ...prj(1), id: 'prj-big', name: 'Big' }]), many, [issue(1)])]);
    const summary = await syncNow();
    expect(summary.milestones.distinct).toBe(125);
    expect(made.calls).toContain('ProjectMilestonesPaged'); // the nested first page said there is more
    const milestonesDb = await dbNamed('Milestones (Linear)', 'Milestones');
    expect((await rows(milestonesDb.id)).filter((r) => /^ms-1\d{3}$/.test(String(r.values['linear_id'])))).toHaveLength(125);
  });

  it('a project with no milestone list at all fails the read instead of looking like "none"', async () => {
    const made = useTeams([team('MS', 'Milestones', [prj(1)], [], [issue(1)])]);
    const real = made.fetcher;
    linear.fetcher = async (query, variables, key) => {
      const data = (await real(query, variables, key)) as { team?: { projects?: { nodes: Array<Record<string, unknown>> } } };
      if (query.includes('query TeamProjectMilestones')) for (const p of data.team!.projects!.nodes) delete p['projectMilestones'];
      return data;
    };
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('no milestone list');
  });

  it('a project on TWO teams: its milestones are written to both team databases but counted ONCE', async () => {
    const shared = prj(7);
    const other = { ...prj(8) };
    useTeams([
      team('MS', 'Milestones', [prj(1), shared], [ms(70, 'prj-7'), ms(71, 'prj-7')], [issue(1, { project: { id: 'prj-7' }, projectMilestone: { id: 'ms-70' } })]),
      team('OT', 'Other', [shared, other], [ms(70, 'prj-7'), ms(71, 'prj-7'), ms(80, 'prj-8')], [{ ...issue(9), identifier: 'OT-9', project: { id: 'prj-7' }, projectMilestone: { id: 'ms-71' } }]),
    ]);
    expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['MS', 'OT'] })).statusCode).toBe(201);
    const preview = (await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run?detail=full`)).json();
    expect(preview.milestones).toMatchObject({ distinct: 3, projects_on_several_teams: 1 });
    const summary = await syncNow();
    expect(summary.milestones).toMatchObject({ distinct: 3, written: 5 }); // 2 + 3 records, 3 distinct ids
    const mine = await dbNamed('Milestones (Linear)', 'Milestones');
    const theirs = await dbNamed('Other (Linear)', 'Milestones');
    const union = new Set([...(await rows(mine.id)), ...(await rows(theirs.id))].map((r) => r.values['linear_id']).filter((id) => ['ms-70', 'ms-71', 'ms-80'].includes(String(id))));
    expect(union.size).toBe(3); // the acceptance criterion: distinct ids == union across the Milestones databases
    const otherIssues = await dbNamed('Other (Linear)', 'Issues');
    expect(await linksOf(otherIssues.id, 'Issue 9', 'milestone')).toEqual(['Milestone 71']); // linked inside ITS OWN team's database
  });
});

describe('#1364 access: a milestone is as private as the space it lands in', () => {
  let guest: Person;
  let nogrant: Person;
  let granted: Person;
  let privSpace: string;
  let teamSpace: string;
  beforeAll(async () => {
    await inject('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['PV'] });
    teamSpace = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    // The mirror's space exists, restricted, BEFORE anything is written into it (the order the private-team work depends on).
    privSpace = (await inject('POST', `/workspaces/${ws}/spaces`, { name: 'Private (Linear)' })).json().id;
    await setRestricted(app, admin.token, ws, 'space', privSpace);
    nogrant = await joinAs(app, admin.token, ws, 'MS NoGrant', 'member');
    granted = await joinAs(app, admin.token, ws, 'MS Granted', 'member');
    guest = await joinAs(app, admin.token, ws, 'MS Guest', 'guest', [{ space_id: teamSpace, role: 'editor' }]);
    await grant(app, admin.token, ws, granted.id, { space_id: privSpace }, 'editor');
    useTeams([team('PV', 'Private', [prj(1)], [ms(500, 'prj-1', { name: 'Secret milestone 500' })], [issue(1, { projectMilestone: { id: 'ms-500' }, project: { id: 'prj-1' } })])]);
    await syncNow();
  }, 120_000);

  it('the importer built the Milestones database INSIDE the restricted space', async () => {
    const m = await dbNamed('Private (Linear)', 'Milestones');
    expect(m).toBeTruthy();
    expect((await inject('GET', `/workspaces/${ws}/databases/${m.id}`)).statusCode).toBe(200);
  });

  it('a member without a grant and a guest scoped elsewhere get 404 on the database, a record, its query and its count — and no body names it', async () => {
    const m = await dbNamed('Private (Linear)', 'Milestones');
    const rec = (await rows(m.id))[0]!;
    for (const who of [nogrant, guest]) {
      for (const [method, url, payload] of [
        ['GET', `/workspaces/${ws}/databases/${m.id}`],
        ['GET', `/workspaces/${ws}/databases/${m.id}/records/${rec.id}`],
        ['GET', `/workspaces/${ws}/databases/${m.id}/records?limit=10`],
        ['POST', `/workspaces/${ws}/databases/${m.id}/records/query`, { limit: 10 }],
        ['POST', `/workspaces/${ws}/databases/${m.id}/records/count`, {}],
      ] as Array<[string, string, unknown?]>) {
        const res = await call(app, who.token, method, url, payload);
        expect(res.statusCode, `${method} ${url}`).toBe(404);
        expect(res.body).not.toContain('Secret milestone');
      }
      const found = await call(app, who.token, 'GET', `/workspaces/${ws}/search?q=Secret`);
      expect(JSON.stringify(found.json())).not.toContain('Secret milestone');
      const dbs = await call(app, who.token, 'GET', `/workspaces/${ws}/databases`);
      expect(JSON.stringify(dbs.json())).not.toContain(m.id); // the other teams' open Milestones databases may be listed; this one may not
    }
  });

  it('the member WITH a space grant sees the milestone (the control: the guards are not simply closing everything)', async () => {
    const m = await dbNamed('Private (Linear)', 'Milestones');
    const res = await call(app, granted.token, 'GET', `/workspaces/${ws}/databases/${m.id}/records?limit=10`);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('Secret milestone 500');
  });
});

// keep the unused-helper import honest
void authed;
