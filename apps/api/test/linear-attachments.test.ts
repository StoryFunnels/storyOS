import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { joinAs, setRestricted, grant } from './helpers/members';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { LinearService } from '../src/integrations/linear.service';
import { LinearAttachmentsService } from '../src/integrations/linear-attachments.service';

/**
 * Ticket #1366 — Linear attachments (PR links and other links) and project documents.
 *
 * THE LINEAR SIDE IS A HAND-WRITTEN FAKE of Linear's documented GraphQL shapes (see helpers/linear-attachments-fake.ts), not a recording.
 * These tests prove what the importer does with that shape. They do not prove Linear answers with it; the live probe does that.
 *
 * Every assertion reads back through the HTTP API. The access cases use a MEMBER WITHOUT A GRANT and a GUEST: a test with only the admin
 * proves nothing about restriction.
 */
const TEAM = { id: 'team-at', key: 'AT', name: 'Attach' };
const OLD = '2020-01-01T00:00:00.000Z';
const prj = (n: number) => ({ id: `prj-${n}`, name: `Project ${n}`, description: null, state: 'started', targetDate: null, url: `https://linear.app/acme/project/p${n}` });
const issue = (n: number) => ({ ...manyIssues(1)[0]!, id: `i${n}`, identifier: `AT-${n}`, title: `Issue ${n}`, updatedAt: OLD });
const att = (id: string, issueId: string, url: string, extra: Record<string, unknown> = {}) => ({
  id, issueId, title: `Title ${id}`, subtitle: null, url, sourceType: 'github', metadata: {}, createdAt: `2026-03-0${id.length % 9 + 1}T00:00:00Z`, updatedAt: OLD, ...extra,
});
const doc = (id: string, project: string | null, extra: Record<string, unknown> = {}) => ({
  id, title: `Doc ${id}`, url: `https://linear.app/acme/document/${id}`, content: `# Heading ${id}\n\nBody of ${id}.`,
  createdAt: '2026-01-05T09:00:00Z', updatedAt: '2026-01-06T09:00:00Z', creator: { name: 'Pat Writer' }, project: project ? { id: project } : null, ...extra,
});

let app: NestFastifyApplication;
let linear: LinearService;
let db: Db;
let admin: { token: string };
let ws: string;
const inject = (token: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const asAdmin = (method: string, url: string, payload?: unknown) => inject(admin.token, method, url, payload);

let attachments: Array<Record<string, unknown>> = [];
let documents: Array<Record<string, unknown>> = [];
let attachmentOnlyIssues: string[] = [];
let issues = [issue(1), issue(2), issue(3)];
// A second team, switched on only by the last describe (it proves a human-made "Documents" database is never adopted).
const TEAM_B = { id: 'team-bt', key: 'BT', name: 'Beta' };
let betaOn = false;
let betaDocuments: Array<Record<string, unknown>> = [];
const use = () => {
  const data = { labels: { nodes: [] }, cycles: { nodes: [] }, projects: { nodes: [prj(1)] }, issues: { nodes: issues }, attachments, documents, attachmentOnlyIssues };
  const beta = { labels: { nodes: [] }, cycles: { nodes: [] }, projects: { nodes: [{ ...prj(2), id: 'prj-b1', name: 'Beta project' }] }, issues: { nodes: [{ ...issue(9), id: 'b1', identifier: 'BT-1', title: 'Beta issue' }] }, attachments: [], documents: betaDocuments };
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: data as never }, ...(betaOn ? [{ ...TEAM_B, data: beta as never }] : [])]).fetcher;
};
const sync = async () => {
  use();
  const res = await asAdmin('POST', `/workspaces/${ws}/integrations/linear/sync`);
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { attachments: Record<string, number>; documents: Record<string, unknown> & { oversize: string[] }; warnings?: string[] };
};
const dbNamed = async (name: string) => (await asAdmin('GET', `/workspaces/${ws}/databases`)).json().find((d: { name: string }) => d.name === name) as { id: string; spaceId?: string; space_id?: string } | undefined;
interface Row { id: string; title: string; values: Record<string, unknown> }
const rowsOf = async (dbId: string) => (await asAdmin('GET', `/workspaces/${ws}/databases/${dbId}/records?limit=200`)).json().data as Row[];
const titles = (v: unknown) => ((v ?? []) as Array<{ title: string }>).map((x) => x.title).sort();
const linkEvents = async (recordId: string) => {
  const r = (await db.execute(sql`SELECT count(*)::int AS n FROM activity_events WHERE record_id = ${recordId} AND type = 'relation.linked'`)) as unknown as { rows: Array<{ n: number }> };
  return r.rows[0]!.n;
};

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  db = app.get<Db>(DB);
  admin = await signUpUser(app, 'Linear Attach');
  ws = (await asAdmin('POST', '/workspaces', { name: 'Linear Attach WS' })).json().id;
  expect((await asAdmin('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['AT'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('PR attachments become records in the GitHub Pull Requests database', () => {
  it('creates ONE record per (repo, number), keeps the title and canonical URL, and links it to the issue', async () => {
    attachments = [att('a1', 'i1', 'https://github.com/acme/api/pull/42/files', { title: 'Fix the share dialog', metadata: { status: 'merged' } })];
    const s = await sync();
    expect(s.attachments).toMatchObject({ fetched: 1, pull_requests: 1, pr_records_created: 1, links: 0, unusable: 0, unplaced: 0, failed: 0 });

    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const [pr] = await rowsOf(pulls.id);
    expect(pr!.title).toBe('Fix the share dialog');
    expect(pr!.values).toMatchObject({ repo: 'acme/api', number: 42, url: 'https://github.com/acme/api/pull/42' });
    expect(titles(pr!.values['linked_record'])).toEqual(['Issue 1']);

    const issuesDb = (await dbNamed('Issues'))!;
    const issue1 = (await rowsOf(issuesDb.id)).find((r) => r.title === 'Issue 1')!;
    expect(titles(issue1.values['github_pull_requests'])).toEqual(['Fix the share dialog']);
  });

  it('a re-sync is idempotent: no new PR record, and no new "linked" event', async () => {
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const [pr] = await rowsOf(pulls.id);
    const before = await linkEvents(pr!.id);
    const s = await sync();
    expect(s.attachments).toMatchObject({ fetched: 1, pull_requests: 1, pr_records_created: 0 });
    expect(await rowsOf(pulls.id)).toHaveLength(1);
    expect(await linkEvents(pr!.id)).toBe(before);
  });

  it('the SAME pull request attached to two issues is one record linked to both', async () => {
    attachments = [
      att('a1', 'i1', 'https://github.com/acme/api/pull/42'),
      att('a2', 'i2', 'https://github.com/acme/api/pull/42/commits'),
    ];
    await sync();
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const rows = await rowsOf(pulls.id);
    expect(rows).toHaveLength(1);
    expect(titles(rows[0]!.values['linked_record'])).toEqual(['Issue 1', 'Issue 2']);
  });

  it('is resolved by (repo, NUMBER): the same number in another repo is another PR, and a record the webhook made is reused, not duplicated', async () => {
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const merged = (await asAdmin('GET', `/workspaces/${ws}/databases/${pulls.id}`)).json().fields.find((f: { apiName: string }) => f.apiName === 'state');
    const mergedOpt = merged.options.find((o: { label: string }) => o.label === 'Merged').id as string;
    // As the GitHub webhook would have written it: a different case of the same repo, and a state Linear knows nothing about.
    const made = await asAdmin('POST', `/workspaces/${ws}/databases/${pulls.id}/records`, { values: { name: 'From the webhook', repo: 'Acme/Web', number: 7, state: mergedOpt, branch: 'story-9' } });
    expect(made.statusCode, made.body).toBe(201);

    attachments = [
      att('a1', 'i1', 'https://github.com/acme/api/pull/7'),
      att('a2', 'i2', 'https://github.com/acme/web/pull/7'),
    ];
    const s = await sync();
    expect(s.attachments).toMatchObject({ pull_requests: 2, pr_records_created: 1 });

    const rows = await rowsOf(pulls.id);
    const sevens = rows.filter((r) => r.values['number'] === 7);
    expect(sevens.map((r) => r.values['repo']).sort()).toEqual(['Acme/Web', 'acme/api']);
    const web = sevens.find((r) => r.values['repo'] === 'Acme/Web')!;
    expect(web.id).toBe(made.json().id);
    // never rewritten from a Linear attachment: title, state and branch stay what GitHub's webhook wrote
    expect(web.title).toBe('From the webhook');
    expect(web.values['state']).toBe(mergedOpt);
    expect(web.values['branch']).toBe('story-9');
    expect(titles(web.values['linked_record'])).toEqual(['Issue 2']);
  });

  it('writes the PR state only when Linear names one, and leaves it empty otherwise', async () => {
    attachments = [
      att('a1', 'i1', 'https://github.com/acme/api/pull/101', { metadata: { status: 'merged' } }),
      att('a2', 'i1', 'https://github.com/acme/api/pull/102', { metadata: { status: 'who knows' } }),
      att('a3', 'i1', 'https://github.com/acme/api/pull/103', { metadata: null }),
    ];
    await sync();
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const rows = await rowsOf(pulls.id);
    const stateOf = (n: number) => rows.find((r) => r.values['number'] === n)!.values['state'];
    expect(stateOf(101)).toBeTruthy();
    expect(stateOf(102) ?? null).toBeNull();
    expect(stateOf(103) ?? null).toBeNull();
  });
});

describe('every other attachment becomes a record in the team\'s own Links database', () => {
  it('keeps title, URL and source, and links it to its issue (a merge commit is not a PR)', async () => {
    attachments = [
      att('c1', 'i1', 'https://github.com/acme/api/commit/0123456789abcdef', { title: 'Merge pull request #42', sourceType: 'githubCommit', subtitle: 'abc123 by pat' }),
      att('f1', 'i2', 'https://www.figma.com/file/XYZ/Design', { title: 'Share dialog design', sourceType: 'figma' }),
    ];
    const s = await sync();
    expect(s.attachments).toMatchObject({ fetched: 2, pull_requests: 0, links: 2, kept_in_team_space: 0, unusable: 0 });

    const links = (await dbNamed('Links'))!;
    const rows = await rowsOf(links.id);
    expect(rows.map((r) => r.title).sort()).toEqual(['Merge pull request #42', 'Share dialog design']);
    const commit = rows.find((r) => r.title === 'Merge pull request #42')!;
    expect(commit.values).toMatchObject({ url: 'https://github.com/acme/api/commit/0123456789abcdef', source_type: 'githubCommit', subtitle: 'abc123 by pat', linear_id: 'c1' });
    expect(titles(commit.values['issue'])).toEqual(['Issue 1']);

    // idempotent by Linear id
    await sync();
    expect(await rowsOf(links.id)).toHaveLength(2);
  });

  it('an unusable URL is counted and reported, never stored; and nothing is ever fetched from an attachment URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('an attachment URL must never be fetched'); });
    try {
      attachments = [
        att('x1', 'i1', 'javascript:alert(document.cookie)', { sourceType: 'url' }),
        att('x2', 'i1', 'data:text/html,<script>alert(1)</script>', { sourceType: 'url' }),
        att('x3', 'i1', 'http://169.254.169.254/latest/meta-data/', { sourceType: 'url' }),
      ];
      const s = await sync();
      expect(s.attachments).toMatchObject({ fetched: 3, unusable: 2, links: 1 });
      expect(s.warnings?.some((w) => w.includes('x1') && w.includes('not an http(s) URL'))).toBe(true);
      const links = (await dbNamed('Links'))!;
      const urls = (await rowsOf(links.id)).map((r) => r.values['url']);
      expect(urls.some((u) => typeof u === 'string' && /^(javascript|data):/i.test(u))).toBe(false);
      // the metadata-endpoint URL is just data: stored as a link, and not requested
      expect(urls).toContain('http://169.254.169.254/latest/meta-data/');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('an issue with more attachments than one nested page loses none of them', async () => {
    attachments = Array.from({ length: 63 }, (_, i) => att(`bulk-${i}`, 'i3', `https://example.com/bulk/${i}`, { title: `Bulk ${i}`, sourceType: 'url' }));
    const s = await sync();
    expect(s.attachments).toMatchObject({ fetched: 63, links: 63, failed: 0 });
    const links = (await dbNamed('Links'))!;
    expect((await rowsOf(links.id)).filter((r) => r.title.startsWith('Bulk '))).toHaveLength(63);
  });

  it('an attachment on an issue this run did not place is counted as unplaced, not lost and not fatal', async () => {
    attachments = [att('u1', 'i-never-read', 'https://example.com/u1')];
    attachmentOnlyIssues = ['i-never-read'];
    try {
      const s = await sync();
      expect(s.attachments).toMatchObject({ fetched: 1, unplaced: 1, links: 0 });
      expect(s.warnings?.some((w) => w.includes('u1'))).toBe(true);
    } finally {
      attachmentOnlyIssues = [];
    }
  });
});

describe('project documents', () => {
  it('become records in the team\'s Documents database: title, author, dates, URL, project relation, Markdown body', async () => {
    attachments = [];
    documents = [doc('d1', 'prj-1'), doc('d2', null), doc('d3', 'prj-elsewhere')];
    const s = await sync();
    expect(s.documents).toMatchObject({ fetched: 3, placed: 1, copies: 1, created: 1, body_written: 1, no_project: 1, project_not_imported: 1, failed: 0, drift_flagged: 0 });

    const docs = (await dbNamed('Documents'))!;
    const rows = await rowsOf(docs.id);
    expect(rows).toHaveLength(1);
    const d1 = rows[0]!;
    expect(d1.title).toBe('Doc d1');
    expect(d1.values).toMatchObject({ author_name: 'Pat Writer', linear_id: 'd1', url: 'https://linear.app/acme/document/d1' });
    expect(d1.values['linear_created']).toContain('2026-01-05');
    expect(d1.values['linear_updated']).toContain('2026-01-06');
    expect(titles(d1.values['project'])).toEqual(['Project 1']);

    const body = (await asAdmin('GET', `/workspaces/${ws}/databases/${docs.id}/records/${d1.id}/document`)).json();
    expect(body.version).toBeGreaterThan(0);
    expect(JSON.stringify(body.content)).toContain('Heading d1');
    expect(JSON.stringify(body.content)).toContain('Body of d1.');
  });

  it('a re-sync changes nothing: no second record, no flag', async () => {
    const s = await sync();
    expect(s.documents).toMatchObject({ placed: 1, created: 0, body_written: 0, drift_flagged: 0 });
    const docs = (await dbNamed('Documents'))!;
    expect(await rowsOf(docs.id)).toHaveLength(1);
  });

  it('Linear\'s later edit is FLAGGED and never overwrites the body in StoryOS', async () => {
    documents = [doc('d1', 'prj-1', { content: '# Heading d1\n\nRewritten in Linear.' })];
    const s = await sync();
    expect(s.documents).toMatchObject({ drift_flagged: 1, body_written: 0 });
    const docs = (await dbNamed('Documents'))!;
    const [d1] = await rowsOf(docs.id);
    expect(d1!.values['changed_in_linear']).toBe(true);
    const body = (await asAdmin('GET', `/workspaces/${ws}/databases/${docs.id}/records/${d1!.id}/document`)).json();
    expect(JSON.stringify(body.content)).toContain('Body of d1.');
    expect(JSON.stringify(body.content)).not.toContain('Rewritten in Linear');

    // an unchanged document is not flagged again, and a person clearing the flag sticks
    await asAdmin('PATCH', `/workspaces/${ws}/databases/${docs.id}/records/${d1!.id}`, { values: { changed_in_linear: false } });
    const again = await sync();
    expect(again.documents).toMatchObject({ drift_flagged: 0 });
    expect((await rowsOf(docs.id))[0]!.values['changed_in_linear'] ?? false).toBe(false);
  });

  it('a body over 2 MB is NOT truncated: the record exists without a body and the document is named', async () => {
    documents = [doc('big', 'prj-1', { title: 'The enormous PRD', content: `# Big\n\n${'x'.repeat(2 * 1024 * 1024 + 10)}` })];
    const s = await sync();
    expect(s.documents.oversize).toEqual(['The enormous PRD']);
    expect(s.warnings?.some((w) => w.includes('The enormous PRD') && w.includes('WITHOUT the body'))).toBe(true);
    const docs = (await dbNamed('Documents'))!;
    const big = (await rowsOf(docs.id)).find((r) => r.title === 'The enormous PRD')!;
    expect((await asAdmin('GET', `/workspaces/${ws}/databases/${docs.id}/records/${big.id}/document`)).json().version).toBe(0);
  });
});

describe('access: both new databases inherit the team space, and a restricted team never writes into the shared PR database', () => {
  let space: string;
  let member: { token: string; id: string };
  let guest: { token: string; id: string };
  let insider: { token: string; id: string };

  beforeAll(async () => {
    const issuesDb = (await dbNamed('Issues'))!;
    space = (issuesDb.spaceId ?? issuesDb.space_id)!;
    member = await joinAs(app, admin.token, ws, 'Plain Member', 'member');
    insider = await joinAs(app, admin.token, ws, 'Granted Member', 'member');
    // a guest who holds a grant on something ELSE, so she is a real guest and not an empty one
    const other = (await asAdmin('POST', `/workspaces/${ws}/spaces`, { name: 'Elsewhere' })).json().id as string;
    guest = await joinAs(app, admin.token, ws, 'Some Guest', 'guest', [{ space_id: other, role: 'viewer' }]);
  }, 60_000);

  it('a restricted team space keeps its PR attachments in its own Links database and shows them to nobody without a grant', async () => {
    await setRestricted(app, admin.token, ws, 'space', space);
    await grant(app, admin.token, ws, insider.id, { space_id: space }, 'viewer');
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const before = (await rowsOf(pulls.id)).length;

    attachments = [att('r1', 'i3', 'https://github.com/acme/secret-repo/pull/900', { title: 'Embargoed security fix' })];
    documents = [doc('secret', 'prj-1', { title: 'Embargoed PRD' })];
    const s = await sync();
    expect(s.attachments).toMatchObject({ fetched: 1, pull_requests: 0, links: 1, kept_in_team_space: 1 });

    // not in the shared database...
    const after = await rowsOf(pulls.id);
    expect(after).toHaveLength(before);
    expect(after.some((r) => r.title === 'Embargoed security fix')).toBe(false);
    // ...but in the team's own
    const links = (await dbNamed('Links'))!;
    const kept = (await rowsOf(links.id)).find((r) => r.title === 'Embargoed security fix')!;
    expect(kept.values['url']).toBe('https://github.com/acme/secret-repo/pull/900');

    const docs = (await dbNamed('Documents'))!;
    const secretDoc = (await rowsOf(docs.id)).find((r) => r.title === 'Embargoed PRD')!;

    for (const [who, person] of [['a member without a grant', member], ['a guest', guest]] as const) {
      for (const [what, url] of [
        ['the Links database', `/workspaces/${ws}/databases/${links.id}`],
        ['a link record', `/workspaces/${ws}/databases/${links.id}/records/${kept.id}`],
        ['the Documents database', `/workspaces/${ws}/databases/${docs.id}`],
        ['a document record', `/workspaces/${ws}/databases/${docs.id}/records/${secretDoc.id}`],
        ['a document body', `/workspaces/${ws}/databases/${docs.id}/records/${secretDoc.id}/document`],
      ] as const) {
        const res = await inject(person.token, 'GET', url);
        expect(res.statusCode, `${who} must not read ${what}`).toBe(404);
      }
      // nor does a search or a list leak the title
      const list = await inject(person.token, 'GET', `/workspaces/${ws}/databases/${docs.id}/records?limit=50`);
      expect(list.statusCode).toBe(404);
      expect(list.body).not.toContain('Embargoed');
    }

    // the control: someone WITH a grant on the space does read them, so the 404s above are the restriction, not a broken route
    expect((await inject(insider.token, 'GET', `/workspaces/${ws}/databases/${docs.id}/records/${secretDoc.id}`)).statusCode).toBe(200);
    expect((await inject(insider.token, 'GET', `/workspaces/${ws}/databases/${links.id}/records/${kept.id}`)).statusCode).toBe(200);
  });
});

describe('an unreadable team space fails closed', () => {
  // The earlier access describe left the team space RESTRICTED, which would hide a fail-open bug: open it for these two.
  let spaceId: string;
  beforeAll(async () => {
    const i = (await dbNamed('Issues'))!;
    spaceId = (i.spaceId ?? i.space_id)!;
    await setRestricted(app, admin.token, ws, 'space', spaceId, false);
  });
  afterAll(async () => { await setRestricted(app, admin.token, ws, 'space', spaceId, true); });

  it('writes NOTHING to the shared PR database and says so', async () => {
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const before = (await rowsOf(pulls.id)).length;
    const svc = app.get(LinearAttachmentsService);
    const spy = vi.spyOn(svc as unknown as { loadSpace: () => Promise<undefined> }, 'loadSpace').mockResolvedValue(undefined);
    try {
      attachments = [att('z1', 'i1', 'https://github.com/acme/api/pull/777', { title: 'Unreadable-space PR' })];
      const s = await sync();
      expect(s.attachments).toMatchObject({ pull_requests: 0, links: 1, kept_in_team_space: 1 });
      expect(s.warnings?.some((w) => w.includes('space could not be read'))).toBe(true);
      expect(await rowsOf(pulls.id)).toHaveLength(before);
    } finally {
      spy.mockRestore();
    }
  });

  it('a look-alike host (notgithub.com, evil-github.com) is a plain link, never a PR record', async () => {
    const pulls = (await dbNamed('GitHub Pull Requests'))!;
    const before = (await rowsOf(pulls.id)).length;
    attachments = [att('h1', 'i1', 'https://notgithub.com/o/r/pull/1'), att('h2', 'i1', 'https://evil-github.com/o/r/pull/1')];
    const s = await sync();
    expect(s.attachments).toMatchObject({ pull_requests: 0, links: 2 });
    expect(await rowsOf(pulls.id)).toHaveLength(before);
  });
});

describe('the importer\'s own databases are recognised by their mark, never by name alone', () => {
  it('a database a person made and called "Documents" is not adopted and not written to: the importer makes "Documents (Linear)"', async () => {
    betaOn = true;
    betaDocuments = [];
    expect((await asAdmin('POST', `/workspaces/${ws}/integrations/linear`, { team_keys: ['AT', 'BT'] })).statusCode).toBe(201);
    await sync(); // creates the Beta space, with no documents yet and so no Documents database
    const spaces = (await asAdmin('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>;
    const betaSpace = spaces.find((x) => x.name === 'Beta (Linear)')!;
    expect(betaSpace).toBeTruthy();

    const human = await asAdmin('POST', `/workspaces/${ws}/databases`, { space_id: betaSpace.id, name: 'Documents' });
    expect(human.statusCode, human.body).toBe(201);
    const humanDb = human.json().id as string;
    expect((await asAdmin('POST', `/workspaces/${ws}/databases/${humanDb}/records`, { values: { name: 'My own notes' } })).statusCode).toBe(201);

    betaDocuments = [doc('bd1', 'prj-b1', { title: 'Beta PRD' })];
    const s = await sync();
    expect(s.documents).toMatchObject({ failed: 0 });

    const all = (await asAdmin('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; spaceId?: string; space_id?: string }>;
    const inBeta = all.filter((d) => (d.spaceId ?? d.space_id) === betaSpace.id);
    expect(inBeta.map((d) => d.name).sort()).toEqual(expect.arrayContaining(['Documents', 'Documents (Linear)']));
    // the person's database is exactly as they left it
    const mine = await rowsOf(humanDb);
    expect(mine.map((r) => r.title)).toEqual(['My own notes']);
    const theirs = inBeta.find((d) => d.name === 'Documents (Linear)')!;
    expect((await rowsOf(theirs.id)).map((r) => r.title)).toEqual(['Beta PRD']);
  });
});
