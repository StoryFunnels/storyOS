import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher } from './helpers/linear-fake';
import { commentShape, historyShape, issueShape, person, WORKFLOW_STATES } from './fixtures/linear-documented-shapes';
import { LinearService, fetchTeamIssueHistory } from '../src/integrations/linear.service';
import { ImportHistoryService } from '../src/migration-framework/import-history.service';
import { linearDay, linearIssueNumber, MemberMatcher, stateHistoryRows } from '../src/integrations/linear-import-support';

/**
 * Ticket #1367 — the Linear importer keeps Linear's own dates, state history and people: a record says when it was REALLY created,
 * its status timeline is Linear's, and an assignee or a comment author is the workspace member with that email.
 *
 * The Linear side is a DOCUMENTED-SHAPE fixture (test/fixtures/linear-documented-shapes.ts), not a live capture.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-eng', key: 'ISSUE', name: 'Engineering' };

describe('pure rules', () => {
  it('the issue number is Linear\'s own; the identifier is the fallback; a contradiction or nothing usable is refused', () => {
    expect(linearIssueNumber({ number: 5201, identifier: 'ISSUE-5201' }, 'ISSUE')).toBe(5201);
    expect(linearIssueNumber({ identifier: 'ISSUE-77' }, 'ISSUE')).toBe(77);
    expect(() => linearIssueNumber({ number: 5, identifier: 'ISSUE-6' }, 'ISSUE')).toThrow(/contradicts/);
    expect(() => linearIssueNumber({ identifier: 'nonsense' }, 'ISSUE')).toThrow(/no usable number/);
    expect(() => linearIssueNumber({ number: 0, identifier: 'x' }, 'ISSUE')).toThrow(/no usable number/);
  });

  it('a timestamp lands on its UTC day; garbage and nothing give null instead of today', () => {
    expect(linearDay('2025-03-04T23:59:59.000Z')).toBe('2025-03-04');
    expect(linearDay('2025-07-01')).toBe('2025-07-01');
    expect(linearDay(null)).toBeNull();
    expect(linearDay('soon')).toBeNull();
  });

  it('members match by email only, case-insensitively; a name never matches; the report lists every unmatched person', () => {
    const m = new MemberMatcher([{ id: 'u1', email: 'Ada@Acme.test' }]);
    expect(m.match({ name: 'Ada', email: 'ADA@acme.TEST' })).toBe('u1');
    expect(m.match({ name: 'Ada Lovelace' }), 'the same name with no email is not a match').toBeNull();
    expect(m.match({ name: 'Jake', email: 'jake@x.test' })).toBeNull();
    m.match({ name: 'Jake', email: 'jake@x.test' });
    const r = m.report();
    expect(r).toMatchObject({ linear_people: 3, matched: 1, unmatched_total: 2 });
    expect(r.unmatched[0]).toEqual({ email: 'jake@x.test', name: 'Jake', count: 2 });
  });

  it('state history: oldest first, real times, the actor as a member when one matches; other kinds of change are not rows; an unknown state is counted', () => {
    const options = new Map([['Todo', 'o-todo'], ['In Progress', 'o-prog'], ['Done', 'o-done']]);
    const find = (p: { email?: string | null } | null) => (p?.email === 'ada@x.test' ? 'u-ada' : null);
    const ada = { name: 'Ada', email: 'ada@x.test' };
    const { rows, skipped } = stateHistoryRows(
      [
        historyShape('h3', '2025-05-03T00:00:00.000Z', 'In Progress', 'Done', null),
        historyShape('h1', '2025-05-01T00:00:00.000Z', null, 'Todo', ada),
        historyShape('h4', '2025-05-04T00:00:00.000Z', null, null, ada), // a title edit: neither state
        historyShape('h2', '2025-05-02T00:00:00.000Z', 'Todo', 'In Progress', ada),
        historyShape('h5', '2025-05-05T00:00:00.000Z', 'Done', 'Shipping', ada), // no such option
      ],
      options,
      find,
    );
    expect(rows.map((r) => [r.at.toISOString().slice(0, 10), r.oldValue, r.newValue, r.actorUserId])).toEqual([
      ['2025-05-01', null, 'o-todo', 'u-ada'],
      ['2025-05-02', 'o-todo', 'o-prog', 'u-ada'],
      ['2025-05-03', 'o-prog', 'o-done', null],
    ]);
    expect(skipped, 'the change into a state with no option is counted, not mapped to a neighbour').toBe(1);
  });

  it('an issue whose history runs past the first page is followed to its end, not truncated', async () => {
    const issue = issueShape(TEAM, 1);
    const many = Array.from({ length: 130 }, (_, i) => historyShape(`h${i}`, new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(), 'Todo', 'In Progress', null));
    const fake = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: [issue as never] }, history: { [issue.id]: many } } }]);
    const got = await fetchTeamIssueHistory(fake.fetcher, 'k', TEAM);
    expect(got.get(issue.id)).toHaveLength(130);
    expect(fake.calls.filter((c) => c === 'IssueHistoryMore'), '50 on the first page, then 80 in one more').toHaveLength(1);
  });
});

const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let owner: { token: string };
let ada: Person;
let grace: Person;
let ws: string;
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => as(owner.token, method, url, payload);
const rows = async (q: ReturnType<typeof sql>) => (await rawDb.execute(q)).rows as Array<Record<string, unknown>>;

async function issuesOf(workspace: string, teamName = 'Engineering') {
  const dbs = (await adm('GET', `/workspaces/${workspace}/databases`)).json() as Array<{ id: string; name: string; spaceName?: string }>;
  const db = dbs.find((d) => d.name === 'Issues')!;
  const list = (await adm('GET', `/workspaces/${workspace}/databases/${db.id}/records?limit=100`)).json().data as Array<{ id: string; number: number; identifier: string | null; title: string; values: Record<string, unknown>; created_at: string; updated_at: string }>;
  void teamName;
  return { db, list, byTitle: (t: string) => list.find((r) => r.title === t)! };
}

const use = (issues: unknown[], extra: { comments?: unknown[]; history?: Record<string, unknown[]>; members?: unknown[]; private?: boolean } = {}) => {
  linear.fetcher = makeLinearFetcher([
    { ...TEAM, private: extra.private, data: { ...empty, issues: { nodes: issues as never }, states: WORKFLOW_STATES, comments: extra.comments as never, history: extra.history as never, members: extra.members as never } },
  ]).fetcher;
};
const sync = () => adm('POST', `/workspaces/${ws}/integrations/linear/sync`);

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  owner = await signUpUser(app, 'Dates Owner');
  ws = (await adm('POST', '/workspaces', { name: 'Dates WS' })).json().id;
  ada = await joinAs(app, owner.token, ws, 'Ada Lovelace', 'member');
  grace = await joinAs(app, owner.token, ws, 'Grace Hopper', 'member');
  expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] })).statusCode).toBe(201);
}, 240_000);
afterAll(async () => { await app.close(); });

describe('a fresh import keeps Linear\'s numbers, dates, state history and people', () => {
  let report: Record<string, any>;
  const adaInLinear = () => ({ id: 'lin-ada', name: 'Ada Lovelace', email: ada.email.toUpperCase() });
  const jake = { id: 'lin-jake', name: 'Jake Alim', email: 'jake@elsewhere.test' };

  it('syncs with Linear\'s real numbers, so the record answers to ISSUE-5201 and new records continue after the highest', async () => {
    const i1 = issueShape(TEAM, 5201, { assignee: adaInLinear(), state: { type: 'completed', name: 'Done' }, completedAt: '2025-05-03T00:00:00.000Z' });
    const i2 = issueShape(TEAM, 5202, { assignee: jake, dueDate: null, startedAt: null });
    const i3 = issueShape(TEAM, 5204, { assignee: null, createdAt: '2024-11-30T23:59:59.000Z', updatedAt: '2025-01-02T00:00:00.000Z' });
    use([i1, i2, i3], {
      history: {
        [i1.id]: [
          historyShape('h2', '2025-05-03T00:00:00.000Z', 'In Progress', 'Done', jake),
          historyShape('h1', '2025-03-10T08:00:00.000Z', 'Todo', 'In Progress', adaInLinear()),
          historyShape('h0', '2025-03-04T09:00:00.000Z', null, null, adaInLinear()), // not a state change
        ],
      },
    });
    const res = await sync();
    expect(res.statusCode, res.body).toBe(201);
    report = res.json();
    expect(report.numbering).toEqual([{ key: 'ISSUE', mode: 'linear_numbers', identifier_prefix: 'ISSUE' }]);

    const { db, list } = await issuesOf(ws);
    expect(list.map((r) => r.number).sort()).toEqual([5201, 5202, 5204]);
    expect(list.find((r) => r.number === 5201)!.identifier).toBe('ISSUE-5201');
    const byIdent = await adm('GET', `/workspaces/${ws}/records/by-identifier/ISSUE-5204`);
    expect(byIdent.statusCode, byIdent.body).toBe(200);
    // the counter was raised to the highest imported number, so the next record continues after it
    const created = await adm('POST', `/workspaces/${ws}/databases/${db.id}/records`, { values: { name: 'Made in StoryOS' } });
    expect(created.json().number).toBe(5205);
  });

  it('the record\'s own dates are Linear\'s, not the day of the import; started, completed and due are kept', async () => {
    const { byTitle } = await issuesOf(ws);
    const r = byTitle('Issue 5201');
    expect(r.created_at).toBe('2025-03-04T09:00:00.000Z');
    expect(r.updated_at).toBe('2025-06-01T12:30:00.000Z');
    expect(r.values['started']).toBe('2025-03-10');
    expect(r.values['completed']).toBe('2025-05-03');
    expect(r.values['due_date']).toBe('2025-07-01');
    const r3 = byTitle('Issue 5204');
    expect(r3.created_at, 'a late-evening UTC time keeps its own instant').toBe('2024-11-30T23:59:59.000Z');
    expect(r3.updated_at).toBe('2025-01-02T00:00:00.000Z');
    expect(byTitle('Issue 5202').values['due_date'] ?? null, 'no due date in Linear is no due date here').toBeNull();
    expect(report.dates_stamped).toBe(3);
  });

  it('the status timeline is Linear\'s: real times, source import, the actor as a member when the email matches', async () => {
    const { db, byTitle } = await issuesOf(ws);
    const r = byTitle('Issue 5201');
    const state = await rows(sql`select id from fields where database_id = ${db.id} and api_name = 'state'`);
    const changes = await rows(sql`select actor_user_id, source, old_value, new_value, created_at from record_field_changes where record_id = ${r.id} and field_id = ${state[0]!.id as string} and source = 'import' order by created_at`);
    expect(changes.map((c) => new Date(c.created_at as string).toISOString())).toEqual(['2025-03-10T08:00:00.000Z', '2025-05-03T00:00:00.000Z']);
    expect(changes[0]!.actor_user_id, 'matched by email, case-insensitively').toBe(ada.id);
    expect(changes[1]!.actor_user_id, 'Jake is not a member: no actor is invented').toBeNull();
    expect(changes.every((c) => c.source === 'import')).toBe(true);
    expect(report.history).toMatchObject({ kept: true, issues: 3, rows: 2, skipped_unknown_state: 0 });
    // the same timeline is what the history route reads
    const api = await adm('GET', `/workspaces/${ws}/databases/${db.id}/records/${r.id}/versions/changes`);
    expect(api.statusCode, api.body).toBe(200);
  });

  it('an assignee is the member with that email; one that matches nobody is kept by name and listed, never dropped', async () => {
    const { byTitle } = await issuesOf(ws);
    expect(byTitle('Issue 5201').values['assignee']).toBe(ada.id);
    expect(byTitle('Issue 5201').values['assignee_name'] ?? null).toBeNull();
    expect(byTitle('Issue 5202').values['assignee'] ?? null).toBeNull();
    expect(byTitle('Issue 5202').values['assignee_name']).toBe('Jake Alim');
    expect(byTitle('Issue 5204').values['assignee'] ?? null).toBeNull();
    expect(report.members.assignees).toMatchObject({ linear_people: 2, matched: 1, unmatched_total: 1 });
    expect(report.members.assignees.unmatched).toEqual([{ email: 'jake@elsewhere.test', name: 'Jake Alim', count: 1 }]);
  });

  it('a second run changes nothing: same numbers, same imported history, no duplicate rows', async () => {
    const before = await issuesOf(ws);
    const hist = async () => Number((await rows(sql`select count(*)::int as n from record_field_changes where database_id = ${before.db.id} and source = 'import'`))[0]!.n);
    const n = await hist();
    const res = await sync();
    expect(res.statusCode, res.body).toBe(201);
    const after = await issuesOf(ws);
    expect(after.list.map((r) => [r.number, r.created_at]).sort()).toEqual(before.list.map((r) => [r.number, r.created_at]).sort());
    expect(await hist(), 'replaced as a set, not appended to').toBe(n);
  });

  it('what a person wrote in the history is untouched when the imported history is replaced', async () => {
    const { db, byTitle } = await issuesOf(ws);
    const r = byTitle('Issue 5201');
    const state = (await rows(sql`select id from fields where database_id = ${db.id} and api_name = 'state'`))[0]!.id as string;
    await rawDb.execute(sql`insert into record_field_changes (workspace_id, database_id, record_id, field_id, source, old_value, new_value) select d.workspace_id, r.database_id, r.id, ${state}, 'human', '"x"'::jsonb, '"y"'::jsonb from records r join databases d on d.id = r.database_id where r.id = ${r.id}`);
    await sync();
    const human = await rows(sql`select count(*)::int as n from record_field_changes where record_id = ${r.id} and source = 'human' and field_id = ${state}`);
    expect(human[0]!.n).toBe(1);
  });

  it('a plan that keeps no field history writes no imported history, and the report says so', async () => {
    const spy = vi.spyOn(app.get(ImportHistoryService), 'keepsFieldHistory').mockResolvedValue(false);
    try {
      const { db } = await issuesOf(ws);
      const before = Number((await rows(sql`select count(*)::int as n from record_field_changes where database_id = ${db.id} and source = 'import'`))[0]!.n);
      const res = await sync();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().history).toMatchObject({ kept: false, rows: 0 });
      expect(Number((await rows(sql`select count(*)::int as n from record_field_changes where database_id = ${db.id} and source = 'import'`))[0]!.n), 'nothing added or removed').toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('comment authors become members, without duplicating a comment', () => {
  let ws2: string;
  let issuesDbId: string;
  const i1 = issueShape({ key: 'ISSUE' }, 1);
  const commentsOnIssue = async () => {
    const recs = (await adm('GET', `/workspaces/${ws2}/databases/${issuesDbId}/records?limit=10`)).json().data as Array<{ id: string; title: string }>;
    return (await adm('GET', `/workspaces/${ws2}/databases/${issuesDbId}/records/${recs.find((r) => r.title === 'Issue 1')!.id}/comments`)).json().data as Array<{ id: string; author_id?: string; user_id?: string; body: { doc: unknown[] } }>;
  };
  const authorOf = (c: { author_id?: string; user_id?: string; author?: { id: string } }) => c.author_id ?? c.user_id ?? c.author?.id;
  let late: Person;

  it('beforeAll: a workspace where Linear\'s commenter is not a member yet', async () => {
    ws2 = (await adm('POST', '/workspaces', { name: 'Authors WS' })).json().id;
    late = await signUpUser(app, 'Late Joiner').then(async (u) => ({ ...u, id: (await as(u.token, 'GET', '/me')).json().id }));
    await adm('POST', `/workspaces/${ws2}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] });
    use([i1], { comments: [commentShape(1, i1.id, { id: 'lin-late', name: 'Late Joiner', email: late.email }), commentShape(2, i1.id, { name: 'Bot-ish' }, { user: null, botActor: { name: 'GitHub' } })] });
    // this workspace's own `ws` variable drives sync(): point it here for this block
    const res = await adm('POST', `/workspaces/${ws2}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    issuesDbId = ((await adm('GET', `/workspaces/${ws2}/databases`)).json() as Array<{ id: string; name: string }>).find((d) => d.name === 'Issues')!.id;
    const cs = await commentsOnIssue();
    expect(cs).toHaveLength(2);
    expect(cs.map((c) => authorOf(c)).every((a) => a !== late.id), 'not a member yet: authored by the sync account').toBe(true);
    expect(JSON.stringify(cs.map((c) => c.body.doc))).toContain('Late Joiner · ');
    expect(res.json().members.comment_authors).toMatchObject({ matched: 0, unmatched_total: 1 }); // the bot has no email and is not a person
  });

  it('once they join, the next run RE-AUTHORS the comment as them: same comment, not a second one', async () => {
    const inv = await adm('POST', `/workspaces/${ws2}/invites`, { email: late.email, role: 'member' });
    const ok = await as(late.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    expect(ok.statusCode).toBe(201);
    const before = await commentsOnIssue();
    const res = await adm('POST', `/workspaces/${ws2}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comments_reauthored).toBe(1);
    expect(res.json().comments).toMatchObject({ created: 0, already_present: 2 });
    const after = await commentsOnIssue();
    expect(after, 'no duplicate').toHaveLength(before.length);
    expect(after.map((c) => authorOf(c)).filter((a) => a === late.id)).toHaveLength(1);
    const again = await adm('POST', `/workspaces/${ws2}/integrations/linear/sync`);
    expect(again.json().comments_reauthored, 'and a third run has nothing left to change').toBe(0);
  });
});

describe('a mirror numbered in import order is never renumbered, never given a wrong identifier', () => {
  let ws3: string;
  it('the first run numbers by Linear; after the numbers are scrambled (an old-style mirror) the next run keeps them, warns, and adds no prefix', async () => {
    ws3 = (await adm('POST', '/workspaces', { name: 'Legacy WS' })).json().id;
    await adm('POST', `/workspaces/${ws3}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] });
    use([issueShape(TEAM, 40), issueShape(TEAM, 41)]);
    expect((await adm('POST', `/workspaces/${ws3}/integrations/linear/sync`)).statusCode).toBe(201);
    const { db } = await issuesOf(ws3);
    // an import-order mirror: numbers 1.., and no prefix
    await rawDb.execute(sql`update records set number = number - 39 where database_id = ${db.id}`);
    await rawDb.execute(sql`update databases set identifier_prefix = null where id = ${db.id}`);
    const res = await adm('POST', `/workspaces/${ws3}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().numbering[0]).toMatchObject({ key: 'ISSUE', mode: 'import_order', identifier_prefix: null });
    expect(res.json().warnings.join(' ')).toMatch(/2 already-imported issues of team ISSUE are numbered in import order/);
    const after = await issuesOf(ws3);
    expect(after.list.map((r) => r.number).sort()).toEqual([1, 2]);
    expect(after.list.every((r) => r.identifier === null), 'no identifier is better than ISSUE-1 for the issue Linear calls ISSUE-40').toBe(true);
    // dates still come over on this mirror
    expect(after.byTitle('Issue 40').created_at).toBe('2025-03-04T09:00:00.000Z');
  });
});

describe('the prefix and the numbers refuse to take anything over', () => {
  it('a prefix another database already holds is not taken: the warning names it, the numbers are still Linear\'s', async () => {
    const wsP = (await adm('POST', '/workspaces', { name: 'Prefix WS' })).json().id;
    const spaceId = ((await adm('GET', `/workspaces/${wsP}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const holder = (await adm('POST', `/workspaces/${wsP}/databases`, { space_id: spaceId, name: 'Tickets (old)' })).json();
    expect((await adm('PATCH', `/workspaces/${wsP}/databases/${holder.id}`, { identifier_prefix: 'ISSUE' })).statusCode).toBe(200);
    await adm('POST', `/workspaces/${wsP}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] });
    use([issueShape(TEAM, 9)]);
    const res = await adm('POST', `/workspaces/${wsP}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().numbering[0]).toMatchObject({ mode: 'linear_numbers', identifier_prefix: null });
    expect(res.json().warnings.join(' ')).toMatch(/identifier prefix ISSUE was not set.*Tickets \(old\)/);
    const { list } = await issuesOf(wsP);
    expect(list[0]!.number).toBe(9);
    expect(list[0]!.identifier, 'no prefix on this database').toBeNull();
    // the holder keeps it
    expect((await adm('GET', `/workspaces/${wsP}/databases/${holder.id}`)).json().identifierPrefix).toBe('ISSUE');
  });

  it('a number a hand-made record already holds refuses the run, names the holder, and overwrites nothing', async () => {
    const wsN = (await adm('POST', '/workspaces', { name: 'Clash WS' })).json().id;
    await adm('POST', `/workspaces/${wsN}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] });
    use([issueShape(TEAM, 1), issueShape(TEAM, 2)]);
    expect((await adm('POST', `/workspaces/${wsN}/integrations/linear/sync`)).statusCode).toBe(201);
    const { db } = await issuesOf(wsN);
    const hand = await adm('POST', `/workspaces/${wsN}/databases/${db.id}/records`, { values: { name: 'Hand-made' } });
    expect(hand.json().number).toBe(3);
    // Linear now has an issue that is number 3
    use([issueShape(TEAM, 1), issueShape(TEAM, 2), issueShape(TEAM, 3)]);
    const res = await adm('POST', `/workspaces/${wsN}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.body).toMatch(/team ISSUE:/);
    expect(res.body).toMatch(/Hand-made|number 3|holder/i);
    const after = await issuesOf(wsN);
    expect(after.byTitle('Hand-made').number, 'the hand-made record is untouched').toBe(3);
    expect(after.list.filter((r) => r.number === 3)).toHaveLength(1);
  });
});

describe('an incremental run never numbers a new issue by Linear into an import-order mirror', () => {
  it('the new issue gets the next number in sequence and the database gets no prefix: the unchanged records are not even read, yet still decide', async () => {
    const wsI = (await adm('POST', '/workspaces', { name: 'Incremental Numbering WS' })).json().id;
    await adm('POST', `/workspaces/${wsI}/integrations/linear`, { api_key: 'lin_api_test', import_options: { scope: 'all', include_history: true }, team_keys: ['ISSUE'] });
    expect((await adm('POST', `/workspaces/${wsI}/integrations/linear`, { auto_sync: { enabled: true } })).statusCode).toBe(201);
    const OLD = '2020-01-01T00:00:00.000Z';
    use([issueShape(TEAM, 40, { updatedAt: OLD }), issueShape(TEAM, 41, { updatedAt: OLD })]);
    await linear.tick();
    const { db } = await issuesOf(wsI);
    await rawDb.execute(sql`update records set number = number - 39 where database_id = ${db.id}`);
    await rawDb.execute(sql`update databases set identifier_prefix = null where id = ${db.id}`);

    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    use([issueShape(TEAM, 40, { updatedAt: OLD }), issueShape(TEAM, 41, { updatedAt: OLD }), issueShape(TEAM, 9000, { updatedAt: soon })]);
    await linear.tick(new Date(Date.now() + 2 * 3_600_000));
    const status = (await adm('GET', `/workspaces/${wsI}/integrations/linear`)).json().sync;
    expect(status.last_error, 'the run did not fail').toBeNull();
    expect(status.last_run).toMatchObject({ mode: 'incremental' });
    const after = await issuesOf(wsI);
    const added = after.byTitle('Issue 9000');
    expect(added, 'the new issue arrived').toBeTruthy();
    expect(added.number, 'the counter\'s next number (it was raised to 41 by the first run), not Linear\'s 9000').toBe(42);
    expect(added.identifier).toBeNull();
  });
});
