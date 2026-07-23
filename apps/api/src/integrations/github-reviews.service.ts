import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { githubReviewComments } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import type { GithubAppFetcher } from './github-app.service';
import { GithubService } from './github.service';
import type { GithubConfig, GithubReviewSettingsPatch } from './github.service';

const GITHUB_API = 'https://api.github.com';
const GITHUB_GRAPHQL = 'https://api.github.com/graphql';

/** Reuses the App's `{status, json, text}` fetch surface (mirrors GithubAppFetcher)
 *  so both accept the same test shim regardless of whether the bearer is an
 *  installation token or a plain PAT — this service doesn't care which. */
export type ReviewsFetcher = GithubAppFetcher;

const defaultFetcher: ReviewsFetcher = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body });

/** One of the Reviews sidebar's three buckets (#43 AC 1). */
export type ReviewBucket = 'needs_review' | 'authored' | 'participating';

export interface ReviewListItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  author_login: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  updated_at: string;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary files or a diff GitHub declines to compute (huge files). */
  patch: string | null;
  previous_filename?: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

export interface PullDetail {
  repo: string;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  author_login: string | null;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  node_id: string;
  files: PullFile[];
  checks: CheckRun[];
}

export interface ReviewCommentRow {
  id: string;
  comment_id: string;
  in_reply_to_id: string | null;
  path: string | null;
  line: number | null;
  side: string | null;
  diff_hunk: string | null;
  author_login: string | null;
  body: string;
  reactions: Record<string, number>;
  created_at: string;
  updated_at: string;
}

/** The GitHub search-index qualifier for each bucket (#43 AC 1). `@me` needs a
 *  user-context token we don't have (App installs act as the App, not a user) —
 *  so every bucket is scoped by the reviewer's own configured login instead. */
function bucketQualifier(bucket: ReviewBucket, login: string): string {
  switch (bucket) {
    case 'needs_review':
      return `review-requested:${login}`;
    case 'authored':
      return `author:${login}`;
    case 'participating':
      return `involves:${login} -author:${login}`;
  }
}

/**
 * In-app code review (#43): the Reviews sidebar, PR detail (files + checks +
 * diff), inline comment sync, and review actions. Depends on #42/#247's GitHub
 * integration for the bearer token (installation or PAT) — this service holds
 * no credentials of its own, it only calls `GithubService.resolveToken`.
 *
 * GitHub is the source of truth for every comment and review; nothing here is
 * ever the only copy. Writes (comment, reply, react, review) POST to GitHub
 * first and cache the result; reads merge that cache with an explicit re-sync
 * (`syncComments`) or the `pull_request_review_comment` webhook event, so a
 * comment made directly on GitHub still shows up here.
 */
@Injectable()
export class GithubReviewsService {
  /** Swappable in tests — no test may reach api.github.com. */
  fetcher: ReviewsFetcher = defaultFetcher;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly github: GithubService,
  ) {}

  // ── auth plumbing ────────────────────────────────────────────────────────

  private async token(membership: Membership): Promise<{ token: string; config: GithubConfig }> {
    const config = await this.github.readConfig(membership.workspaceId);
    // enabled defaults true (DEFAULT_REVIEW_SETTINGS) — only an explicit false disables.
    if (config.reviews_settings?.enabled === false) {
      throw new UnprocessableEntityException('Code & reviews is disabled for this workspace');
    }
    const token = await this.github.resolveToken(config);
    if (!token) {
      throw new UnprocessableEntityException(
        'Connect the GitHub App or add a personal access token before using Reviews',
      );
    }
    return { token, config };
  }

  private async call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
    return this.fetcher(`${GITHUB_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'storyos',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  private async graphql(token: string, query: string, variables: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetcher(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'storyos',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  }

  // ── AC 1: Reviews sidebar ────────────────────────────────────────────────

  /**
   * PRs in one bucket, across every watched repo, via GitHub's search index.
   * Requires both a configured repo set (search needs explicit `repo:` scoping
   * — it will not search "everything this token can see") and the caller's own
   * GitHub login (#43, see UserPreferences.github — there is no per-user OAuth
   * identity to read it from).
   */
  async list(membership: Membership, bucket: ReviewBucket, login: string): Promise<ReviewListItem[]> {
    const { token, config } = await this.token(membership);
    const repos = config.repos ?? [];
    if (repos.length === 0) {
      throw new UnprocessableEntityException('Select at least one repository (GitHub settings) to list reviews');
    }
    // GitHub's search query has a practical length cap; cap the repo scope rather
    // than silently truncate mid-string.
    const scoped = repos.slice(0, 15);
    const q = [`is:pr`, bucketQualifier(bucket, login), ...scoped.map((r) => `repo:${r}`)].join(' ');
    const res = await this.call(token, 'GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=50&sort=updated`);
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`GitHub search failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as {
      items?: Array<{
        number: number;
        title: string;
        html_url: string;
        state: 'open' | 'closed';
        draft?: boolean;
        user?: { login: string } | null;
        updated_at: string;
        repository_url: string;
      }>;
    };
    return (body.items ?? []).map((item) => ({
      // repository_url is `.../repos/{owner}/{repo}` — search doesn't otherwise name the repo per-item.
      repo: item.repository_url.replace(/^.*\/repos\//, ''),
      number: item.number,
      title: item.title,
      url: item.html_url,
      author_login: item.user?.login ?? null,
      state: item.state,
      draft: Boolean(item.draft),
      updated_at: item.updated_at,
    }));
  }

  // ── AC 2: PR detail — files, checks, diff ────────────────────────────────

  async getPull(membership: Membership, owner: string, repo: string, number: number): Promise<PullDetail> {
    const { token } = await this.token(membership);
    const full = `${owner}/${repo}`;
    const pull = await this.fetchPull(token, owner, repo, number);
    const files = await this.fetchFiles(token, owner, repo, number);
    const checks = await this.fetchChecks(token, owner, repo, pull.head.sha);
    return {
      repo: full,
      number,
      title: pull.title,
      body: pull.body ?? null,
      html_url: pull.html_url,
      state: pull.state,
      draft: Boolean(pull.draft),
      merged: Boolean(pull.merged),
      mergeable: pull.mergeable ?? null,
      author_login: pull.user?.login ?? null,
      base_ref: pull.base.ref,
      head_ref: pull.head.ref,
      head_sha: pull.head.sha,
      node_id: pull.node_id,
      files,
      checks,
    };
  }

  private async fetchPull(token: string, owner: string, repo: string, number: number): Promise<RawPull> {
    const res = await this.call(token, 'GET', `/repos/${owner}/${repo}/pulls/${number}`);
    if (res.status === 404) throw new NotFoundException('Pull request not found');
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`GitHub PR fetch failed (HTTP ${res.status})`);
    }
    return (await res.json()) as RawPull;
  }

  /** Paginated (100/page, up to 1000 files — GitHub's own file cap on a diff). */
  private async fetchFiles(token: string, owner: string, repo: string, number: number): Promise<PullFile[]> {
    const out: PullFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await this.call(
        token,
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new UnprocessableEntityException(`GitHub PR files fetch failed (HTTP ${res.status})`);
      }
      const batch = (await res.json()) as RawFile[];
      for (const f of batch) {
        out.push({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
          patch: f.patch ?? null,
          previous_filename: f.previous_filename,
        });
      }
      if (batch.length < 100) break;
    }
    return out;
  }

  /** AC 2's "checks" — the modern Checks API (richer than the legacy combined-status). */
  private async fetchChecks(token: string, owner: string, repo: string, sha: string): Promise<CheckRun[]> {
    const res = await this.call(token, 'GET', `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (res.status < 200 || res.status >= 300) return []; // decoration — a flaky read shouldn't sink the whole PR view
    const body = (await res.json()) as {
      check_runs?: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null }>;
    };
    return (body.check_runs ?? []).map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
      html_url: c.html_url,
    }));
  }

  // ── AC 3: inline comments, bi-directional ────────────────────────────────

  /** The cached thread — GitHub is the source of truth, this is the fast read path. */
  async listComments(membership: Membership, repo: string, number: number): Promise<ReviewCommentRow[]> {
    // Membership is workspace-scoped by the controller guard already; scoping the
    // query by workspaceId too keeps a cross-tenant repo/number collision impossible.
    const rows = await this.db.query.githubReviewComments.findMany({
      where: and(
        eq(githubReviewComments.workspaceId, membership.workspaceId),
        eq(githubReviewComments.repo, repo),
        eq(githubReviewComments.prNumber, number),
      ),
      orderBy: [asc(githubReviewComments.githubCreatedAt)],
    });
    return rows.map(present);
  }

  /** Post a new top-level (file/line-anchored) comment, then cache it. */
  async createComment(
    membership: Membership,
    owner: string,
    repo: string,
    number: number,
    input: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string },
  ): Promise<ReviewCommentRow> {
    const { token } = await this.token(membership);
    const pull = await this.fetchPull(token, owner, repo, number);
    const res = await this.call(token, 'POST', `/repos/${owner}/${repo}/pulls/${number}/comments`, {
      body: input.body,
      commit_id: pull.head.sha,
      path: input.path,
      line: input.line,
      side: input.side,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`GitHub comment post failed (HTTP ${res.status})`);
    }
    const raw = (await res.json()) as RawComment;
    return this.upsertCached(membership.workspaceId, `${owner}/${repo}`, number, raw);
  }

  /** Reply within an existing thread — GitHub only needs the body + parent id. */
  async replyComment(
    membership: Membership,
    owner: string,
    repo: string,
    number: number,
    inReplyTo: string,
    body: string,
  ): Promise<ReviewCommentRow> {
    const { token } = await this.token(membership);
    const res = await this.call(
      token,
      'POST',
      `/repos/${owner}/${repo}/pulls/${number}/comments/${inReplyTo}/replies`,
      { body },
    );
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`GitHub reply post failed (HTTP ${res.status})`);
    }
    const raw = (await res.json()) as RawComment;
    return this.upsertCached(membership.workspaceId, `${owner}/${repo}`, number, raw);
  }

  /** React to a comment (AC 3's "reactions"); refreshes the cached count. */
  async react(
    membership: Membership,
    owner: string,
    repo: string,
    commentId: string,
    content: string,
  ): Promise<Record<string, number>> {
    const { token } = await this.token(membership);
    const res = await this.call(token, 'POST', `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`, {
      content,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`GitHub reaction failed (HTTP ${res.status})`);
    }
    const totals = await this.fetchReactionTotals(token, owner, repo, commentId);
    await this.db
      .update(githubReviewComments)
      .set({ reactions: totals })
      .where(
        and(eq(githubReviewComments.workspaceId, membership.workspaceId), eq(githubReviewComments.commentId, commentId)),
      );
    return totals;
  }

  private async fetchReactionTotals(
    token: string,
    owner: string,
    repo: string,
    commentId: string,
  ): Promise<Record<string, number>> {
    const res = await this.call(token, 'GET', `/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions?per_page=100`);
    if (res.status < 200 || res.status >= 300) return {};
    const items = (await res.json()) as Array<{ content: string }>;
    const totals: Record<string, number> = {};
    for (const r of items) totals[r.content] = (totals[r.content] ?? 0) + 1;
    return totals;
  }

  /**
   * The poll half of bi-directional sync: fetch every review comment straight
   * from GitHub and upsert the cache. Covers workspaces without (or between)
   * webhook deliveries — a manual "Refresh" the PR view can call.
   */
  async syncComments(membership: Membership, owner: string, repo: string, number: number): Promise<number> {
    const { token } = await this.token(membership);
    let synced = 0;
    for (let page = 1; page <= 10; page++) {
      const res = await this.call(
        token,
        'GET',
        `/repos/${owner}/${repo}/pulls/${number}/comments?per_page=100&page=${page}`,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new UnprocessableEntityException(`GitHub comments fetch failed (HTTP ${res.status})`);
      }
      const batch = (await res.json()) as RawComment[];
      for (const raw of batch) {
        await this.upsertCached(membership.workspaceId, `${owner}/${repo}`, number, raw);
        synced++;
      }
      if (batch.length < 100) break;
    }
    return synced;
  }

  /** Inbound path #2: called by the webhook on `pull_request_review_comment` (see github-webhook.service.ts). */
  async cacheFromWebhook(workspaceId: string, repo: string, number: number, raw: RawComment): Promise<void> {
    await this.upsertCached(workspaceId, repo, number, raw);
  }

  async deleteCached(workspaceId: string, commentId: string): Promise<void> {
    await this.db
      .delete(githubReviewComments)
      .where(and(eq(githubReviewComments.workspaceId, workspaceId), eq(githubReviewComments.commentId, commentId)));
  }

  private async upsertCached(
    workspaceId: string,
    repo: string,
    number: number,
    raw: RawComment,
  ): Promise<ReviewCommentRow> {
    const values = {
      workspaceId,
      repo,
      prNumber: number,
      commentId: String(raw.id),
      inReplyToId: raw.in_reply_to_id !== undefined && raw.in_reply_to_id !== null ? String(raw.in_reply_to_id) : null,
      path: raw.path ?? null,
      line: raw.line ?? raw.original_line ?? null,
      side: raw.side ?? null,
      diffHunk: raw.diff_hunk ?? null,
      authorLogin: raw.user?.login ?? null,
      body: raw.body,
      githubCreatedAt: raw.created_at ? new Date(raw.created_at) : null,
      githubUpdatedAt: raw.updated_at ? new Date(raw.updated_at) : null,
    };
    const [row] = await this.db
      .insert(githubReviewComments)
      .values(values)
      .onConflictDoUpdate({
        target: [githubReviewComments.workspaceId, githubReviewComments.commentId],
        set: {
          body: values.body,
          path: values.path,
          line: values.line,
          side: values.side,
          diffHunk: values.diffHunk,
          authorLogin: values.authorLogin,
          githubUpdatedAt: values.githubUpdatedAt,
        },
      })
      .returning();
    return present(row!);
  }

  // ── AC 4: Approve / Request changes / Comment ────────────────────────────

  async submitReview(
    membership: Membership,
    owner: string,
    repo: string,
    number: number,
    input: { event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body?: string },
  ): Promise<{ state: string }> {
    const { token } = await this.token(membership);
    const settings = await this.github.getReviewSettings(membership.workspaceId);

    if (settings.auto_convert_draft) {
      // Best-effort: a draft that can't be flipped ready must not block the review itself.
      await this.maybeMarkReady(token, owner, repo, number).catch(() => undefined);
    }

    const res = await this.call(token, 'POST', `/repos/${owner}/${repo}/pulls/${number}/reviews`, {
      event: input.event,
      body: input.body,
    });
    if (res.status < 200 || res.status >= 300) {
      const text = await res.text().catch(() => '');
      throw new UnprocessableEntityException(
        `GitHub review submission failed (HTTP ${res.status})${text ? `: ${text}` : ''}`,
      );
    }
    const json = (await res.json()) as { state?: string };
    return { state: json.state ?? input.event };
  }

  /** Settings AC's "auto-convert draft PRs": flip a draft PR ready via the
   *  GraphQL mutation REST has no equivalent for. Best-effort, never throws to
   *  the caller (see `submitReview`) — a stray permission error here must not
   *  block the review it was meant to unblock. */
  private async maybeMarkReady(token: string, owner: string, repo: string, number: number): Promise<void> {
    const pull = await this.fetchPull(token, owner, repo, number);
    if (!pull.draft) return;
    await this.graphql(
      token,
      `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }`,
      { id: pull.node_id },
    );
  }

  // ── Code & reviews settings (AC 5) ────────────────────────────────────────

  async getSettings(workspaceId: string) {
    return this.github.getReviewSettings(workspaceId);
  }

  async saveSettings(workspaceId: string, patch: GithubReviewSettingsPatch) {
    return this.github.saveReviewSettings(workspaceId, patch);
  }
}

function present(row: typeof githubReviewComments.$inferSelect): ReviewCommentRow {
  return {
    id: row.id,
    comment_id: row.commentId,
    in_reply_to_id: row.inReplyToId,
    path: row.path,
    line: row.line,
    side: row.side,
    diff_hunk: row.diffHunk,
    author_login: row.authorLogin,
    body: row.body,
    reactions: (row.reactions as Record<string, number>) ?? {},
    created_at: (row.githubCreatedAt ?? row.createdAt).toISOString(),
    updated_at: (row.githubUpdatedAt ?? row.updatedAt).toISOString(),
  };
}

interface RawPull {
  title: string;
  body?: string | null;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  user?: { login: string } | null;
  base: { ref: string };
  head: { ref: string; sha: string };
  node_id: string;
}

interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

/** GitHub's PR-review-comment shape (`GET/POST .../pulls/{n}/comments[...]`). */
export interface RawComment {
  id: number | string;
  in_reply_to_id?: number | string | null;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  diff_hunk?: string | null;
  user?: { login: string } | null;
  body: string;
  created_at?: string;
  updated_at?: string;
}
