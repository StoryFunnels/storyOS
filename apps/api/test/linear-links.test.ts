import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService } from '../src/integrations/linear.service';

/**
 * #1103 — Linear owns an issue's labels, cycle, project and parent ("each sync overwrites them", ticket #901). The
 * importer used to ADD links only, so a label dropped in Linear, or a cycle/project changed there, stayed linked in the
 * mirror. A one-to-many link (cycle, project, parent) was worse: the second link was refused as a conflict and the
 * refusal was swallowed into a warning, so the OLD one stayed.
 *
 * Every assertion reads the link set back from the API. The unchanged-issue case asserts that NO link event is written.
 */
const HOUR = 3_600_000;
const TEAM = { id: 'team-lk', key: 'LK', name: 'Links' };
const bug = { id: 'lab-bug', name: 'Bug', color: '#f00' };
const ui = { id: 'lab-ui', name: 'UI', color: '#0f0' };
const cyc = (n: number) => ({ id: `cyc-${n}`, name: `Cycle ${n}`, number: n, startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-14T00:00:00Z' });
const prj = (n: number) => ({ id: `prj-${n}`, name: `Project ${n}`, description: null, state: 'started', targetDate: null, url: `https://linear.app/acme/project/p${n}` });
const catalog = { labels: { nodes: [bug, ui] as unknown[] }, cycles: { nodes: [cyc(1), cyc(2)] as unknown[] }, projects: { nodes: [prj(1), prj(2)] as unknown[] } };
const OLD = '2020-01-01T00:00:00.000Z';
const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  ...manyIssues(1)[0]!, id: `i${n}`, identifier: `LK-${n}`, title: `Issue ${n}`, updatedAt: OLD, ...extra,
});

let app: NestFastifyApplication;
let linear: LinearService;
let db: Db;
let admin: { token: string };
let ws: string;
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const use = (issues: Array<Record<string, unknown>>) => {
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...catalog, issues: { nodes: issues } } }]).fetcher;
};
const issuesDb = async () => (await inject('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === 'Issues');
const recordId = async (title: string) => {
  const d = await issuesDb();
  const rows = (await inject('GET', `/workspaces/${ws}/databases/${d.id}/records?limit=50`)).json().data as Array<{ id: string; title: string }>;
  return rows.find((r) => r.title === title)!.id;
};
/** The titles linked from an issue on one relation field, read through the links endpoint. */
const links = async (title: string, apiName: string) => {
  const d = await issuesDb();
  const full = (await inject('GET', `/workspaces/${ws}/databases/${d.id}`)).json();
  const field = (full.fields as Array<{ id: string; apiName: string }>).find((f) => f.apiName === apiName)!;
  const res = await inject('GET', `/workspaces/${ws}/databases/${d.id}/records/${await recordId(title)}/links/${field.id}`);
  return (res.json().data as Array<{ title: string }>).map((r) => r.title).sort();
};
const linkEvents = async (title: string) => {
  const id = await recordId(title);
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM activity_events WHERE record_id = ${id} AND type IN ('relation.linked','relation.unlinked')`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0]!.n;
};
const syncNow = async () => {
  const res = await inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
};

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  db = app.get<Db>(DB);
  admin = await signUpUser(app, 'Linear Links');
  ws = (await inject('POST', '/workspaces', { name: 'Linear Links WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['LK'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#1103 a full sync makes the link set equal Linear\'s', () => {
  it('first sync links labels, cycle, project and parent', async () => {
    use([
      issue(1, { labels: { nodes: [bug, ui] }, cycle: { id: 'cyc-1' }, project: { id: 'prj-1' } }),
      issue(2, { labels: { nodes: [bug] }, parent: { id: 'i1' } }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    const s = await syncNow();
    expect(s.link_warnings ?? []).toEqual([]);
    expect(await links('Issue 1', 'labels')).toEqual(['Bug', 'UI']);
    expect(await links('Issue 1', 'sprint')).toEqual(['Cycle 1']);
    expect(await links('Issue 1', 'project')).toEqual(['Project 1']);
    expect(await links('Issue 2', 'parent_issue')).toEqual(['Issue 1']);
  });

  it('a label DROPPED in Linear is unlinked', async () => {
    use([
      issue(1, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' }, project: { id: 'prj-1' } }),
      issue(2, { labels: { nodes: [bug] }, parent: { id: 'i1' } }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 1', 'labels')).toEqual(['Bug']);
  });

  it('a CYCLE changed in Linear replaces the old one (it does not sit beside it, nor stay)', async () => {
    use([
      issue(1, { labels: { nodes: [bug] }, cycle: { id: 'cyc-2' }, project: { id: 'prj-1' } }),
      issue(2, { labels: { nodes: [bug] }, parent: { id: 'i1' } }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 1', 'sprint')).toEqual(['Cycle 2']);
  });

  it('a PROJECT changed in Linear replaces the old one', async () => {
    use([
      issue(1, { labels: { nodes: [bug] }, cycle: { id: 'cyc-2' }, project: { id: 'prj-2' } }),
      issue(2, { labels: { nodes: [bug] }, parent: { id: 'i1' } }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 1', 'project')).toEqual(['Project 2']);
  });

  it('a cycle, a project, a parent and every label REMOVED in Linear are all unlinked', async () => {
    use([
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: null }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 1', 'labels')).toEqual([]);
    expect(await links('Issue 1', 'sprint')).toEqual([]);
    expect(await links('Issue 1', 'project')).toEqual([]);
  });

  it('a PARENT removed in Linear is unlinked', async () => {
    use([
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: { id: 'i1' } }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 2', 'parent_issue')).toEqual(['Issue 1']);
    use([
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: null }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ]);
    await syncNow();
    expect(await links('Issue 2', 'parent_issue')).toEqual([]);
  });

  it('an issue whose links did NOT change gets no link writes on a re-sync (idempotent: no duplicates, no churn)', async () => {
    const same = [
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: null }),
      issue(3, { labels: { nodes: [bug] }, cycle: { id: 'cyc-1' } }),
    ];
    use(same);
    const before = [await linkEvents('Issue 1'), await linkEvents('Issue 2'), await linkEvents('Issue 3')];
    await syncNow();
    expect([await linkEvents('Issue 1'), await linkEvents('Issue 2'), await linkEvents('Issue 3')]).toEqual(before);
    expect(await links('Issue 3', 'labels')).toEqual(['Bug']);
    expect(await links('Issue 3', 'sprint')).toEqual(['Cycle 1']);
  });

  it('a link added in StoryOS on a relation StoryOS owns is never removed by a sync', async () => {
    const d = await issuesDb();
    const notes = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: d.space_id ?? d.spaceId, name: 'Notes' })).json();
    expect(notes.id, JSON.stringify(notes)).toBeTruthy();
    const rel = await inject('POST', `/workspaces/${ws}/relations`, { database_a_id: d.id, database_b_id: notes.id, cardinality: 'many_to_many', field_a_name: 'Notes', field_b_name: 'Issues' });
    expect(rel.statusCode, rel.body).toBe(201);
    const note = (await inject('POST', `/workspaces/${ws}/databases/${notes.id}/records`, { values: { name: 'Keep me' } })).json();
    const full = (await inject('GET', `/workspaces/${ws}/databases/${d.id}`)).json();
    const field = (full.fields as Array<{ id: string; apiName: string }>).find((f) => f.apiName === 'notes')!;
    const add = await inject('POST', `/workspaces/${ws}/databases/${d.id}/records/${await recordId('Issue 3')}/links/${field.id}`, { record_ids: [note.id] });
    expect(add.statusCode, add.body).toBeLessThan(300);
    use([
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: null }),
      issue(3, { labels: { nodes: [ui] }, cycle: { id: 'cyc-2' } }),
    ]);
    await syncNow();
    expect(await links('Issue 3', 'notes')).toEqual(['Keep me']);
    expect(await links('Issue 3', 'labels')).toEqual(['UI']);
    expect(await links('Issue 3', 'sprint')).toEqual(['Cycle 2']);
  });

  it('a cycle Linear names that was never imported leaves the existing link alone (unplaceable is not the same as none)', async () => {
    use([
      issue(1, { labels: { nodes: [] }, cycle: null, project: null }),
      issue(2, { labels: { nodes: [bug] }, parent: null }),
      issue(3, { labels: { nodes: [ui] }, cycle: { id: 'cyc-unknown' } }),
    ]);
    await syncNow();
    expect(await links('Issue 3', 'sprint')).toEqual(['Cycle 2']);
  });
});

describe('#1103 an INCREMENTAL run does the same for an issue Linear changed', () => {
  const INC = { id: 'team-lk2', key: 'L2', name: 'Links Inc' };
  let ws2: string;
  const inject2 = (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
  const use2 = (issues: Array<Record<string, unknown>>) => {
    linear.fetcher = makeLinearFetcher([{ ...INC, data: { ...catalog, issues: { nodes: issues } } }]).fetcher;
  };
  const links2 = async (title: string, apiName: string) => {
    const dbs = (await inject2('GET', `/workspaces/${ws2}/databases`)).json();
    const d = dbs.find((x: { name: string }) => x.name === 'Issues');
    const full = (await inject2('GET', `/workspaces/${ws2}/databases/${d.id}`)).json();
    const field = (full.fields as Array<{ id: string; apiName: string }>).find((f) => f.apiName === apiName)!;
    const rows = (await inject2('GET', `/workspaces/${ws2}/databases/${d.id}/records?limit=50`)).json().data as Array<{ id: string; title: string }>;
    const res = await inject2('GET', `/workspaces/${ws2}/databases/${d.id}/records/${rows.find((r) => r.title === title)!.id}/links/${field.id}`);
    return (res.json().data as Array<{ title: string }>).map((r) => r.title).sort();
  };

  beforeAll(async () => {
    ws2 = (await inject2('POST', '/workspaces', { name: 'Linear Links Inc WS' })).json().id;
    expect((await inject2('POST', `/workspaces/${ws2}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['L2'] })).statusCode).toBe(201);
    expect((await inject2('POST', `/workspaces/${ws2}/integrations/linear`, { auto_sync: { enabled: true } })).statusCode).toBe(201);
  }, 60_000);

  it('a label dropped and a cycle and project changed, seen only by an incremental read, are mirrored', async () => {
    use2([issue(1, { labels: { nodes: [bug, ui] }, cycle: { id: 'cyc-1' }, project: { id: 'prj-1' } }), issue(2)]);
    await linear.tick();
    expect(await links2('Issue 1', 'labels')).toEqual(['Bug', 'UI']);

    const fresh = new Date(Date.now() + 5_000).toISOString();
    use2([issue(1, { labels: { nodes: [bug] }, cycle: { id: 'cyc-2' }, project: { id: 'prj-2' }, updatedAt: fresh }), issue(2)]);
    await linear.tick(new Date(Date.now() + 1.1 * HOUR));
    const last = (await inject2('GET', `/workspaces/${ws2}/integrations/linear`)).json().sync.last_run;
    expect(last).toMatchObject({ mode: 'incremental', issues: 1 });
    expect(await links2('Issue 1', 'labels')).toEqual(['Bug']);
    expect(await links2('Issue 1', 'sprint')).toEqual(['Cycle 2']);
    expect(await links2('Issue 1', 'project')).toEqual(['Project 2']);
  });
});
