import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { sql } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService, fetchTeamData } from '../src/integrations/linear.service';

/**
 * #904 — a Linear status survives the migration as ITSELF. The importer used to build State from a fixed list of seven
 * and map every other status by TYPE, so "Ready For Staging", "UAT Verified", "PR Merged" and "Deployed" (all
 * `completed`) would have read "Done" and the import would have reported success.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-sp', key: 'SP', name: 'StoryPages' };
const STATES = [
  { id: 's0', name: 'Backlog', type: 'backlog', position: 0 },
  { id: 's1', name: 'In Progress', type: 'started', position: 1 },
  { id: 's2', name: 'For UAT On Staging', type: 'started', position: 2 },
  { id: 's3', name: 'PR Merged', type: 'completed', position: 3 },
  { id: 's4', name: 'Ready For Staging', type: 'completed', position: 4 },
  { id: 's5', name: 'UAT Verified', type: 'completed', position: 5 },
  { id: 's6', name: 'Deployed', type: 'completed', position: 6 },
  { id: 's7', name: 'Canceled', type: 'canceled', position: 7 },
];
const issue = (n: number, status: string) => ({ ...manyIssues(1)[0]!, id: `i${n}`, identifier: `SP-${n}`, title: `Issue ${n}`, state: { name: status, type: STATES.find((s) => s.name === status)!.type } });

let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const use = (issues: Array<Record<string, unknown>>, states = STATES) => {
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: issues }, states } }]).fetcher;
};
async function issuesDb() {
  const dbs = (await inject('GET', `/workspaces/${ws}/databases`)).json();
  return dbs.find((d: { name: string }) => d.name === 'Issues');
}

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Linear Statuses');
  ws = (await inject('POST', '/workspaces', { name: 'Linear Status WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['SP'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#904 statuses are imported as themselves', () => {
  it('the preview counts issues per Linear status, in Linear\'s order, zero-count statuses included', async () => {
    use([issue(1, 'Ready For Staging'), issue(2, 'Deployed'), issue(3, 'Deployed'), issue(4, 'PR Merged')]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/dry-run`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().teams[0].issues_by_status).toEqual([
      { status: 'Backlog', type: 'backlog', issues: 0 }, { status: 'In Progress', type: 'started', issues: 0 },
      { status: 'For UAT On Staging', type: 'started', issues: 0 }, { status: 'PR Merged', type: 'completed', issues: 1 },
      { status: 'Ready For Staging', type: 'completed', issues: 1 }, { status: 'UAT Verified', type: 'completed', issues: 0 },
      { status: 'Deployed', type: 'completed', issues: 2 }, { status: 'Canceled', type: 'canceled', issues: 0 },
    ]);
  });

  it('builds State from the team\'s workflow states (named and ordered as in Linear), and each custom status imports distinctly', async () => {
    use([issue(1, 'Ready For Staging'), issue(2, 'Deployed'), issue(3, 'PR Merged'), issue(4, 'UAT Verified'), issue(5, 'For UAT On Staging')]);
    const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().fallback_mapped).toBe(0);
    const db = await issuesDb();
    const detail = (await inject('GET', `/workspaces/${ws}/databases/${db.id}`)).json();
    const stateField = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    expect(stateField.options.map((o: { label: string }) => o.label)).toEqual(STATES.map((s) => s.name));
    const list = (await inject('GET', `/workspaces/${ws}/databases/${db.id}/records?limit=50`)).json().data as Array<{ title: string; values: Record<string, unknown> }>;
    const labelOf = (id: unknown) => stateField.options.find((o: { id: string }) => o.id === id)?.label;
    const byTitle = (t: string) => list.find((r) => r.title === t)!;
    expect(labelOf(byTitle('Issue 1').values.state)).toBe('Ready For Staging');
    expect(labelOf(byTitle('Issue 2').values.state)).toBe('Deployed');
    expect(labelOf(byTitle('Issue 3').values.state)).toBe('PR Merged');
    expect(labelOf(byTitle('Issue 4').values.state)).toBe('UAT Verified');
    expect(labelOf(byTitle('Issue 5').values.state)).toBe('For UAT On Staging');
    // the original status name is ALSO kept as plain text
    expect(byTitle('Issue 1').values.linear_status).toBe('Ready For Staging');
    expect(byTitle('Issue 2').values.linear_status).toBe('Deployed');
  });

  it('a status outside the team\'s workflow states fails the read before anything is written, never mapped by type', async () => {
    const { fetcher } = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: [issue(1, 'Deployed')] }, states: STATES.filter((s) => s.name !== 'Deployed') } }]);
    await expect(fetchTeamData(fetcher, 'k', TEAM)).rejects.toThrow(/status "Deployed" which is not in its workflow states/);
  });
});

describe('#904 re-run over a database an earlier import built from the fixed list', () => {
  it('adds the missing options, keeps the old ones after them, adds Linear Status, and re-maps the collapsed issues', async () => {
    const ws2 = (await inject('POST', '/workspaces', { name: 'Old Import WS' })).json().id;
    await inject('POST', `/workspaces/${ws2}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['SP'] });
    const url = (p: string) => `/workspaces/${ws2}${p}`;
    // 1. build the database the OLD way: a team whose states are exactly the old fixed seven, and one Done issue
    const OLD = ['Triage', 'Backlog', 'To Do', 'In Progress', 'In Review', 'Done', 'Canceled'].map((name, i) => ({ id: `o${i}`, name, type: name === 'Done' ? 'completed' : name === 'Canceled' ? 'canceled' : 'started', position: i }));
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: [{ ...issue(1, 'Deployed'), state: { name: 'Done', type: 'completed' } }] }, states: OLD } }]).fetcher;
    expect((await inject('POST', url('/integrations/linear/sync'))).statusCode).toBe(201);
    const dbs = (await inject('GET', url('/databases'))).json();
    const db = dbs.find((d: { name: string }) => d.name === 'Issues');
    // simulate the earlier importer: no linear_status field yet
    // (hard delete: a soft-deleted field would keep the api name and make the re-created one `linear_status_2`)
    await (app.get(DB) as Db).execute(sql`delete from fields where database_id = ${db.id} and api_name = 'linear_status'`);
    // 2. the real states now: the issue is really "Deployed"
    linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: [issue(1, 'Deployed')] }, states: STATES } }]).fetcher;
    const res = await inject('POST', url('/integrations/linear/sync'));
    expect(res.statusCode, res.body).toBe(201);
    const after = (await inject('GET', url(`/databases/${db.id}`))).json();
    const stateField = after.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const labels = stateField.options.map((o: { label: string }) => o.label);
    expect(labels.slice(0, STATES.length), 'Linear\'s statuses first, in Linear\'s order').toEqual(STATES.map((s) => s.name));
    expect(labels, 'old options are kept, never deleted').toEqual(expect.arrayContaining(['To Do', 'In Review', 'Done']));
    expect(after.fields.some((f: { apiName: string }) => f.apiName === 'linear_status'), 'Linear Status added').toBe(true);
    const rec = (await inject('GET', url(`/databases/${db.id}/records?limit=10`))).json().data[0];
    expect(stateField.options.find((o: { id: string }) => o.id === rec.values.state).label, 're-mapped from Done to the real status').toBe('Deployed');
    expect(rec.values.linear_status).toBe('Deployed');
    expect((await inject('GET', url(`/databases/${db.id}/records?limit=10`))).json().data, 'no duplicate').toHaveLength(1);
  });
});
