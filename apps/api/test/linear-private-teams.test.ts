import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { connectTestDb } from './helpers/db';
import { makeLinearFetcher } from './helpers/linear-fake';
import { issueShape, WORKFLOW_STATES } from './fixtures/linear-documented-shapes';
import { LinearService } from '../src/integrations/linear.service';
import { ExternalIdUpsertService } from '../src/migration-framework/external-id-upsert.service';

/**
 * Ticket #1367 — every team can be imported, and a PRIVATE team lands in a RESTRICTED space that is closed before the first record is
 * written, opened only to the team's own members (matched by email), and refused outright where private teams are not switched on.
 *
 * Linear's side is a documented-shape fixture (Team.private, Team.members), not a live capture. Every access case has a plain MEMBER
 * without a grant AND a GUEST beside the admin, because a restriction test without them proves nothing.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const PUB = { id: 'team-pub', key: 'WEB', name: 'Web' };
const PRV = { id: 'team-prv', key: 'KYIV', name: 'Kyiv' };

const { db: rawDb } = connectTestDb();
let app: NestFastifyApplication;
let linear: LinearService;
let owner: { token: string };
const as = (token: string, method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const adm = (method: string, url: string, payload?: unknown) => as(owner.token, method, url, payload);
const rows = async (q: ReturnType<typeof sql>) => (await rawDb.execute(q)).rows as Array<Record<string, unknown>>;

const teamData = (issues: unknown[], members?: unknown[]) => ({ ...empty, issues: { nodes: issues as never }, states: WORKFLOW_STATES, members: members as never });
const use = (teams: Array<{ team: { id: string; key: string; name: string }; private?: boolean; issues: unknown[]; members?: unknown[] }>) => {
  linear.fetcher = makeLinearFetcher(teams.map((t) => ({ ...t.team, private: t.private, data: teamData(t.issues, t.members) }))).fetcher;
};
async function newWorkspace(name: string, keys: string[]) {
  const ws = (await adm('POST', '/workspaces', { name })).json().id as string;
  expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: keys })).statusCode).toBe(201);
  return ws;
}
const sync = (ws: string) => adm('POST', `/workspaces/${ws}/integrations/linear/sync`);
const spacesRows = (ws: string) => rows(sql`select id, name, restricted from spaces where workspace_id = ${ws} and deleted_at is null and personal = false order by name`);

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  owner = await signUpUser(app, 'Teams Owner');
}, 240_000);
afterAll(async () => { await app.close(); });

describe('private teams are off until an admin switches them on', () => {
  it('a sync that includes a private team is refused before anything is read or written, naming the team', async () => {
    const ws = await newWorkspace('Private Off WS', ['WEB', 'KYIV']);
    use([{ team: PUB, issues: [issueShape(PUB, 1)] }, { team: PRV, private: true, issues: [issueShape(PRV, 1)] }]);
    const before = (await spacesRows(ws)).length;
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/Linear team KYIV is private, and importing private teams is switched off/);
    expect((await spacesRows(ws)).length, 'not even the public team was written').toBe(before);
    expect((await adm('GET', `/workspaces/${ws}/integrations/linear`)).json().allow_private_teams).toBe(false);
  });

  it('the preview says which chosen teams are private and that a sync would not import them', async () => {
    const ws = await newWorkspace('Private Preview WS', ['WEB', 'KYIV']);
    use([{ team: PUB, issues: [issueShape(PUB, 1)] }, { team: PRV, private: true, issues: [issueShape(PRV, 1)] }]);
    const res = await adm('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().private_teams).toEqual([{ key: 'KYIV', would_import: false }]);
  });

  it('a chosen team key the API key cannot see is reported, not silently skipped', async () => {
    const ws = await newWorkspace('Not Visible WS', ['WEB', 'MAN']);
    use([{ team: PUB, issues: [issueShape(PUB, 1)] }]);
    const dry = await adm('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(dry.json().teams_not_visible).toEqual(['MAN']);
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().teams_not_visible).toEqual(['MAN']);
    expect(res.json().warnings.join(' ')).toMatch(/not visible to this Linear API key.*MAN/);
  });
});

describe('a private team lands in a restricted space', () => {
  let ws: string;
  let kate: Person; // a member, in the team in Linear, same email
  let bob: Person; // a member NOT in the team
  let dave: Person; // a guest (partial access)
  let report: Record<string, any>;
  let space: string;
  let issuesDb: string;
  let rec: string;
  const observed: Array<{ database: string; restricted: boolean }> = [];

  beforeAll(async () => {
    ws = await newWorkspace('Private On WS', ['WEB', 'KYIV']);
    kate = await joinAs(app, owner.token, ws, 'Kate Team', 'member');
    bob = await joinAs(app, owner.token, ws, 'Bob Outsider', 'member');
    const openSpace = ((await adm('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    dave = await joinAs(app, owner.token, ws, 'Dave Guest', 'guest', [{ space_id: openSpace, role: 'editor' }]);
    expect((await adm('POST', `/workspaces/${ws}/integrations/linear`, { allow_private_teams: true })).statusCode).toBe(201);
    use([
      { team: PUB, issues: [issueShape(PUB, 1, { title: 'Public web issue' })] },
      {
        team: PRV, private: true, issues: [issueShape(PRV, 7, { title: 'Kyiv payroll secret' })],
        members: [{ id: 'm1', name: 'Kate Team', email: kate.email.toUpperCase() }, { id: 'm2', name: 'Outsider', email: 'nobody@elsewhere.test' }, { id: 'm3', name: 'Gone', email: bob.email, active: false }],
      },
    ]);
    // Record, at every write, whether the space the write lands in is ALREADY restricted: a space created open and flipped later fails here.
    const svc = app.get(ExternalIdUpsertService);
    const orig = svc.upsert.bind(svc);
    const spy = vi.spyOn(svc, 'upsert').mockImplementation(async (...args) => {
      const r = await rows(sql`select s.restricted, s.name from databases d join spaces s on s.id = d.space_id where d.id = ${args[1]}`);
      observed.push({ database: String(r[0]!.name), restricted: r[0]!.restricted as boolean });
      return orig(...args);
    });
    try {
      const res = await sync(ws);
      expect(res.statusCode, res.body).toBe(201);
      report = res.json();
    } finally {
      spy.mockRestore();
    }
    const kyiv = (await spacesRows(ws)).find((s) => s.name === 'Kyiv (Linear)')!;
    space = kyiv.id as string;
    issuesDb = ((await rows(sql`select id from databases where space_id = ${space} and name = 'Issues'`))[0]!.id) as string;
    rec = ((await rows(sql`select id from records where database_id = ${issuesDb} limit 1`))[0]!.id) as string;
  }, 240_000);

  it('the space was restricted before a single record was written into it', () => {
    expect(observed.filter((o) => o.database === 'Kyiv (Linear)').length, 'some writes landed in it').toBeGreaterThan(0);
    expect(observed.filter((o) => o.database === 'Kyiv (Linear)').every((o) => o.restricted), 'every one of them into an already-restricted space').toBe(true);
    expect(observed.filter((o) => o.database === 'Web (Linear)').every((o) => !o.restricted), 'the public team\'s space is open').toBe(true);
  });

  it('the report lists who was let in and who could not be matched, and the team\'s members are granted editor on the space', async () => {
    expect(report.private_teams).toEqual([{ key: 'KYIV', space_id: space, granted: 1, unmatched_total: 1, unmatched: [{ name: 'Outsider', email: 'nobody@elsewhere.test' }] }]);
    const grants = await rows(sql`select user_id, role from access_grants where space_id = ${space}`);
    expect(grants).toEqual([{ user_id: kate.id, role: 'editor' }]);
  });

  it('the admin and the matched member see the team; a member without a grant and a guest see nothing, by body', async () => {
    expect((await adm('GET', `/workspaces/${ws}/databases/${issuesDb}/records/${rec}`)).statusCode).toBe(200);
    expect((await as(kate.token, 'GET', `/workspaces/${ws}/databases/${issuesDb}/records/${rec}`)).statusCode, 'matched by email, case-insensitively').toBe(200);
    for (const [who, p] of [['member without a grant', bob], ['guest', dave]] as const) {
      const the = (method: string, url: string, payload?: unknown) => as(p.token, method, url, payload);
      expect((await the('GET', `/workspaces/${ws}/databases/${issuesDb}`)).statusCode, `${who}: the database`).toBe(404);
      expect((await the('GET', `/workspaces/${ws}/databases/${issuesDb}/records?limit=5`)).statusCode, `${who}: the list`).toBe(404);
      expect((await the('GET', `/workspaces/${ws}/databases/${issuesDb}/records/${rec}`)).statusCode, `${who}: the record`).toBe(404);
      expect((await the('POST', `/workspaces/${ws}/databases/${issuesDb}/records/aggregate`, { op: 'count' })).statusCode, `${who}: the count`).toBe(404);
      const search = await the('GET', `/workspaces/${ws}/search?q=payroll`);
      expect(JSON.stringify(search.json()), `${who}: search`).not.toContain('Kyiv payroll secret');
      expect(JSON.stringify((await the('GET', `/workspaces/${ws}/spaces`)).json()), `${who}: the space list`).not.toContain('Kyiv');
      expect(JSON.stringify((await the('GET', `/workspaces/${ws}/databases`)).json()), `${who}: the database list`).not.toContain('Kyiv');
    }
  });

  it('a run again keeps it closed and adds no second grant', async () => {
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().private_teams[0]).toMatchObject({ granted: 0 });
    expect((await spacesRows(ws)).find((s) => s.id === space)!.restricted).toBe(true);
  });
});

describe('a team that turns private is closed first, and a sync never opens it again', () => {
  it('an existing OPEN space is restricted before anything is written; going public again leaves it closed', async () => {
    const ws = await newWorkspace('Goes Private WS', ['KYIV']);
    use([{ team: PRV, private: false, issues: [issueShape(PRV, 1)] }]);
    expect((await sync(ws)).statusCode).toBe(201);
    expect((await spacesRows(ws)).find((s) => s.name === 'Kyiv (Linear)')!.restricted).toBe(false);

    await adm('POST', `/workspaces/${ws}/integrations/linear`, { allow_private_teams: true });
    use([{ team: PRV, private: true, issues: [issueShape(PRV, 1), issueShape(PRV, 2)], members: [] }]);
    const res = await sync(ws);
    expect(res.statusCode, res.body).toBe(201);
    expect((await spacesRows(ws)).find((s) => s.name === 'Kyiv (Linear)')!.restricted).toBe(true);
    expect(res.json().warnings.join(' ')).toMatch(/team KYIV is private in Linear: its space "Kyiv \(Linear\)" was open and is now restricted/);

    use([{ team: PRV, private: false, issues: [issueShape(PRV, 1), issueShape(PRV, 2)] }]);
    expect((await sync(ws)).statusCode).toBe(201);
    expect((await spacesRows(ws)).find((s) => s.name === 'Kyiv (Linear)')!.restricted, 'never auto-opened').toBe(true);
  });
});

describe('a team\'s space is found by id, not by its display name', () => {
  it('the name override names a NEW space; renaming it later does not lose it or make a second one', async () => {
    const ws = await newWorkspace('Space Override WS', ['WEB']);
    const set = await adm('POST', `/workspaces/${ws}/integrations/linear`, { team_spaces: { WEB: { space_name: 'Engineering' } } });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.json().team_spaces).toEqual({ WEB: { space_name: 'Engineering' } });
    use([{ team: PUB, issues: [issueShape(PUB, 1)] }]);
    expect((await sync(ws)).statusCode).toBe(201);
    const first = await spacesRows(ws);
    const eng = first.find((s) => s.name === 'Engineering')!;
    expect(eng, 'created under the override, not "Web (Linear)"').toBeTruthy();
    expect(first.find((s) => s.name === 'Web (Linear)')).toBeUndefined();
    expect((await adm('GET', `/workspaces/${ws}/integrations/linear`)).json().team_spaces.WEB.space_id, 'the id is remembered').toBe(eng.id);

    expect((await adm('PATCH', `/workspaces/${ws}/spaces/${eng.id}`, { name: 'Product Engineering' })).statusCode).toBe(200);
    expect((await sync(ws)).statusCode).toBe(201);
    const after = await spacesRows(ws);
    expect(after.map((s) => s.name), 'renamed, and no second space appeared').toEqual(expect.arrayContaining(['Product Engineering']));
    expect(after.filter((s) => s.name === 'Engineering' || s.name === 'Web (Linear)')).toHaveLength(0);
    expect(Number((await rows(sql`select count(*)::int as n from databases where space_id = ${eng.id} and name = 'Issues' and deleted_at is null`))[0]!.n)).toBe(1);
  });

  it('an existing mirror (found by the default name) gets its id remembered on the next run', async () => {
    const ws = await newWorkspace('Legacy Name WS', ['WEB']);
    use([{ team: PUB, issues: [issueShape(PUB, 1)] }]);
    expect((await sync(ws)).statusCode).toBe(201);
    expect((await adm('GET', `/workspaces/${ws}/integrations/linear`)).json().team_spaces.WEB.space_id).toBeTruthy();
  });

  it('a space id from another workspace is refused when saved: a pasted id must not point the sync elsewhere', async () => {
    const ws = await newWorkspace('Space Guard WS', ['WEB']);
    const other = (await adm('POST', '/workspaces', { name: 'Elsewhere' })).json().id;
    const foreign = ((await adm('GET', `/workspaces/${other}/spaces`)).json() as Array<{ id: string }>)[0]!.id;
    const res = await adm('POST', `/workspaces/${ws}/integrations/linear`, { team_spaces: { WEB: { space_id: foreign } } });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.body).toMatch(/team_spaces\.WEB\.space_id is not a space of this workspace/);
  });
});
