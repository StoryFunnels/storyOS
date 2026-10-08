import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { GithubService, MAX_IGNORED_REPOS } from '../src/integrations/github.service';

/**
 * #828 — a delivery for a repository outside the picker is still skipped and still
 * answered 200 (that behaviour is CORRECT), but it is now RECORDED and surfaced on
 * the GitHub config an admin reads, instead of vanishing behind a healthy-looking
 * connection. The skip answer must not change; the visibility must not be unbounded.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

// Unique per run: the secret IS the tenant (authenticate() picks the first workspace it
// matches), so a fixed value collides with any other suite's workspace in a shared DB.
const SECRET = `ignored-deliveries-${Math.random().toString(36).slice(2)}-secret`;
const as = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });

function deliver(repo: string, event = 'pull_request') {
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: repo },
    pull_request: { number: 1, title: 't', state: 'open', merged: false, merged_at: null, draft: false, html_url: 'u', body: null, user: { login: 'd' }, head: { ref: 'b', sha: 's' } },
  });
  return app.inject({
    method: 'POST',
    url: '/api/v1/integrations/github/webhook',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    payload: body,
  });
}
const config = async () => (await as('GET', `/workspaces/${wsId}/integrations/github`)).json();

beforeAll(async () => {
  app = await createTestApp();
  app.get(GithubService).fetcher = async () => ({ state: 'pending' });
  admin = await signUpUser(app, 'IgnoredHooks');
  wsId = (await as('POST', '/workspaces', { name: '828 WS' })).json().id;
  const saved = await as('POST', `/workspaces/${wsId}/integrations/github`, { webhook_secret: SECRET, repos: ['acme/site'] });
  expect(saved.statusCode, saved.body).toBe(201);
});

afterAll(async () => {
  await app.close();
});

describe('#828 — ignored deliveries are visible', () => {
  it('nothing ignored yet: the surface is empty, not absent', async () => {
    expect((await config()).ignored_deliveries).toEqual({ repos: [], other_count: 0 });
  });

  it('a delivery for an unselected repo is still a 200 skip — and now shows up with name and count', async () => {
    const first = await deliver('acme/other');
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().skipped).toBe('repo_not_selected');
    expect((await deliver('acme/other')).statusCode).toBe(200);
    await deliver('acme/third');

    const { repos, other_count } = (await config()).ignored_deliveries;
    expect(other_count).toBe(0);
    const other = repos.find((r: { repo: string }) => r.repo === 'acme/other');
    expect(other).toMatchObject({ repo: 'acme/other', count: 2, last_event: 'pull_request' });
    expect(Date.parse(other.first_seen_at)).not.toBeNaN();
    expect(repos.map((r: { repo: string }) => r.repo).sort()).toEqual(['acme/other', 'acme/third']);
  });

  it('a SELECTED repo is never listed as ignored', async () => {
    const res = await deliver('acme/site');
    expect(res.json().skipped).not.toBe('repo_not_selected');
    const repos = (await config()).ignored_deliveries.repos.map((r: { repo: string }) => r.repo);
    expect(repos).not.toContain('acme/site');
  });

  it('saving unrelated config keeps the tally; selecting an ignored repo removes just its entry', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, { link_database_id: undefined, state_automation: { opened: 'In Progress' } });
    expect((await config()).ignored_deliveries.repos).toHaveLength(2);

    await as('POST', `/workspaces/${wsId}/integrations/github`, { repos: ['acme/site', 'acme/other'] });
    const repos = (await config()).ignored_deliveries.repos.map((r: { repo: string }) => r.repo);
    expect(repos).toEqual(['acme/third']);
  });

  it('the secret never leaks through the new field, and disconnect clears it', async () => {
    expect(JSON.stringify(await config())).not.toContain(SECRET);
    await as('POST', `/workspaces/${wsId}/integrations/github/disconnect`);
    expect((await config()).ignored_deliveries).toEqual({ repos: [], other_count: 0 });
  });
});

describe('#828 — bounded', () => {
  it('a flood of distinct repos stops at the cap and is counted in other_count', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, { webhook_secret: SECRET, repos: ['acme/site'] });
    const total = MAX_IGNORED_REPOS + 5;
    for (let i = 0; i < total; i += 1) expect((await deliver(`flood/repo-${i}`)).statusCode).toBe(200);
    const { repos, other_count } = (await config()).ignored_deliveries;
    expect(repos).toHaveLength(MAX_IGNORED_REPOS);
    expect(other_count).toBe(5);
  }, 120_000);

  it('a known repo keeps counting past the cap, with no new row', async () => {
    for (let i = 0; i < 3; i += 1) await deliver('flood/repo-0');
    const { repos } = (await config()).ignored_deliveries;
    expect(repos).toHaveLength(MAX_IGNORED_REPOS);
    expect(repos.find((r: { repo: string }) => r.repo === 'flood/repo-0').count).toBe(4);
  });

  it('a recording failure cannot change the answer: still 200', async () => {
    const db = (app.get(GithubService) as unknown as { db: { transaction: unknown } }).db;
    const real = db.transaction;
    db.transaction = async () => { throw new Error('db down'); };
    try {
      const res = await deliver('flood/anything');
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().skipped).toBe('repo_not_selected');
    } finally {
      db.transaction = real;
    }
  });
});
