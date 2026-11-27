import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import type { Person } from './helpers/members';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { memberships, workspaces } from '../src/db/schema';
import { GithubService } from '../src/integrations/github.service';
import { GithubAppService } from '../src/integrations/github-app.service';

/**
 * Ticket #1368 (absorbs #905) — a PR links to a record by its IDENTIFIER (`ISSUE-5201`), and the link database is a per-REPO setting.
 *
 * Fake data throughout (a Pinewood-style agency). Two repos share one workspace: `pinewood/site` links to the Issues database
 * (identifier prefix ISSUE) and `pinewood/pages` to the Pages database (prefix SP). Both databases hold records numbered 1..4, so a
 * bare number is deliberately ambiguous between them: that is what makes the isolation tests mean something.
 */
let app: NestFastifyApplication;
let dbh: Db;
let admin: { token: string; email: string };
let ws: string;
let space: string;
let issuesDb: string;
let pagesDb: string;
let notesDb: string;
let issues: Array<{ id: string; number: number }> = [];
let pages: Array<{ id: string; number: number }> = [];
let issuesState: { api: string; opts: Record<string, string> };
let pagesState: { api: string; opts: Record<string, string> };
let secret: string;

const SITE = 'pinewood/site';
const PAGES = 'pinewood/pages';
const STRANGER = 'pinewood/other';

const adm = (m: string, u: string, p?: unknown) => call(app, admin.token, m, u, p);
const id = async (m: string, u: string, p?: unknown) => {
  const r = await adm(m, u, p);
  if (r.statusCode >= 300) throw new Error(`fixture ${m} ${u}: ${r.statusCode} ${r.body}`);
  return r.json().id as string;
};
const sign = (body: string, key: string) => `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

let prCounter = 100;
function pr(repo: string, opts: { branch?: string; title?: string; body?: string; action?: string; merged?: boolean; number?: number }) {
  const number = opts.number ?? ++prCounter;
  const merged = opts.merged ?? false;
  const action = opts.action ?? 'opened';
  return {
    action,
    repository: { full_name: repo },
    pull_request: {
      number,
      title: opts.title ?? `Change ${number}`,
      state: action === 'closed' ? 'closed' : 'open',
      merged,
      merged_at: merged ? '2026-11-20T00:00:00Z' : null,
      draft: false,
      html_url: `https://github.com/${repo}/pull/${number}`,
      body: opts.body ?? null,
      user: { login: 'dana' },
      head: { ref: opts.branch ?? 'main-ish', sha: 'deadbeef' },
    },
  };
}
async function deliver(payload: unknown, key = secret) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/api/v1/integrations/github/webhook',
    headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body, key) },
    payload: body,
  });
}
const linked = async (repo: string, opts: Parameters<typeof pr>[1]) => {
  const res = await deliver(pr(repo, opts));
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { linked_record_id: string | null; state_applied: string | null };
};
const stateOf = async (database: string, record: string, api: string) =>
  ((await adm('GET', `/workspaces/${ws}/databases/${database}/records/${record}`)).json().values[api] ?? null) as string | null;
const saveGithub = (body: unknown, token = admin.token) => call(app, token, 'POST', `/workspaces/${ws}/integrations/github`, body);
const readGithub = (token = admin.token) => call(app, token, 'GET', `/workspaces/${ws}/integrations/github`);
const setPrefix = (database: string, prefix: string | null) => adm('PATCH', `/workspaces/${ws}/databases/${database}`, { identifier_prefix: prefix });

async function mkState(database: string) {
  const f = (
    await adm('POST', `/workspaces/${ws}/databases/${database}/fields`, {
      display_name: 'State',
      type: 'select',
      config: {},
      options: [{ label: 'Todo' }, { label: 'In Progress' }, { label: 'PR Merged' }],
    })
  ).json();
  return { api: f.apiName as string, opts: Object.fromEntries(f.options.map((o: { label: string; id: string }) => [o.label, o.id])) };
}
async function mkRecords(database: string, prefix: string) {
  const out: Array<{ id: string; number: number }> = [];
  for (let i = 1; i <= 4; i++) {
    const r = (await adm('POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name: `${prefix} work item ${i}` } })).json();
    out.push({ id: r.id, number: r.number });
  }
  return out;
}

beforeAll(async () => {
  app = await createTestApp();
  dbh = app.get(DB);
  app.get(GithubService).fetcher = async () => ({ state: 'pending' });
  admin = await signUpUser(app, 'Link Admin');
  ws = (await adm('POST', '/workspaces', { name: 'Pinewood Links' })).json().id;
  space = (await adm('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  issuesDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Issues' });
  pagesDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Pages work' });
  notesDb = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Notes' });
  expect((await setPrefix(issuesDb, 'ISSUE')).statusCode).toBe(200);
  expect((await setPrefix(pagesDb, 'SP')).statusCode).toBe(200);
  issuesState = await mkState(issuesDb);
  pagesState = await mkState(pagesDb);
  issues = await mkRecords(issuesDb, 'Issue');
  pages = await mkRecords(pagesDb, 'Page');
  expect(issues.map((r) => r.number)).toEqual([1, 2, 3, 4]);
  expect(pages.map((r) => r.number)).toEqual([1, 2, 3, 4]);
  secret = 'pinewood-links-secret-key-0001';
  // The pre-#1368 shape on purpose: ONE workspace-wide link database. The migration tests below move it to per-repo.
  const saved = await saveGithub({
    webhook_secret: secret,
    repos: [SITE, PAGES, STRANGER],
    link_database_id: issuesDb,
    state_automation: { opened: 'In Progress', merged: 'PR Merged' },
  });
  expect(saved.statusCode, saved.body).toBe(201);
}, 120_000);
afterAll(async () => {
  await app.close();
});

describe('legacy workspace-wide config keeps working unchanged (ticket #1368 AC c)', () => {
  it('story-N, a lane branch and "ticket #N" still resolve in the one link database', async () => {
    expect((await linked(SITE, { branch: 'story-2' })).linked_record_id).toBe(issues[1]!.id);
    expect((await linked(SITE, { branch: 'api/3-some-slug' })).linked_record_id).toBe(issues[2]!.id);
    expect((await linked(SITE, { title: 'Tidy up, ticket #4' })).linked_record_id).toBe(issues[3]!.id);
  });

  it('a StoryOS record URL in the body still links, naming its own database', async () => {
    const url = `https://app.storyos.test/w/${ws}/d/${issuesDb}/r/${issues[0]!.id}`;
    expect((await linked(SITE, { body: `Related: ${url}` })).linked_record_id).toBe(issues[0]!.id);
  });
});

describe('linking by identifier (ticket #1368 AC a)', () => {
  it.each(['feat', 'bugfix', 'fix', 'release'])('%s/issue-N links to ISSUE-N and moves it on open', async (kind) => {
    const target = issues[1]!;
    const out = await linked(SITE, { branch: `${kind}/issue-${target.number}` });
    expect(out.linked_record_id).toBe(target.id);
    expect(out.state_applied).toBe('In Progress');
    expect(await stateOf(issuesDb, target.id, issuesState.api)).toBe(issuesState.opts['In Progress']);
  });

  it('ISSUE-N in the title links, and in the body links', async () => {
    expect((await linked(SITE, { title: 'ISSUE-3: widen the picker' })).linked_record_id).toBe(issues[2]!.id);
    expect((await linked(SITE, { body: 'Part of the roast work.\n\nCloses ISSUE-4.' })).linked_record_id).toBe(issues[3]!.id);
  });

  it('the identifier is case-insensitive in a branch and exact-case in prose', async () => {
    expect((await linked(SITE, { branch: 'feat/ISSUE-2-shouty' })).linked_record_id).toBe(issues[1]!.id);
    expect((await linked(SITE, { title: 'we discussed issue-2 yesterday' })).linked_record_id).toBeNull();
  });

  it('merging moves the identified record to the configured state, on the same match', async () => {
    const target = issues[3]!;
    const out = await linked(SITE, { branch: `feat/issue-${target.number}`, action: 'closed', merged: true, number: 777 });
    expect(out.linked_record_id).toBe(target.id);
    expect(out.state_applied).toBe('PR Merged');
    expect(await stateOf(issuesDb, target.id, issuesState.api)).toBe(issuesState.opts['PR Merged']);
  });

  it('a number with no record, and text that is only shaped like one, link nothing without an error', async () => {
    expect((await linked(SITE, { branch: 'feat/issue-9999' })).linked_record_id).toBeNull();
    expect((await linked(SITE, { title: 'Bump CVE-2024-1234 and ISSUE- and ISSUE-x' })).linked_record_id).toBeNull();
  });
});

describe('the identifier names a database, and only the repo\'s own link database counts (ticket #1368 AC d: no guessing)', () => {
  it('an identifier whose prefix belongs to a DIFFERENT database of the workspace links nothing', async () => {
    // pinewood/site links to Issues (ISSUE). SP-2 is a real record in the Pages database, which is not this repo's database.
    const out = await linked(SITE, { branch: 'feat/sp-2', title: 'SP-2 and also SP-3' });
    expect(out.linked_record_id).toBeNull();
    expect(await stateOf(pagesDb, pages[1]!.id, pagesState.api)).toBeNull();
  });

  it('with several identifiers in one PR only the ones in the link database count; the branch outranks the title', async () => {
    const out = await linked(SITE, { branch: 'feat/issue-1', title: 'ISSUE-3 follows SP-3' });
    expect(out.linked_record_id).toBe(issues[0]!.id);
  });

  it('a link database with NO identifier prefix cannot be reached by identifier at all', async () => {
    expect((await setPrefix(issuesDb, null)).statusCode).toBe(200);
    try {
      expect((await linked(SITE, { branch: 'feat/issue-2' })).linked_record_id).toBeNull();
    } finally {
      expect((await setPrefix(issuesDb, 'ISSUE')).statusCode).toBe(200);
    }
  });

  it('a prefix is unique per workspace, so one identifier can never name two databases', async () => {
    const dup = await setPrefix(notesDb, 'ISSUE');
    expect(dup.statusCode).toBe(409);
  });
});

describe('a link database per repo (ticket #1368 / #905 AC b)', () => {
  // Fresh records, never touched by the tests above, and numbered identically in both databases (5 and 6).
  let freshIssues: Array<{ id: string; number: number }>;
  let freshPages: Array<{ id: string; number: number }>;
  beforeAll(async () => {
    const mk = async (database: string, label: string) => {
      const out: Array<{ id: string; number: number }> = [];
      for (const n of [5, 6]) {
        const r = (await adm('POST', `/workspaces/${ws}/databases/${database}/records`, { values: { name: `${label} fresh ${n}` } })).json();
        out.push({ id: r.id, number: r.number });
      }
      return out;
    };
    freshIssues = await mk(issuesDb, 'Issue');
    freshPages = await mk(pagesDb, 'Page');
    expect(freshIssues.map((r) => r.number)).toEqual([5, 6]);
    expect(freshPages.map((r) => r.number)).toEqual([5, 6]);
  });

  it('migrates the old single value on the first per-repo save: the existing repo keeps its database', async () => {
    const before = await readGithub();
    expect(before.json().link_databases).toBeNull();
    expect(before.json().link_database_id).toBe(issuesDb);

    const res = await saveGithub({ link_databases: { [PAGES]: pagesDb } });
    expect(res.statusCode, res.body).toBe(201);
    const cfg = (await readGithub()).json();
    expect(cfg.link_databases).toEqual({ [SITE]: issuesDb, [PAGES]: pagesDb, [STRANGER]: issuesDb });
    expect(cfg.link_database_id).toBeNull();
    // the repo that already linked still does, unchanged
    expect((await linked(SITE, { branch: 'story-2' })).linked_record_id).toBe(issues[1]!.id);
  });

  it('THE ISOLATION TEST: story-N in one repo never moves a record in the other repo\'s database (red under a single workspace-wide setting)', async () => {
    const toPages = await linked(PAGES, { branch: 'story-5' });
    expect(toPages.linked_record_id, 'pinewood/pages resolves against ITS database').toBe(freshPages[0]!.id);
    expect(await stateOf(pagesDb, freshPages[0]!.id, pagesState.api)).toBe(pagesState.opts['In Progress']);
    expect(await stateOf(issuesDb, freshIssues[0]!.id, issuesState.api), 'the other repo\'s record number 5 did not move').toBeNull();

    const toSite = await linked(SITE, { branch: 'story-6' });
    expect(toSite.linked_record_id).toBe(freshIssues[1]!.id);
    expect(await stateOf(issuesDb, freshIssues[1]!.id, issuesState.api)).toBe(issuesState.opts['In Progress']);
    expect(await stateOf(pagesDb, freshPages[1]!.id, pagesState.api), 'and the reverse').toBeNull();
  });

  it('lane branches and "ticket #N" are per-repo too', async () => {
    expect((await linked(PAGES, { branch: 'web/2-widen' })).linked_record_id).toBe(pages[1]!.id);
    expect((await linked(PAGES, { title: 'Follow-up, ticket #4' })).linked_record_id).toBe(pages[3]!.id);
  });

  it('identifiers are per-repo too: SP-N links on the pages repo and ISSUE-N does not', async () => {
    expect((await linked(PAGES, { branch: 'feat/sp-1' })).linked_record_id).toBe(pages[0]!.id);
    expect((await linked(PAGES, { title: 'ISSUE-1 is not this repo\'s database' })).linked_record_id).toBeNull();
    expect((await linked(SITE, { title: 'SP-1 is not this repo\'s database' })).linked_record_id).toBeNull();
  });

  it('a repo with no link database of its own links NOTHING by number or identifier (never a guess)', async () => {
    // the migration gave every watched repo the old value; take this one's away so it has none of its own
    expect((await saveGithub({ link_databases: { [STRANGER]: null } })).statusCode).toBe(201);
    expect((await linked(STRANGER, { branch: 'story-2' })).linked_record_id).toBeNull();
    expect((await linked(STRANGER, { branch: 'feat/issue-2', title: 'SP-2 ISSUE-2 ticket #2' })).linked_record_id).toBeNull();
  });

  it('a StoryOS record URL still links from any repo, because the URL names its own database', async () => {
    const url = `https://app.storyos.test/w/${ws}/d/${pagesDb}/r/${pages[0]!.id}`;
    expect((await linked(STRANGER, { body: url })).linked_record_id).toBe(pages[0]!.id);
  });

  it('once per-repo, the old single field is refused rather than silently ignored', async () => {
    const res = await saveGithub({ link_database_id: issuesDb });
    expect(res.statusCode).toBe(422);
    expect((await readGithub()).json().link_databases).toEqual({ [SITE]: issuesDb, [PAGES]: pagesDb });
  });

  it('null takes a repo\'s entry away: it then links nothing', async () => {
    expect((await saveGithub({ link_databases: { [PAGES]: null } })).statusCode).toBe(201);
    expect((await readGithub()).json().link_databases).toEqual({ [SITE]: issuesDb });
    expect((await linked(PAGES, { branch: 'story-1' })).linked_record_id).toBeNull();
    expect((await saveGithub({ link_databases: { [PAGES]: pagesDb } })).statusCode).toBe(201);
  });

  it('an entry must be a database of THIS workspace: another workspace\'s, a missing one and a malformed one are 422', async () => {
    const other = await signUpUser(app, 'Other Tenant');
    const otherWs = (await call(app, other.token, 'POST', '/workspaces', { name: 'Elsewhere' })).json().id;
    const otherSpace = (await call(app, other.token, 'GET', `/workspaces/${otherWs}/spaces`)).json()[0].id;
    const foreign = (await call(app, other.token, 'POST', `/workspaces/${otherWs}/databases`, { space_id: otherSpace, name: 'Theirs' })).json().id;
    for (const bad of [foreign, '00000000-0000-4000-8000-000000000000']) {
      const res = await saveGithub({ link_databases: { [STRANGER]: bad } });
      expect(res.statusCode, bad).toBe(422);
    }
    expect((await saveGithub({ link_databases: { 'not a repo': pagesDb } })).statusCode).toBe(422);
    expect((await readGithub()).json().link_databases).toEqual({ [SITE]: issuesDb, [PAGES]: pagesDb });
  });
});

describe('edge cases of the link databases (ticket #1368)', () => {
  it('a per-repo save is refused while a workspace-wide value exists and no repositories are selected (nothing to carry it onto)', async () => {
    const w = (await adm('POST', '/workspaces', { name: 'Pinewood Legacy' })).json().id;
    const sp = (await adm('GET', `/workspaces/${w}/spaces`)).json()[0].id;
    const d = await id('POST', `/workspaces/${w}/databases`, { space_id: sp, name: 'Legacy tickets' });
    const url = `/workspaces/${w}/integrations/github`;
    expect((await adm('POST', url, { webhook_secret: 'pinewood-legacy-secret-key-003', link_database_id: d })).statusCode).toBe(201);
    const res = await adm('POST', url, { link_databases: { [SITE]: d } });
    expect(res.statusCode, res.body).toBe(422);
    const cfg = (await adm('GET', url)).json();
    expect(cfg.link_databases, 'the working connection is untouched').toBeNull();
    expect(cfg.link_database_id).toBe(d);
  });

  it('a deleted link database links nothing by identifier', async () => {
    const temp = await id('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Temp work' });
    expect((await setPrefix(temp, 'TMP')).statusCode).toBe(200);
    await adm('POST', `/workspaces/${ws}/databases/${temp}/records`, { values: { name: 'Temp one' } });
    expect((await saveGithub({ link_databases: { [STRANGER]: temp } })).statusCode).toBe(201);
    try {
      expect((await linked(STRANGER, { branch: 'feat/tmp-1' })).linked_record_id, 'live: links').not.toBeNull();
      expect((await adm('DELETE', `/workspaces/${ws}/databases/${temp}`, { confirm: 'Temp work' })).statusCode).toBeLessThan(300);
      expect((await linked(STRANGER, { branch: 'feat/tmp-1' })).linked_record_id, 'deleted: does not').toBeNull();
    } finally {
      expect((await saveGithub({ link_databases: { [STRANGER]: null } })).statusCode).toBe(201);
    }
  });
});

describe('cross-tenant protection must keep working (ticket #1368 / #905 AC e)', () => {
  let other: { token: string; email: string };
  let otherWs: string;
  let otherDb: string;
  let otherRecord: { id: string; number: number };
  let otherStateApi: string;
  let otherSecret: string;

  beforeAll(async () => {
    other = await signUpUser(app, 'Rival Tenant');
    otherWs = (await call(app, other.token, 'POST', '/workspaces', { name: 'Rival' })).json().id;
    const sp = (await call(app, other.token, 'GET', `/workspaces/${otherWs}/spaces`)).json()[0].id;
    otherDb = (await call(app, other.token, 'POST', `/workspaces/${otherWs}/databases`, { space_id: sp, name: 'Rival issues' })).json().id;
    await call(app, other.token, 'PATCH', `/workspaces/${otherWs}/databases/${otherDb}`, { identifier_prefix: 'ISSUE' });
    const f = (
      await call(app, other.token, 'POST', `/workspaces/${otherWs}/databases/${otherDb}/fields`, {
        display_name: 'State', type: 'select', config: {}, options: [{ label: 'Todo' }, { label: 'In Progress' }, { label: 'PR Merged' }],
      })
    ).json();
    otherStateApi = f.apiName;
    otherRecord = (await call(app, other.token, 'POST', `/workspaces/${otherWs}/databases/${otherDb}/records`, { values: { name: 'Rival secret work' } })).json();
    otherSecret = 'rival-tenant-secret-key-00000002';
    const saved = await call(app, other.token, 'POST', `/workspaces/${otherWs}/integrations/github`, {
      webhook_secret: otherSecret, link_databases: { 'rival/app': otherDb }, state_automation: { opened: 'In Progress' },
    });
    expect(saved.statusCode, saved.body).toBe(201);
  });

  const rivalState = async () =>
    ((await call(app, other.token, 'GET', `/workspaces/${otherWs}/databases/${otherDb}/records/${otherRecord.id}`)).json().values[otherStateApi] ?? null) as string | null;

  it('a PR body naming another workspace\'s database URL and record links nothing and moves nothing', async () => {
    const url = `https://app.storyos.test/w/${otherWs}/d/${otherDb}/r/${otherRecord.id}`;
    const out = await linked(SITE, { body: `see ${url}` });
    expect(out.linked_record_id).toBeNull();
    expect(await rivalState()).toBeNull();
  });

  it('the same by record NUMBER in the URL form', async () => {
    const url = `https://app.storyos.test/w/${otherWs}/d/${otherDb}/r/${otherRecord.number}`;
    expect((await linked(SITE, { body: url })).linked_record_id).toBeNull();
    expect(await rivalState()).toBeNull();
  });

  it('an identifier that exists in ANOTHER workspace (same prefix, same number) never reaches it', async () => {
    // ISSUE-1 is a real record in the rival workspace; this workspace's own ISSUE-1 is the one that links.
    const out = await linked(SITE, { branch: 'feat/issue-1', title: 'ISSUE-1' });
    expect(out.linked_record_id).toBe(issues[0]!.id);
    expect(await rivalState()).toBeNull();
  });

  it('a link database id pointing into another workspace (written straight into settings) resolves to nothing at delivery time', async () => {
    // Defence in depth: the save endpoint refuses it, but a stale or hand-edited setting must still be inert.
    const row = (await dbh.select().from(workspaces).where(eq(workspaces.id, ws)))[0]!;
    const settings = row.settings as Record<string, any>;
    const original = settings.github.link_databases;
    settings.github.link_databases = { ...original, [STRANGER]: otherDb };
    await dbh.update(workspaces).set({ settings }).where(eq(workspaces.id, ws));
    try {
      expect((await linked(STRANGER, { branch: 'story-1', title: 'ISSUE-1' })).linked_record_id).toBeNull();
      expect(await rivalState()).toBeNull();
    } finally {
      settings.github.link_databases = original;
      await dbh.update(workspaces).set({ settings }).where(eq(workspaces.id, ws));
    }
  });

  it('the rival\'s own deliveries still link in the rival\'s workspace (nothing here broke the happy path)', async () => {
    const res = await deliver(pr('rival/app', { branch: 'feat/issue-1' }), otherSecret);
    expect(res.json().linked_record_id).toBe(otherRecord.id);
    expect(await rivalState()).not.toBeNull();
  });
});

describe('the backlink comment follows an identifier match (ticket #1368 AC c)', () => {
  it('posts the one backlink comment on a PR linked by identifier, and updates it on redelivery', async () => {
    const appSvc = app.get(GithubAppService);
    const posted: Array<{ repo: string; pr: number; body: string }> = [];
    const patched: string[] = [];
    const real = { isConfigured: appSvc.isConfigured.bind(appSvc), postComment: appSvc.postComment.bind(appSvc), updateComment: appSvc.updateComment.bind(appSvc) };
    appSvc.isConfigured = () => true;
    appSvc.postComment = async (_i: number, repo: string, prNumber: number, body: string) => {
      posted.push({ repo, pr: prNumber, body });
      return 'comment-1';
    };
    appSvc.updateComment = async (_i: number, _repo: string, commentId: string) => {
      patched.push(commentId);
    };
    await app.get(GithubService).saveInstallationId(ws, 4242);
    try {
      const payload = pr(SITE, { branch: 'feat/issue-3', number: 888 });
      expect((await deliver(payload)).json().linked_record_id).toBe(issues[2]!.id);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.pr).toBe(888);
      expect(posted[0]!.body).toContain('Issue work item 3');
      expect((await deliver(payload)).json().linked_record_id).toBe(issues[2]!.id);
      expect(posted, 'post-once').toHaveLength(1);
      expect(patched).toEqual(['comment-1']);
    } finally {
      Object.assign(appSvc, real);
    }
  });
});

describe('who can see or change the link databases (ticket #1368 AC e)', () => {
  let member: Person;
  let guest: Person;
  let demoted: Person;
  let leaver: Person;

  beforeAll(async () => {
    member = await joinAs(app, admin.token, ws, 'Link Member', 'member');
    guest = await joinAs(app, admin.token, ws, 'Link Guest', 'guest', [{ database_id: notesDb, role: 'viewer' }]);
    demoted = await joinAs(app, admin.token, ws, 'Link Demoted', 'admin');
    leaver = await joinAs(app, admin.token, ws, 'Link Leaver', 'admin');
    // demoted: an admin until now, a plain member from here on. leaver: an admin who has left the workspace.
    await dbh.update(memberships).set({ role: 'member' }).where(and(eq(memberships.userId, demoted.id), eq(memberships.workspaceId, ws)));
    await dbh.delete(memberships).where(and(eq(memberships.userId, leaver.id), eq(memberships.workspaceId, ws)));
  });

  const body = () => ({ link_databases: { [STRANGER]: notesDb } });

  it.each(['member', 'guest', 'demoted', 'leaver'] as const)('%s can neither read the settings nor change them', async (who) => {
    const person = { member, guest, demoted, leaver }[who];
    const read = await readGithub(person.token);
    expect([403, 404], `${who} GET ${read.body}`).toContain(read.statusCode);
    expect(read.body).not.toContain(issuesDb);
    const write = await saveGithub(body(), person.token);
    expect([403, 404], `${who} POST ${write.body}`).toContain(write.statusCode);
    expect(((await readGithub()).json().link_databases as Record<string, string>)[STRANGER]).toBeUndefined();
  });

  it('an unauthenticated caller gets 401', async () => {
    expect((await call(app, null, 'GET', `/workspaces/${ws}/integrations/github`)).statusCode).toBe(401);
  });

  it('an admin can read and change them', async () => {
    expect((await saveGithub(body())).statusCode).toBe(201);
    expect((await readGithub()).json().link_databases[STRANGER]).toBe(notesDb);
    expect((await saveGithub({ link_databases: { [STRANGER]: null } })).statusCode).toBe(201);
  });
});
