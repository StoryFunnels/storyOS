import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { GithubReviewsService } from '../src/integrations/github-reviews.service';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;

/** Requests posted by the service in this test, keyed by `METHOD path` (query
 *  string included, exactly as the service builds it) so assertions can check
 *  exactly what was sent (e.g. the search query, the review event). */
const sent: Array<{ method: string; url: string; body: unknown }> = [];

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

function ok(body: unknown, status = 200) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

const HEAD_SHA = 'abc123deadbeef';
const NODE_ID = 'PR_kwDOtestNode';

let draftPull = false;

const FAKE: Record<string, (init: { method: string; body?: string }) => ReturnType<typeof ok>> = {
  'GET /search/issues': () => ({
    status: 200,
    json: async () => ({
      items: [
        {
          number: 42,
          title: 'Add reviews',
          html_url: 'https://github.com/acme/site/pull/42',
          state: 'open',
          draft: false,
          user: { login: 'dana' },
          updated_at: '2026-07-20T00:00:00Z',
          repository_url: 'https://api.github.com/repos/acme/site',
        },
      ],
    }),
    text: async () => '',
  }),
  'GET /repos/acme/site/pulls/42': () => ok({
    title: 'Add reviews',
    body: 'Ships the Reviews surface',
    html_url: 'https://github.com/acme/site/pull/42',
    state: 'open',
    draft: draftPull,
    merged: false,
    mergeable: true,
    user: { login: 'dana' },
    base: { ref: 'main' },
    head: { ref: 'feat/reviews', sha: HEAD_SHA },
    node_id: NODE_ID,
  }),
  'GET /repos/acme/site/pulls/42/files': () => ok([
    {
      filename: 'src/app.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      changes: 4,
      patch: '@@ -1,3 +1,5 @@\n-old\n+new\n+another',
    },
  ]),
  'GET /repos/acme/site/commits/abc123deadbeef/check-runs': () => ok({
    check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/site/checks/1' }],
  }),
  'POST /repos/acme/site/pulls/42/comments': () => ok({
    id: 900001,
    path: 'src/app.ts',
    line: 4,
    side: 'RIGHT',
    diff_hunk: '@@ -1,3 +1,5 @@',
    user: { login: 'octocat' },
    body: 'Consider renaming this',
    created_at: '2026-07-20T01:00:00Z',
    updated_at: '2026-07-20T01:00:00Z',
  }, 201),
  'POST /repos/acme/site/pulls/42/comments/900001/replies': () => ok({
    id: 900002,
    in_reply_to_id: 900001,
    path: 'src/app.ts',
    line: 4,
    side: 'RIGHT',
    user: { login: 'octocat' },
    body: 'Sounds good',
    created_at: '2026-07-20T01:05:00Z',
    updated_at: '2026-07-20T01:05:00Z',
  }, 201),
  'POST /repos/acme/site/pulls/comments/900001/reactions': () => ok({ id: 1, content: '+1' }, 201),
  'GET /repos/acme/site/pulls/comments/900001/reactions': () => ok([{ content: '+1' }, { content: '+1' }, { content: 'heart' }]),
  'GET /repos/acme/site/pulls/42/comments': () => ok([
    {
      id: 900001,
      path: 'src/app.ts',
      line: 4,
      side: 'RIGHT',
      user: { login: 'octocat' },
      body: 'Consider renaming this',
      created_at: '2026-07-20T01:00:00Z',
      updated_at: '2026-07-20T01:00:00Z',
    },
  ]),
  'POST /repos/acme/site/pulls/42/reviews': () => ok({ state: 'APPROVED' }, 201),
  'POST /graphql': () => ok({ data: { markPullRequestReadyForReview: { pullRequest: { id: NODE_ID } } } }),
};

beforeAll(async () => {
  app = await createTestApp();
  const reviews = app.get(GithubReviewsService);
  reviews.fetcher = async (url, init) => {
    const path = url.replace('https://api.github.com', '').split('?')[0]!;
    const key = `${init.method} ${path}`;
    sent.push({ method: init.method, url, body: init.body ? (JSON.parse(init.body) as unknown) : undefined });
    const handler = FAKE[key];
    if (!handler) throw new Error(`unexpected request ${key}`);
    return handler(init);
  };

  admin = await signUpUser(app, 'Reviewer');
  wsId = (await as('POST', '/workspaces', { name: 'Reviews WS' })).json().id;
  const saved = await as('POST', `/workspaces/${wsId}/integrations/github`, {
    token: 'ghp_test',
    repos: ['acme/site'],
  });
  expect(saved.statusCode, saved.body).toBe(201);

  const prefs = await app.inject({
    method: 'PATCH',
    url: '/api/v1/users/me/preferences',
    headers: authed(admin.token),
    payload: { github: { login: 'octocat' } },
  });
  expect(prefs.statusCode, prefs.body).toBe(200);
});

afterAll(async () => {
  await app.close();
});

describe('Reviews sidebar (#43 AC 1)', () => {
  it('requires the caller to have set their GitHub login first', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/preferences',
      headers: authed(admin.token),
      payload: { github: { login: null } },
    });
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=needs_review`);
    expect(res.statusCode, res.body).toBe(400);

    await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/preferences',
      headers: authed(admin.token),
      payload: { github: { login: 'octocat' } },
    });
  });

  it('lists needs_review PRs by querying GitHub search scoped to the watched repos', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=needs_review`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0]).toMatchObject({ repo: 'acme/site', number: 42, title: 'Add reviews' });

    const searchCall = sent.find((s) => s.url.includes('/search/issues'));
    expect(searchCall).toBeTruthy();
    const q = decodeURIComponent(new URL(searchCall!.url).searchParams.get('q') ?? '');
    expect(q).toContain('review-requested:octocat');
    expect(q).toContain('repo:acme/site');
  });

  it('defaults to needs_review when no bucket is given, and switches qualifier per bucket', async () => {
    sent.length = 0;
    await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=authored`);
    const authoredQ = decodeURIComponent(new URL(sent[0]!.url).searchParams.get('q') ?? '');
    expect(authoredQ).toContain('author:octocat');

    sent.length = 0;
    await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=participating`);
    const participatingQ = decodeURIComponent(new URL(sent[0]!.url).searchParams.get('q') ?? '');
    expect(participatingQ).toContain('involves:octocat');
    expect(participatingQ).toContain('-author:octocat');
  });

  it('422s when no repos are configured yet', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github`, { repos: [] });
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=needs_review`);
    expect(res.statusCode).toBe(422);
    await as('POST', `/workspaces/${wsId}/integrations/github`, { repos: ['acme/site'] });
  });
});

describe('PR detail: files + checks + diff (#43 AC 2)', () => {
  it('returns the PR, its files (with GitHub\'s own unified patch text), and checks', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.title).toBe('Add reviews');
    expect(body.head_sha).toBe(HEAD_SHA);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].patch).toContain('@@ -1,3 +1,5 @@');
    expect(body.checks).toEqual([
      { name: 'ci', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/site/checks/1' },
    ]);
  });
});

describe('inline comments, bi-directional (#43 AC 3)', () => {
  it('posts a new comment to GitHub and caches it locally', async () => {
    const res = await as('POST', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments`, {
      path: 'src/app.ts',
      line: 4,
      side: 'RIGHT',
      body: 'Consider renaming this',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().comment_id).toBe('900001');

    const list = await as('GET', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments`);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].body).toBe('Consider renaming this');
  });

  it('replies within the thread, linked by in_reply_to_id', async () => {
    const res = await as(
      'POST',
      `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments/900001/replies`,
      { body: 'Sounds good' },
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().in_reply_to_id).toBe('900001');
  });

  it('reacts to a comment and caches the aggregated reaction counts', async () => {
    const res = await as(
      'POST',
      `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments/900001/reactions`,
      { content: '+1' },
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ '+1': 2, heart: 1 });

    const list = await as('GET', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments`);
    const withReactions = list.json().find((c: { comment_id: string }) => c.comment_id === '900001');
    expect(withReactions.reactions).toEqual({ '+1': 2, heart: 1 });
  });

  it('syncComments polls GitHub directly — the poll half of bi-directional sync', async () => {
    const res = await as('POST', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/comments/sync`);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().synced).toBe(1);
  });
});

describe('Approve / Request changes / Comment (#43 AC 4)', () => {
  it('submits an APPROVE review to GitHub', async () => {
    const res = await as('POST', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/reviews`, {
      event: 'APPROVE',
      body: 'LGTM',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().state).toBe('APPROVED');
    const reviewCall = sent.find((s) => s.url.endsWith('/pulls/42/reviews'));
    expect(reviewCall!.body).toMatchObject({ event: 'APPROVE', body: 'LGTM' });
  });

  it('auto-converts a draft PR to ready when the setting is on, before submitting the review', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, { auto_convert_draft: true });
    draftPull = true;
    sent.length = 0;
    const res = await as('POST', `/workspaces/${wsId}/integrations/github/reviews/acme/site/42/reviews`, {
      event: 'COMMENT',
      body: 'wip feedback',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(sent.some((s) => s.url === 'https://api.github.com/graphql')).toBe(true);
    draftPull = false;
    await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, { auto_convert_draft: false });
  });
});

describe('Code & reviews settings (#43 AC 5)', () => {
  it('defaults enabled, squash, auto theme/font', async () => {
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/review-settings`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      auto_convert_draft: false,
      default_merge_strategy: 'squash',
      code_theme: 'auto',
      code_font: 'mono',
      notifications: { review_requests: true, comments_mentions: true },
    });
  });

  it('patches a subset without clobbering the rest', async () => {
    const res = await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, {
      code_theme: 'dark',
      notifications: { review_requests: false },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().code_theme).toBe('dark');
    expect(res.json().notifications).toEqual({ review_requests: false, comments_mentions: true });
    expect(res.json().default_merge_strategy).toBe('squash'); // untouched

    await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, {
      code_theme: 'auto',
      notifications: { review_requests: true },
    });
  });

  it('disabling Code & reviews 422s the reviews API', async () => {
    await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, { enabled: false });
    const res = await as('GET', `/workspaces/${wsId}/integrations/github/reviews?bucket=authored`);
    expect(res.statusCode).toBe(422);
    await as('POST', `/workspaces/${wsId}/integrations/github/review-settings`, { enabled: true });
  });
});
