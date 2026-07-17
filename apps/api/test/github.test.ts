import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { GithubService } from '../src/integrations/github.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

const FAKE = {
  '/repos/acme/site/issues?state=all&per_page=100': [
    { number: 1, title: 'Fix header overflow', state: 'open', html_url: 'https://github.com/acme/site/issues/1', labels: [{ name: 'bug' }], assignee: { login: 'dana' } },
    { number: 2, title: 'Dark mode', state: 'closed', html_url: 'https://github.com/acme/site/issues/2', labels: [], assignee: null },
    { number: 3, title: 'PR mirage', state: 'open', html_url: 'x', labels: [], assignee: null, pull_request: {} },
  ],
  '/repos/acme/site/pulls?state=all&per_page=100': [
    { number: 10, title: 'Fix overflow (#1)', state: 'open', merged_at: null, html_url: 'https://github.com/acme/site/pull/10', user: { login: 'dana' }, head: { ref: 'fix/1-header-overflow' } },
    { number: 11, title: 'Refactor styles', state: 'closed', merged_at: '2026-07-01T00:00:00Z', html_url: 'https://github.com/acme/site/pull/11', user: { login: 'max' }, head: { ref: 'chore/styles' }, draft: false },
  ],
} as Record<string, unknown>;

beforeAll(async () => {
  app = await createTestApp();
  const github = app.get(GithubService);
  github.fetcher = async (path) => {
    if (!(path in FAKE)) throw new Error(`unexpected path ${path}`);
    return FAKE[path];
  };
  admin = await signUpUser(app, 'Octocat');
  wsId = (await inject('POST', '/workspaces', { name: 'GH WS' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('GitHub integration v1 (MN-065)', () => {
  it('requires config before sync; saves token + repos', async () => {
    const early = await inject('POST', `/workspaces/${wsId}/integrations/github/sync`);
    expect(early.statusCode).toBe(422);
    const save = await inject('POST', `/workspaces/${wsId}/integrations/github`, {
      token: 'ghp_test', repos: ['acme/site'],
    });
    expect(save.statusCode, save.body).toBe(201);
    const config = (await inject('GET', `/workspaces/${wsId}/integrations/github`)).json();
    expect(config.has_token).toBe(true);
    expect(config.repos).toEqual(['acme/site']);
  });

  it('imports issues + PRs, skips PR-mirage issues, auto-links by #N and branch', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/integrations/github/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().issues).toBe(2); // PR-shaped issue skipped
    expect(res.json().pulls).toBe(2);
    expect(res.json().linked).toBeGreaterThanOrEqual(1);

    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const pullsDb = dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${pullsDb.id}/records?limit=50`)).json();
    /**
     * PR state is a four-way map (`merged_at ? Merged : draft ? Draft : open ?
     * Open : Closed`). `expect(pr10.values.state).toBeTruthy()` passed for every
     * branch of it — including the one that matters: PR 11 is `state: 'closed'`
     * WITH `merged_at` set, so a mapping that ignored `merged_at` and filed it as
     * Closed was indistinguishable from a correct one. Resolve the option ids and
     * name the expected label, the way the issues test below already does.
     */
    const pullDetail = (await inject('GET', `/workspaces/${wsId}/databases/${pullsDb.id}`)).json();
    const pullState = pullDetail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const optionId = (label: string) => {
      const found = pullState.options.find((o: { label: string }) => o.label === label);
      expect(found, `the State field must offer "${label}"`).toBeTruthy();
      return found.id;
    };

    const pr10 = list.data.find((r: { title: string }) => r.title.includes('Fix overflow'));
    expect(pr10.values.state, 'open + not merged → Open').toBe(optionId('Open'));
    expect(pr10.values.closes_issues?.[0]?.title).toBe('Fix header overflow');

    const pr11 = list.data.find((r: { title: string }) => r.title.includes('Refactor'));
    expect(pr11.values.branch).toBe('chore/styles');
    // The load-bearing one: closed BUT merged is Merged, not Closed.
    expect(pr11.values.state, 'closed + merged_at → Merged, not Closed').toBe(optionId('Merged'));
    expect(pr11.values.state).not.toBe(optionId('Closed'));
  });

  it('re-sync is idempotent and picks up state changes', async () => {
    (FAKE['/repos/acme/site/issues?state=all&per_page=100'] as Array<{ state: string }>)[0]!.state = 'closed';
    const res = await inject('POST', `/workspaces/${wsId}/integrations/github/sync`);
    expect(res.json().issues).toBe(2);

    const dbs = (await inject('GET', `/workspaces/${wsId}/databases`)).json();
    const issuesDb = dbs.find((d: { name: string }) => d.name === 'GitHub Issues');
    const list = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}/records?limit=50`)).json();
    expect(list.data).toHaveLength(2); // no duplicates
    const issue1 = list.data.find((r: { title: string }) => r.title === 'Fix header overflow');
    const detail = (await inject('GET', `/workspaces/${wsId}/databases/${issuesDb.id}`)).json();
    const stateField = detail.fields.find((f: { apiName: string }) => f.apiName === 'state');
    const closed = stateField.options.find((o: { label: string }) => o.label === 'Closed').id;
    expect(issue1.values.state).toBe(closed);
  });
});
