import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import type { FakeRelationEdge } from './helpers/linear-fake';
import { LinearService } from '../src/integrations/linear.service';

/**
 * Ticket #1370 — the ownership guard sits at the ONE per-team entry of the sync, not in each writer, so every writer that runs inside
 * a team's turn (issues, labels, cycles, projects, milestones, comments, links, and whatever the importer PRs still open add: relations,
 * attachments, documents) is covered by default. This test does not name writers. It snapshots EVERYTHING in the cut-over team's space
 * (every database's records, their values and updated_at, their comments, their links, the activity trail) and asserts a sync that
 * Linear has changed in every way leaves the snapshot byte-identical. A writer added later fails here without being listed.
 *
 * Milestones are named in the fixtures because they are the writer already on main that also creates a database of its own.
 */
const OLD = '2020-01-01T00:00:00.000Z';
const TEAM = { id: 'team-ms', key: 'MS', name: 'Milestones' };
const prj = (n: number, name = `Project ${n}`) => ({ id: `prj-${n}`, name, description: null, state: 'started', targetDate: null, url: `https://linear.app/acme/project/p${n}` });
const ms = (n: number, projectId: string, name = `Milestone ${n}`) => ({ id: `ms-${n}`, projectId, name, description: null, targetDate: '2026-12-01', sortOrder: n * 10 + 0.5 });
const issue = (n: number, extra: Record<string, unknown> = {}) => ({ ...manyIssues(1)[0]!, id: `i${n}`, identifier: `MS-${n}`, title: `Issue ${n}`, updatedAt: OLD, ...extra });
const comment = (n: number, issueId: string): Record<string, unknown> => ({ id: `c${n}`, body: `Comment ${n}`, createdAt: '2026-11-01T09:00:00.000Z', updatedAt: OLD, url: `https://linear.app/acme/issue/MS-1#comment-c${n}`, user: { name: 'Tyron Dizon' }, botActor: null, externalUser: null, issue: { id: issueId } });

const att = (id: string, issueId: string, url: string, sourceType = 'github') => ({ id, issueId, title: `Title ${id}`, subtitle: null, url, sourceType, metadata: {}, createdAt: '2026-03-01T00:00:00Z', updatedAt: OLD });
const doc = (id: string, project: string | null, body = `Body of ${id}.`) => ({ id, title: `Doc ${id}`, url: `https://linear.app/acme/document/${id}`, content: `# Heading ${id}\n\n${body}`, createdAt: '2026-01-05T09:00:00Z', updatedAt: '2026-01-06T09:00:00Z', creator: { name: 'Pat Writer' }, project: project ? { id: project } : null });

const rel = (id: string, type: string, from: string, to: string): FakeRelationEdge => ({ id, type, issue: { id: from }, relatedIssue: { id: to } });

const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
const adm = (m: string, u: string, p?: unknown) => call(app, admin.token, m, u, p);
const rows = async (q: ReturnType<typeof sql>) => (await rawDb.execute(q)).rows as Array<Record<string, unknown>>;
const linearSide = (over: { projects: unknown[]; milestones: ReturnType<typeof ms>[]; issues: unknown[]; comments?: Array<Record<string, unknown>>; attachments?: Array<Record<string, unknown>>; documents?: Array<Record<string, unknown>>; relations?: FakeRelationEdge[] }) => {
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { labels: { nodes: [] }, cycles: { nodes: [] }, projects: { nodes: over.projects }, issues: { nodes: over.issues as never }, milestones: over.milestones, comments: over.comments, attachments: over.attachments ?? [], documents: over.documents ?? [] } as never }], { relationEdges: over.relations ?? [] }).fetcher;
};
/** Everything the team's space holds, in one comparable value. */
async function snapshot() {
  const space = (await rows(sql`select id from spaces where workspace_id = ${ws} and name = 'Milestones (Linear)' and deleted_at is null`))[0]!.id as string;
  const dbs = await rows(sql`select id, name, record_counter from databases where space_id = ${space} and deleted_at is null order by name`);
  // Ticket #1366's PR records are written into the workspace's SHARED "GitHub Pull Requests" database, outside the team's space.
  const shared = await rows(sql`select id, name, record_counter from databases where workspace_id = ${ws} and name = 'GitHub Pull Requests' and deleted_at is null`);
  const ids = [...dbs, ...shared].map((d) => d.id as string);
  const recs = await rows(sql`select database_id, id, number, title, values, updated_at, deleted_at from records where database_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}) order by database_id, id`);
  const recIds = recs.map((r) => r.id as string);
  const inRecs = sql.join(recIds.map((i) => sql`${i}::uuid`), sql`, `);
  return {
    dbs: [...dbs, ...shared],
    recs,
    comments: await rows(sql`select id, record_id, body from comments where record_id in (${inRecs}) order by id`),
    links: await rows(sql`select * from record_links where from_record_id in (${inRecs}) or to_record_id in (${inRecs}) order by id`),
    events: Number((await rows(sql`select count(*)::int as n from activity_events where record_id in (${inRecs})`))[0]!.n),
    fieldChanges: Number((await rows(sql`select count(*)::int as n from record_field_changes where record_id in (${inRecs})`))[0]!.n),
    fields: Number((await rows(sql`select count(*)::int as n from fields where database_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`))[0]!.n),
  };
}

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Cutover Writers Admin');
  ws = (await adm('POST', '/workspaces', { name: 'Cutover Writers WS' })).json().id;
  expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['MS'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('a StoryOS-owned team gets ZERO writes from any importer writer', () => {
  it('while Linear owns it, the same Linear-side changes DO change the space (so the snapshot test below can fail)', async () => {
    linearSide({ projects: [prj(1), prj(2)], milestones: [ms(1, 'prj-1'), ms(2, 'prj-2')], issues: [issue(1, { projectMilestone: { id: 'ms-1' }, project: { id: 'prj-1' } }), issue(2)], comments: [comment(1, 'i1')], attachments: [att('a1', 'i1', 'https://github.com/acme/site/pull/12'), att('a2', 'i2', 'https://example.com/spec', 'url')], documents: [doc('d1', 'prj-1')], relations: [rel('r1', 'blocks', 'i1', 'i2')] });
    expect((await adm('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    const before = await snapshot();
    expect(before.dbs.map((d) => d.name)).toEqual(expect.arrayContaining(['Issues', 'Milestones', 'Projects', 'GitHub Pull Requests', 'Links', 'Documents']));
    linearSide({ projects: [prj(1, 'Project 1 renamed'), prj(2), prj(3)], milestones: [ms(1, 'prj-1', 'Milestone 1 renamed'), ms(2, 'prj-2'), ms(3, 'prj-3')], issues: [issue(1, { title: 'Issue 1 renamed', updatedAt: new Date(Date.now() + 60_000).toISOString() }), issue(2), issue(3)], comments: [comment(1, 'i1'), comment(2, 'i2')], attachments: [att('a1', 'i1', 'https://github.com/acme/site/pull/12'), att('a2', 'i2', 'https://example.com/spec', 'url'), att('a3', 'i1', 'https://github.com/acme/site/pull/13')], documents: [doc('d1', 'prj-1', 'edited in Linear'), doc('d2', 'prj-2')], relations: [rel('r1', 'blocks', 'i1', 'i2'), rel('r2', 'related', 'i1', 'i3')] });
    expect((await adm('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    expect(JSON.stringify(await snapshot())).not.toEqual(JSON.stringify(before));
  });

  it('after cutover a manual sync, a scheduled sync and a Preview change nothing anywhere in the team\'s space, milestones included', async () => {
    const cut = await adm('PUT', `/workspaces/${ws}/integrations/linear/teams/MS/ownership`, { owner: 'storyos' });
    expect(cut.statusCode, cut.body).toBe(200);
    const before = await snapshot();
    // Linear moves on in every way the importer writes: renames a project and a milestone, adds a project, a milestone, issues and comments.
    linearSide({
      projects: [prj(1, 'Project 1 renamed AGAIN'), prj(2), prj(3), prj(4)],
      milestones: [ms(1, 'prj-1', 'Milestone 1 renamed AGAIN'), ms(2, 'prj-2'), ms(3, 'prj-3'), ms(4, 'prj-4')],
      issues: [issue(1, { title: 'Linear says something else', updatedAt: new Date(Date.now() + 120_000).toISOString(), projectMilestone: { id: 'ms-4' } }), issue(3), issue(4, { projectMilestone: { id: 'ms-3' } })],
      comments: [comment(1, 'i1'), comment(3, 'i4')],
      attachments: [att('a1', 'i1', 'https://github.com/acme/site/pull/12'), att('a4', 'i1', 'https://github.com/acme/site/pull/14'), att('a5', 'i4', 'https://example.com/new', 'url')],
      documents: [doc('d1', 'prj-1', 'edited AGAIN in Linear'), doc('d3', 'prj-3'), doc('d4', 'prj-4')],
      relations: [rel('r3', 'blocks', 'i4', 'i1'), rel('r4', 'duplicate', 'i3', 'i1')],
    });
    expect((await adm('POST', `/workspaces/${ws}/integrations/linear/sync`)).statusCode).toBe(201);
    await adm('POST', `/workspaces/${ws}/integrations/linear`, { auto_sync: { enabled: true } });
    await linear.tick(new Date(Date.now() + 2 * 3_600_000));
    const preview = await adm('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(preview.statusCode, preview.body).toBe(201);
    expect(JSON.stringify(await snapshot())).toEqual(JSON.stringify(before));
  });
});
