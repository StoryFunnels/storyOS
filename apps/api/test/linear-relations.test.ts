import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import type { FakeRelationEdge } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { fields as fieldsTable, selectOptions } from '../src/db/schema';
import { LinearService } from '../src/integrations/linear.service';
import { emptyRelationReport, planIssueRelations, TEAM_RELATIONS_QUERY, TEAM_RELATIONS_SINCE_QUERY } from '../src/integrations/linear-relations';

/**
 * Ticket #1365 — Linear relations (blocks, duplicate, related) as self relations on the team's Issues database.
 *
 * FIXTURES ARE HAND-WRITTEN from Linear's documented GraphQL schema (`IssueRelation.type` blocks / duplicate / related /
 * similar, `issue` = source, `relatedIssue` = target, `Issue.relations` / `Issue.inverseRelations`). They were NOT recorded
 * from a live Linear: no API key exists. What is proven here is this code's behaviour GIVEN that shape; whether Linear returns
 * that shape is the probe's job (ticket #1362).
 *
 * Every link assertion reads the link set back through the links endpoint. A GUEST fixture covers the access boundary.
 */
const OLD = '2020-01-01T00:00:00.000Z';
const TEAM = { id: 'team-rl', key: 'RL', name: 'Relations' };
const OTHER = { id: 'team-ot', key: 'OT', name: 'Other' };
const STATES = [
  { id: 's0', name: 'Todo', type: 'unstarted', position: 0 },
  { id: 's1', name: 'Done', type: 'completed', position: 1 },
  { id: 's2', name: 'Duplicate', type: 'canceled', position: 2 },
];
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const issue = (prefix: string, n: number, extra: Record<string, unknown> = {}) => ({
  ...manyIssues(1)[0]!, id: `${prefix}${n}`, identifier: `${prefix.toUpperCase()}-${n}`, title: `Issue ${prefix}${n}`, updatedAt: OLD, ...extra,
});
const edge = (id: string, type: string, from: string, to: string): FakeRelationEdge => ({ id, type, issue: { id: from }, relatedIssue: { id: to } });

let app: NestFastifyApplication;
let linear: LinearService;
let db: Db;
let admin: { token: string; email: string };
let ws: string;
const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const as = (method: string, url: string, payload?: unknown) => inject(admin.token, method, url, payload);

let edges: FakeRelationEdge[] = [];
let foreign: Record<string, string> = {};
let incomplete = new Set<string>();
let omitted = new Set<string>();
let teamsData: Array<{ team: typeof TEAM; issues: Array<Record<string, unknown>> }> = [];
const use = () => {
  linear.fetcher = makeLinearFetcher(
    teamsData.map((t) => ({ ...t.team, data: { ...empty, states: STATES, issues: { nodes: t.issues } } })),
    { relationEdges: edges, foreignIssueTeams: foreign, relationsIncomplete: incomplete, relationsOmit: omitted },
  ).fetcher;
};
const dbFor = async (workspace: string, space: string) => {
  const spaces = (await as('GET', `/workspaces/${workspace}/spaces`)).json() as Array<{ id: string; name: string }>;
  const sp = spaces.find((s) => s.name === space)!;
  const dbs = (await as('GET', `/workspaces/${workspace}/databases`)).json() as Array<{ id: string; name: string; spaceId?: string; space_id?: string }>;
  return dbs.find((d) => d.name === 'Issues' && (d.spaceId ?? d.space_id) === sp.id)!;
};
const issuesDb = () => dbFor(ws, 'Relations (Linear)');
const recordId = async (title: string, dbId?: string) => {
  const id = dbId ?? (await issuesDb()).id;
  const rows = (await as('GET', `/workspaces/${ws}/databases/${id}/records?limit=100`)).json().data as Array<{ id: string; title: string }>;
  return rows.find((r) => r.title === title)!.id;
};
const fieldId = async (apiName: string) => {
  const d = await issuesDb();
  const full = (await as('GET', `/workspaces/${ws}/databases/${d.id}`)).json();
  return (full.fields as Array<{ id: string; apiName: string }>).find((f) => f.apiName === apiName)!.id;
};
/** The titles linked from an issue on one relation field, read through the links endpoint. */
const links = async (title: string, apiName: string) => {
  const d = await issuesDb();
  const res = await as('GET', `/workspaces/${ws}/databases/${d.id}/records/${await recordId(title)}/links/${await fieldId(apiName)}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as Array<{ title: string }>).map((r) => r.title).sort();
};
const linkEvents = async (title: string) => {
  const id = await recordId(title);
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM activity_events WHERE record_id = ${id} AND type IN ('relation.linked','relation.unlinked')`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0]!.n;
};
const syncNow = async (expectStatus = 201) => {
  const res = await as('POST', `/workspaces/${ws}/integrations/linear/sync`);
  expect(res.statusCode, res.body).toBe(expectStatus);
  return res.json();
};

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  db = app.get<Db>(DB);
  admin = await signUpUser(app, 'Linear Relations');
  ws = (await as('POST', '/workspaces', { name: 'Linear Relations WS' })).json().id;
  expect((await as('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['RL'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('planIssueRelations (pure)', () => {
  const rel = (outgoing: Array<[string, string, string, string | null]>, incoming: Array<[string, string, string, string | null]> = []) => ({
    issueId: 'me',
    outgoing: outgoing.map(([id, type, other, teamKey]) => ({ id, type, other: { id: other, teamKey } })),
    incoming: incoming.map(([id, type, other, teamKey]) => ({ id, type, other: { id: other, teamKey } })),
  });
  const plan = (r: ReturnType<typeof rel>, placeable: (id: string) => boolean = () => true) => {
    const report = emptyRelationReport();
    const cross = new Map<string, string>();
    return { planned: planIssueRelations(r, 'RL', placeable, report, cross), report, cross };
  };

  it('puts an outgoing blocks under Blocks and an incoming one under Blocked by', () => {
    const { planned } = plan(rel([['e1', 'blocks', 'a', 'RL']], [['e2', 'blocks', 'b', 'RL']]));
    expect(planned.blocks).toEqual(['a']);
    expect(planned.blocked_by).toEqual(['b']);
  });

  it('puts "I am a duplicate of X" under Duplicate of and "X is a duplicate of me" under Duplicates', () => {
    const { planned } = plan(rel([['e1', 'duplicate', 'orig', 'RL']], [['e2', 'duplicate', 'dup', 'RL']]));
    expect(planned.duplicate_of).toEqual(['orig']);
    expect(planned.duplicates).toEqual(['dup']);
  });

  it('keeps only the FIRST duplicate-of and says how many it dropped', () => {
    const { planned, report } = plan(rel([['e1', 'duplicate', 'a', 'RL'], ['e2', 'duplicate', 'b', 'RL']]));
    expect(planned.duplicate_of).toEqual(['a']);
    expect(report.duplicate_of_extra_ignored).toBe(1);
  });

  it('never imports Linear\'s own `similar`, and names a type it does not know instead of dropping it silently', () => {
    const { planned, report } = plan(rel([['e1', 'similar', 'a', 'RL'], ['e2', 'weird', 'b', 'RL']]));
    expect(Object.values(planned).flat()).toEqual([]);
    expect(report.similar_ignored).toBe(1);
    expect(report.unknown_types).toEqual({ weird: 1 });
  });

  it('a relation to another team is counted by team pair, not planned; a missing team is foreign, not assumed to be this one', () => {
    const { planned, report, cross } = plan(rel([['e1', 'blocks', 'x', 'OT'], ['e3', 'related', 'z', null]], [['e2', 'blocks', 'y', 'OT']]));
    expect(Object.values(planned).flat()).toEqual([]);
    expect(report.cross_team).toEqual({ 'RL→OT': 1, 'RL→?': 1, 'OT→RL': 1 });
    expect([...cross.keys()].sort()).toEqual(['e1', 'e2', 'e3']);
  });

  it('a target that is not in the mirror is counted as unplaced, an issue related to itself is ignored', () => {
    const { planned, report } = plan(rel([['e1', 'blocks', 'gone', 'RL'], ['e2', 'related', 'me', 'RL']]), (id) => id !== 'gone');
    expect(Object.values(planned).flat()).toEqual([]);
    expect(report.unplaced).toBe(1);
    expect(report.self_relation).toBe(1);
  });

  it('the since variant of the query derives from the full one', () => {
    expect(TEAM_RELATIONS_SINCE_QUERY).toContain('updatedAt: { gt: $since }');
    expect(TEAM_RELATIONS_QUERY).not.toContain('$since');
  });
});

describe('a full sync makes the relations equal Linear\'s, in both directions', () => {
  it('first sync creates the three self relations and links blocks, duplicate and related from both ends', async () => {
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4, { state: { type: 'canceled', name: 'Duplicate' } })] }];
    edges = [edge('e1', 'blocks', 'i1', 'i2'), edge('e2', 'blocks', 'i1', 'i3'), edge('e3', 'duplicate', 'i4', 'i2'), edge('e4', 'related', 'i1', 'i4')];
    use();
    const s = await syncNow();
    expect(s.warnings ?? []).toEqual([]);
    expect(await links('Issue i2', 'blocked_by')).toEqual(['Issue i1']);
    expect(await links('Issue i3', 'blocked_by')).toEqual(['Issue i1']);
    expect(await links('Issue i1', 'blocks')).toEqual(['Issue i2', 'Issue i3']);
    expect(await links('Issue i4', 'duplicate_of')).toEqual(['Issue i2']);
    expect(await links('Issue i2', 'duplicates')).toEqual(['Issue i4']);
    expect(await links('Issue i1', 'related')).toEqual(['Issue i4']);
    expect(await links('Issue i4', 'related_to')).toEqual(['Issue i1']);
    const t = s.relations.per_team[0];
    expect([t.blocks, t.duplicate, t.related]).toEqual([2, 1, 1]);
    expect(s.relations.cross_team_total).toBe(0);
  });

  it('the relation is visible on the record itself (chips), not only through the links endpoint', async () => {
    const d = await issuesDb();
    const rec = (await as('GET', `/workspaces/${ws}/databases/${d.id}/records/${await recordId('Issue i2')}`)).json();
    expect((rec.values.blocked_by as Array<{ title: string }>).map((c) => c.title)).toEqual(['Issue i1']);
  });

  it('a sync of an unchanged mirror writes no link events', async () => {
    const before = [await linkEvents('Issue i1'), await linkEvents('Issue i2'), await linkEvents('Issue i4')];
    await syncNow();
    expect([await linkEvents('Issue i1'), await linkEvents('Issue i2'), await linkEvents('Issue i4')]).toEqual(before);
  });

  it('LINEAR OWNS these links: one a person added in StoryOS that Linear does not have is removed on the next sync', async () => {
    const d = await issuesDb();
    const add = await as('POST', `/workspaces/${ws}/databases/${d.id}/records/${await recordId('Issue i3')}/links/${await fieldId('blocks')}`, { record_ids: [await recordId('Issue i4')] });
    expect(add.statusCode, add.body).toBeLessThan(300);
    expect(await links('Issue i3', 'blocks')).toEqual(['Issue i4']);
    await syncNow();
    expect(await links('Issue i3', 'blocks')).toEqual([]);
    expect(await links('Issue i4', 'blocked_by')).toEqual([]);
  });

  it('a relation REMOVED in Linear is unlinked at both ends', async () => {
    edges = edges.filter((e) => e.id !== 'e2');
    use();
    await syncNow();
    expect(await links('Issue i3', 'blocked_by')).toEqual([]);
    expect(await links('Issue i1', 'blocks')).toEqual(['Issue i2']);
  });

  it('a relation ADDED in Linear is linked, and a duplicate-of that MOVES replaces the old one (one-to-many)', async () => {
    edges = [...edges.filter((e) => e.id !== 'e3'), edge('e5', 'duplicate', 'i4', 'i3'), edge('e2', 'blocks', 'i1', 'i3')];
    use();
    await syncNow();
    expect(await links('Issue i4', 'duplicate_of')).toEqual(['Issue i3']);
    expect(await links('Issue i2', 'duplicates')).toEqual([]);
    expect(await links('Issue i3', 'blocked_by')).toEqual(['Issue i1']);
  });

  it('`similar` is not imported and an unknown type is reported, never linked silently', async () => {
    edges = [...edges, edge('e6', 'similar', 'i2', 'i3'), edge('e7', 'weird', 'i2', 'i3')];
    use();
    const s = await syncNow();
    expect(await links('Issue i2', 'related')).toEqual([]);
    expect(await links('Issue i2', 'blocks')).toEqual([]);
    const t = s.relations.per_team[0];
    expect(t.similar_ignored).toBe(1);
    expect(t.unknown_types).toEqual({ weird: 1 });
    expect((s.warnings as string[]).some((w) => w.includes('unknown type') && w.includes('weird'))).toBe(true);
  });

  it('an incomplete nested relation list FAILS the read and changes nothing (a dropped relation would be unlinked as "removed in Linear")', async () => {
    incomplete = new Set(['i1']);
    use();
    const before = await links('Issue i1', 'blocks');
    const res = await as('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('more than 50 relations');
    expect(await links('Issue i1', 'blocks')).toEqual(before);
    incomplete = new Set();
    use();
  });
});

describe('a relation read that disagrees with the issue read fails before anything is written', () => {
  it('a relations stream that leaves an issue out FAILS a full read (it would otherwise unlink that issue\'s relations as "removed in Linear")', async () => {
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] }];
    edges = [edge('e1', 'blocks', 'i1', 'i2'), edge('e2', 'blocks', 'i1', 'i3')];
    omitted = new Set(['i2']);
    use();
    const before = await links('Issue i1', 'blocks');
    const res = await as('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('cover');
    expect(await links('Issue i1', 'blocks')).toEqual(before);
    omitted = new Set();
    use();
  });

  it('an incomplete list in only the INCOMING direction fails the read too', async () => {
    incomplete = new Set(['in:i2']);
    linear.fetcher = makeLinearFetcher(
      [{ ...TEAM, data: { ...empty, states: STATES, issues: { nodes: teamsData[0]!.issues } } }],
      { relationEdges: edges, relationsIncomplete: incomplete },
    ).fetcher;
    const res = await as('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode).toBe(422);
    incomplete = new Set();
    use();
  });
});

describe('cross-team relations: reported, never silently dropped, never linked', () => {
  it('an edge to another team\'s issue is counted by team pair with a warning, and writes no link', async () => {
    foreign = { x1: 'OT', x2: 'OT' };
    edges = [...edges.filter((e) => e.id === 'e1'), edge('c1', 'blocks', 'i1', 'x1'), edge('c2', 'blocks', 'x2', 'i2')];
    use();
    const s = await syncNow();
    expect(s.relations.cross_team_policy).toBe('report');
    expect(s.relations.cross_team_total).toBe(2);
    expect(s.relations.per_team[0].cross_team).toEqual({ 'RL→OT': 1, 'OT→RL': 1 });
    expect((s.warnings as string[]).some((w) => w.includes('another team') && w.includes('NOT imported'))).toBe(true);
    // The response names no title and no identifier of the foreign issue.
    expect(JSON.stringify(s.relations)).not.toContain('x1');
    expect(await links('Issue i1', 'blocks')).toEqual(['Issue i2']);
    expect(await links('Issue i2', 'blocked_by')).toEqual(['Issue i1']);
  });

  it('an edge between two IMPORTED teams is counted once, although both teams see it', async () => {
    foreign = {};
    teamsData = [
      { team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] },
      { team: OTHER, issues: [issue('o', 1)] },
    ];
    edges = [edge('c3', 'blocks', 'i1', 'o1')];
    use();
    expect((await as('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['RL', 'OT'] })).statusCode).toBe(201);
    const s = await syncNow();
    expect(s.relations.cross_team_total).toBe(1);
    const seen = (s.relations.per_team as Array<{ key: string; cross_team: Record<string, number> }>).map((t) => [t.key, t.cross_team]);
    expect(seen).toEqual([['RL', { 'RL→OT': 1 }], ['OT', { 'RL→OT': 1 }]]);
    expect(await links('Issue i1', 'blocks')).toEqual([]);
    expect((await as('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['RL'] })).statusCode).toBe(201);
  });

  it('the preview reports the same cross-team count and writes nothing', async () => {
    foreign = { x1: 'OT' };
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] }];
    edges = [edge('e1', 'blocks', 'i1', 'i2'), edge('c1', 'blocks', 'i1', 'x1'), edge('c9', 'related', 'i3', 'x1')];
    use();
    const res = await as('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.relations_cross_team_total).toBe(2);
    expect(body.teams[0].relations.blocks).toBe(1);
    expect(body.teams[0].relations.cross_team).toEqual({ 'RL→OT': 2 });
    expect(body.relations_cross_team_policy).toBe('report');
  });
});

describe('the Duplicate state has a category', () => {
  const stateOption = async (name: string) => {
    const d = await issuesDb();
    const f = await db.query.fields.findFirst({ where: and(eq(fieldsTable.databaseId, d.id), eq(fieldsTable.apiName, 'state')) });
    const options = await db.query.selectOptions.findMany({ where: eq(selectOptions.fieldId, f!.id) });
    return options.find((o) => o.label === name)!;
  };

  it('Linear reports a type we do not map for Duplicate (hypothesis 1 for the live mirror): the option still gets canceled, and the report says what Linear said', async () => {
    const opt = await stateOption('Duplicate');
    await db.update(selectOptions).set({ category: null }).where(eq(selectOptions.id, opt.id));
    expect((await stateOption('Duplicate')).category).toBeNull();
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] }];
    edges = [];
    linear.fetcher = makeLinearFetcher(
      [{ ...TEAM, data: { ...empty, states: STATES.map((st) => (st.name === 'Duplicate' ? { ...st, type: 'duplicate' } : st)), issues: { nodes: teamsData[0]!.issues } } }],
    ).fetcher;
    const s = await syncNow();
    expect((await stateOption('Duplicate')).category).toBe('canceled');
    expect(s.relations.per_team[0].duplicate_state).toEqual({ outcome: 'category_set', linear_type: 'duplicate', in_team_workflow: true, was: null });
  });

  it('when Linear reports `canceled`, the ordinary state sync has already categorised it: the report says ok, not a second write', async () => {
    const opt = await stateOption('Duplicate');
    await db.update(selectOptions).set({ category: null }).where(eq(selectOptions.id, opt.id));
    use();
    const s = await syncNow();
    expect((await stateOption('Duplicate')).category).toBe('canceled');
    expect(s.relations.per_team[0].duplicate_state.outcome).toBe('ok');
  });

  it('an option already categorised is left alone', async () => {
    const s = await syncNow();
    expect(s.relations.per_team[0].duplicate_state.outcome).toBe('ok');
  });

  it('an option that is NOT in the team\'s workflow (a leftover) is categorised too, and the report says it is a leftover', async () => {
    const opt = await stateOption('Duplicate');
    await db.update(selectOptions).set({ category: null }).where(eq(selectOptions.id, opt.id));
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] }];
    // The team's workflow no longer lists Duplicate (and no issue is in it).
    linear.fetcher = makeLinearFetcher(
      [{ ...TEAM, data: { ...empty, states: STATES.filter((st) => st.name !== 'Duplicate'), issues: { nodes: teamsData[0]!.issues } } }],
    ).fetcher;
    const s = await syncNow();
    expect((await stateOption('Duplicate')).category).toBe('canceled');
    expect(s.relations.per_team[0].duplicate_state).toEqual({ outcome: 'category_set', linear_type: null, in_team_workflow: false, was: null });
  });
});

describe('existing fields: adopt an exact match, never write into one we cannot tell is ours', () => {
  const relationFieldsOf = async (workspace: string, dbId: string) =>
    ((await as('GET', `/workspaces/${workspace}/databases/${dbId}`)).json().fields as Array<{ id: string; displayName: string; type: string }>).filter((f) => f.type === 'relation');
  const stripStamps = async (ids: string[]) => {
    for (const id of ids) await db.update(fieldsTable).set({ config: sql`${fieldsTable.config} - 'linear_relation'` }).where(eq(fieldsTable.id, id));
  };

  it('a pair of the right shape that carries no stamp (hand-made, or the stamp was lost) is ADOPTED: one pair, no "Blocks 2", and it works', async () => {
    const wsB = (await as('POST', '/workspaces', { name: 'Linear Relations Adopt WS' })).json().id as string;
    expect((await as('POST', `/workspaces/${wsB}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['RL'] })).statusCode).toBe(201);
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2)] }];
    edges = [];
    use();
    expect((await as('POST', `/workspaces/${wsB}/integrations/linear/sync`)).statusCode).toBe(201);
    const d = await dbFor(wsB, 'Relations (Linear)');
    const first = await relationFieldsOf(wsB, d.id);
    await stripStamps(first.map((f) => f.id));
    edges = [edge('e1', 'blocks', 'i1', 'i2')];
    use();
    const second = await as('POST', `/workspaces/${wsB}/integrations/linear/sync`);
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().warnings ?? []).toEqual([]);
    const after = await relationFieldsOf(wsB, d.id);
    expect(after.map((f) => f.id).sort()).toEqual(first.map((f) => f.id).sort());
    const blockedBy = after.find((f) => f.displayName === 'Blocked by')!;
    const rows = (await as('GET', `/workspaces/${wsB}/databases/${d.id}/records?limit=10`)).json().data as Array<{ id: string; title: string }>;
    const i2 = rows.find((r) => r.title === 'Issue i2')!;
    const linked = await as('GET', `/workspaces/${wsB}/databases/${d.id}/records/${i2.id}/links/${blockedBy.id}`);
    expect((linked.json().data as Array<{ title: string }>).map((r) => r.title)).toEqual(['Issue i1']);
  });

  it('a field that holds the name but is NOT a matching self relation is left alone: the pair is skipped with a warning naming it', async () => {
    const wsC = (await as('POST', '/workspaces', { name: 'Linear Relations Clash WS' })).json().id as string;
    expect((await as('POST', `/workspaces/${wsC}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['RL'] })).statusCode).toBe(201);
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2)] }];
    edges = [edge('e1', 'related', 'i1', 'i2')];
    use();
    expect((await as('POST', `/workspaces/${wsC}/integrations/linear/sync`)).statusCode).toBe(201);
    const d = await dbFor(wsC, 'Relations (Linear)');
    const all = await relationFieldsOf(wsC, d.id);
    await stripStamps(all.map((f) => f.id));
    // The person renamed the second side away: "Related" still holds the name, but it is no longer one side of a matching pair.
    await db.update(fieldsTable).set({ displayName: 'Mine' }).where(eq(fieldsTable.id, all.find((f) => f.displayName === 'Related to')!.id));
    const second = await as('POST', `/workspaces/${wsC}/integrations/linear/sync`);
    expect(second.statusCode, second.body).toBe(201);
    const warnings = second.json().warnings as string[];
    expect(warnings.some((w) => w.includes('Related') && w.includes('not a matching self relation'))).toBe(true);
    // And it wrote nothing into either field it could not call its own.
    const rows = (await as('GET', `/workspaces/${wsC}/databases/${d.id}/records?limit=10`)).json().data as Array<{ id: string; title: string }>;
    const i1 = rows.find((r) => r.title === 'Issue i1')!;
    const related = all.find((f) => f.displayName === 'Related')!;
    const res = await as('GET', `/workspaces/${wsC}/databases/${d.id}/records/${i1.id}/links/${related.id}`);
    expect((res.json().data as Array<unknown>).length).toBe(1); // the link the FIRST sync made; the second sync did not touch it
  });
});

describe('access: a link never reveals a record the viewer cannot read', () => {
  it('a GUEST with record grants on two issues sees only the linked issue she holds a grant on, on the record and on the links endpoint', async () => {
    const guest = await signUpUser(app, 'Linear Relations Guest');
    const guestId = (await inject(guest.token, 'GET', '/me')).json().id as string;
    teamsData = [{ team: TEAM, issues: [issue('i', 1), issue('i', 2), issue('i', 3), issue('i', 4)] }];
    edges = [edge('a1', 'blocks', 'i1', 'i2'), edge('a2', 'blocks', 'i3', 'i2'), edge('a3', 'related', 'i1', 'i3')];
    use();
    await syncNow();
    const d = await issuesDb();
    const r1 = await recordId('Issue i1');
    const r2 = await recordId('Issue i2');
    const r3 = await recordId('Issue i3');
    const r4 = await recordId('Issue i4');
    // Record-scoped grants on Issue i2 and Issue i1 only (never a space or database grant).
    const invite = await as('POST', `/workspaces/${ws}/invites`, { email: guest.email, role: 'guest', grants: [{ record_id: r2, role: 'viewer' }] });
    expect(invite.statusCode, invite.body).toBeLessThan(300);
    await inject(guest.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
    expect((await as('POST', `/workspaces/${ws}/grants`, { user_id: guestId, record_id: r1, role: 'viewer' })).statusCode).toBeLessThan(300);

    // Issue i2 is blocked by i1 (granted) and i3 (NOT granted): the chip for i3 is absent, not redacted.
    const rec = await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${r2}`);
    expect(rec.statusCode, rec.body).toBe(200);
    const chips = (rec.json().values.blocked_by as Array<{ id: string }>).map((c) => c.id);
    expect(chips).toEqual([r1]);
    expect(JSON.stringify(rec.json())).not.toContain('Issue i3');
    // The panel endpoint agrees.
    const panel = await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${r2}/links/${await fieldId('blocked_by')}`);
    expect((panel.json().data as Array<{ id: string }>).map((r) => r.id)).toEqual([r1]);
    // Issue i1's Related chip names i3 (not granted): absent. Issue i3 and i4 are unreachable.
    const rec1 = await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${r1}`);
    expect(rec1.json().values.related ?? []).toEqual([]);
    expect(JSON.stringify(rec1.json())).not.toContain('Issue i3');
    expect((await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${r3}`)).statusCode).toBe(404);
    expect((await inject(guest.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${r4}`)).statusCode).toBe(404);
  });

  it('a guest with no grant on the database cannot read the Issues at all (the links are not a way in)', async () => {
    const stranger = await signUpUser(app, 'Linear Relations Stranger');
    const d = await issuesDb();
    const res = await inject(stranger.token, 'GET', `/workspaces/${ws}/databases/${d.id}/records/${await recordId('Issue i2')}`);
    expect([403, 404]).toContain(res.statusCode);
  });
});
