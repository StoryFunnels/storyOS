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
  '/repos/acme/site/issues?state=all&per_page=100&page=1': [
    { number: 1, title: 'Fix header overflow', state: 'open', html_url: 'https://github.com/acme/site/issues/1', labels: [{ name: 'bug' }], assignee: { login: 'dana' } },
    { number: 2, title: 'Dark mode', state: 'closed', html_url: 'https://github.com/acme/site/issues/2', labels: [], assignee: null },
    { number: 3, title: 'PR mirage', state: 'open', html_url: 'x', labels: [], assignee: null, pull_request: {} },
  ],
  '/repos/acme/site/pulls?state=all&per_page=100&page=1': [
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
    (FAKE['/repos/acme/site/issues?state=all&per_page=100&page=1'] as Array<{ state: string }>)[0]!.state = 'closed';
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

  it('disconnect (MN-249) clears the token, repos and connected state', async () => {
    const before = (await inject('GET', `/workspaces/${wsId}/integrations/github`)).json();
    expect(before.has_token).toBe(true);

    const res = await inject('POST', `/workspaces/${wsId}/integrations/github/disconnect`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().has_token).toBe(false);
    expect(res.json().connected).toBe(false);
    expect(res.json().repos).toEqual([]);

    const after = (await inject('GET', `/workspaces/${wsId}/integrations/github`)).json();
    expect(after.has_token).toBe(false);
    expect(after.connected).toBe(false);
  });
});

describe('#476 sync() paginates instead of silently capping at 100', () => {
  it('fetches a second page when the first is exactly full', async () => {
    const ws2 = (await inject('POST', '/workspaces', { name: 'Paged WS' })).json().id;
    const github = app.get(GithubService);
    const original = github.fetcher;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: 'open' as const,
      html_url: `https://github.com/acme/paged/issues/${i + 1}`,
      labels: [],
      assignee: null,
    }));
    const page2 = [
      {
        number: 101,
        title: 'Issue 101',
        state: 'open' as const,
        html_url: 'https://github.com/acme/paged/issues/101',
        labels: [],
        assignee: null,
      },
    ];
    github.fetcher = async (path) => {
      if (path === '/repos/acme/paged/issues?state=all&per_page=100&page=1') return page1;
      if (path === '/repos/acme/paged/issues?state=all&per_page=100&page=2') return page2;
      if (path.includes('/pulls')) return [];
      throw new Error(`unexpected path ${path}`);
    };
    try {
      await inject('POST', `/workspaces/${ws2}/integrations/github`, { token: 'ghp_test', repos: ['acme/paged'] });
      const res = await inject('POST', `/workspaces/${ws2}/integrations/github/sync`);
      expect(res.statusCode, res.body).toBe(201);
      // 101, not capped at 100 — the whole point of #476's pagination fix.
      expect(res.json().issues).toBe(101);
    } finally {
      github.fetcher = original;
    }
  });
});

describe('#476 AC — a PR number shared by two repos never lands on the wrong row', () => {
  it('upserts #473 from two different repos into two distinct records', async () => {
    const ws3 = (await inject('POST', '/workspaces', { name: 'Multi Repo WS' })).json().id;
    const github = app.get(GithubService);
    const original = github.fetcher;
    const FAKE2: Record<string, unknown> = {
      '/repos/storyfunnels/storyos/issues?state=all&per_page=100&page=1': [],
      '/repos/storyfunnels/storyos/pulls?state=all&per_page=100&page=1': [
        {
          number: 473,
          title: 'storyOS PR',
          state: 'open',
          merged_at: null,
          html_url: 'https://github.com/storyfunnels/storyos/pull/473',
          user: { login: 'a' },
          head: { ref: 'x' },
        },
      ],
      '/repos/storyfunnels/storypages/issues?state=all&per_page=100&page=1': [],
      '/repos/storyfunnels/storypages/pulls?state=all&per_page=100&page=1': [
        {
          number: 473,
          title: 'storypages PR',
          state: 'open',
          merged_at: null,
          html_url: 'https://github.com/storyfunnels/storypages/pull/473',
          user: { login: 'b' },
          head: { ref: 'y' },
        },
      ],
    };
    github.fetcher = async (path) => {
      if (!(path in FAKE2)) throw new Error(`unexpected path ${path}`);
      return FAKE2[path];
    };
    try {
      await inject('POST', `/workspaces/${ws3}/integrations/github`, {
        token: 'ghp_test',
        repos: ['storyfunnels/storyos', 'storyfunnels/storypages'],
      });
      const res = await inject('POST', `/workspaces/${ws3}/integrations/github/sync`);
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().pulls).toBe(2);

      const dbs = (await inject('GET', `/workspaces/${ws3}/databases`)).json();
      const pullsDb = dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests');
      const list = (await inject('GET', `/workspaces/${ws3}/databases/${pullsDb.id}/records?limit=50`)).json();
      expect(list.data).toHaveLength(2); // #473 x2 did NOT collapse into one row
      const titles = list.data.map((r: { title: string }) => r.title).sort();
      expect(titles).toEqual(['storyOS PR', 'storypages PR']);
    } finally {
      github.fetcher = original;
    }
  });
});

describe('#476 periodic reconciliation — a safety net independent of the webhook', () => {
  it('reconcileAll() syncs a workspace with repos configured, without anyone clicking Sync', async () => {
    const ws4 = (await inject('POST', '/workspaces', { name: 'Recon WS' })).json().id;
    const github = app.get(GithubService);
    const original = github.fetcher;
    const seen: string[] = [];
    github.fetcher = async (path) => {
      seen.push(path);
      return [];
    };
    try {
      await inject('POST', `/workspaces/${ws4}/integrations/github`, { token: 'ghp_test', repos: ['acme/recon'] });
      await github.reconcileAll();
      expect(seen.some((p) => p.includes('acme/recon'))).toBe(true);
    } finally {
      github.fetcher = original;
    }
  });

  it('MUST KEEP WORKING: a workspace with no repos configured is never synced', async () => {
    const ws5 = (await inject('POST', '/workspaces', { name: 'No Repos WS' })).json().id;
    const github = app.get(GithubService);
    const original = github.fetcher;
    github.fetcher = async () => {
      throw new Error('should never be called for a workspace with no repos configured');
    };
    try {
      await github.reconcileAll();
      // sync() (which reconcileAll would have called) always provisions these two
      // databases via ensurePack() — their absence proves this workspace was
      // never touched, without relying on fetcher calls from OTHER already-
      // configured workspaces this same reconcileAll() sweep also visits.
      const dbs = (await inject('GET', `/workspaces/${ws5}/databases`)).json();
      expect(dbs.find((d: { name: string }) => d.name === 'GitHub Pull Requests')).toBeUndefined();
    } finally {
      github.fetcher = original;
    }
  });
});
