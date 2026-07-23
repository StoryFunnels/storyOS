import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { ConnectionsService } from '../src/connections/connections.service';
import { SourcesService } from '../src/sources/sources.service';
import type { ConnectionFetcher } from '../src/connections/providers';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { sources as sourcesTable } from '../src/db/schema';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let connections: ConnectionsService;
let sourcesService: SourcesService;
let db: Db;

/** Canned YouTube API responses, keyed by which endpoint the URL hits — swaps
 * in for a real network call exactly like connections.test.ts's fetcher. */
let commentPages: Array<Record<string, unknown>> = [];
let commentPageIndex = 0;

async function inject(method: string, url: string, payload?: unknown, token = admin.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

/** Creates a fresh database + fields + a "google" connection, ready for a
 * youtube.comments source. Returns everything a test needs by id/api_name. */
async function setupDatabaseAndConnection(label: string) {
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: `${label} DB` })).json()
    .id;

  const field = async (display_name: string, type: string, config: Record<string, unknown> = {}) => {
    const res = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name, type, config });
    const body = res.json();
    return { id: body.id as string, apiName: body.apiName as string };
  };
  const commentId = await field('Comment Id', 'text');
  const videoId = await field('Video Id', 'text');
  const author = await field('Author', 'text');
  const text = await field('Text', 'text');
  const likeCount = await field('Likes', 'number');
  const publishedAt = await field('Published At', 'text');
  const isReply = await field('Is Reply', 'checkbox');
  const permalink = await field('Permalink', 'url');
  const replyDraft = await field('Reply Draft', 'text'); // deliberately UNMAPPED

  // OAuth connect (google is oauth2-only — mirrors connections.test.ts's refresh-loop test).
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
  const start = await inject('GET', `/workspaces/${wsId}/connections/oauth/google/start`);
  const state = new URL(String(start.headers.location)).searchParams.get('state')!;
  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/connections/oauth/callback?state=${encodeURIComponent(state)}&code=good-code-${label}`,
  });
  expect(callback.statusCode).toBe(302);
  const connectionId = (await inject('GET', `/workspaces/${wsId}/connections`)).json().data.find(
    (c: { provider: string; name: string }) => c.provider === 'google',
  ).id;

  const fieldMapping: Record<string, string> = {
    comment_id: commentId.id,
    video_id: videoId.id,
    author_name: author.id,
    text: text.id,
    like_count: likeCount.id,
    published_at: publishedAt.id,
    is_reply: isReply.id,
    permalink: permalink.id,
  };

  const created = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources`, {
    name: `${label} comments`,
    connection_id: connectionId,
    provider_source: 'youtube.comments',
    config: {},
    field_mapping: fieldMapping,
    external_key_field_id: commentId.id,
    schedule: '15m',
  });
  expect(created.statusCode, `source create failed: ${created.body}`).toBe(201);

  return { dbId, connectionId, sourceId: created.json().id as string, commentId, replyDraft, likeCount };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'SourcesAdmin');
  wsId = (await inject('POST', '/workspaces', { name: 'Sources WS' })).json().id;

  connections = app.get(ConnectionsService);
  sourcesService = app.get(SourcesService);
  db = app.get(DB);

  // The OAuth token exchange + channel-id resolution both go through
  // connectionsService.fetcher / sourcesService.fetcher respectively — the
  // OAuth callback always calls the (google) token endpoint, so route that
  // one call through connections' fetcher; every YouTube Data API call goes
  // through sources' fetcher, driven by `commentPages`.
  const oauthFetcher: ConnectionFetcher = async () => ({
    status: 200,
    json: async () => ({ access_token: 'ya29.test', refresh_token: 'refresh-1', expires_in: 3600 * 24 * 365 }),
    text: async () => '',
  });
  connections.fetcher = oauthFetcher;

  const youtubeFetcher: ConnectionFetcher = async (url) => {
    if (url.includes('/channels')) {
      return { status: 200, json: async () => ({ items: [{ id: 'UC_test_channel' }] }), text: async () => '' };
    }
    if (url.includes('/commentThreads')) {
      const page = commentPages[commentPageIndex] ?? { items: [] };
      commentPageIndex += 1;
      return { status: 200, json: async () => page, text: async () => '' };
    }
    throw new Error(`unexpected YouTube URL in test: ${url}`);
  };
  sourcesService.fetcher = youtubeFetcher;
});

afterAll(async () => {
  await app.close();
});

function thread(id: string, videoId: string, publishedAt: string, text = 'hello', likeCount = 1) {
  return {
    id: `thread_${id}`,
    snippet: {
      videoId,
      topLevelComment: {
        id,
        snippet: {
          authorDisplayName: 'Some Author',
          textDisplay: text,
          likeCount,
          publishedAt,
        },
      },
    },
  };
}

describe('sources framework — YouTube comments (#239)', () => {
  it('upsert idempotency: syncing the same batch twice creates 0 duplicate records', async () => {
    commentPages = [{ items: [thread('c1', 'v1', '2026-01-01T00:00:00Z'), thread('c2', 'v1', '2026-01-02T00:00:00Z')] }];
    commentPageIndex = 0;
    const { dbId, sourceId } = await setupDatabaseAndConnection('Idempotency');

    const first = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(first.statusCode, `sync-now failed: ${first.body}`).toBe(201);
    expect(first.json()).toEqual(expect.objectContaining({ status: 'ok', fetched: 2, created: 2, updated: 0 }));

    const afterFirst = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(afterFirst).toHaveLength(2);

    // Re-run with the SAME page (cursor watermark now sits at c2's publishedAt,
    // so the provider itself sees nothing newer — 0 fetched, 0 created).
    commentPageIndex = 0;
    const second = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(expect.objectContaining({ status: 'ok', fetched: 0, created: 0, updated: 0 }));

    const afterSecond = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(afterSecond).toHaveLength(2); // still exactly 2 — no duplicates
  });

  it('unmapped-field preservation: an agent-written field survives a resync untouched', async () => {
    commentPages = [{ items: [thread('c10', 'v9', '2026-02-01T00:00:00Z', 'first pass text', 5)] }];
    commentPageIndex = 0;
    const { dbId, sourceId, replyDraft, likeCount } = await setupDatabaseAndConnection('UnmappedField');

    const first = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(first.json()).toEqual(expect.objectContaining({ status: 'ok', created: 1 }));

    const records = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(records).toHaveLength(1);
    const recordId = records[0].id;

    // A human/agent writes the UNMAPPED field.
    const patch = await inject('PATCH', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`, {
      values: { [replyDraft.apiName]: 'Thanks for watching!' },
    });
    expect(patch.statusCode).toBe(200);

    // Provider re-emits the SAME comment with an updated like_count — the
    // mapped field must change, the unmapped one must not.
    commentPages = [{ items: [thread('c10', 'v9', '2026-02-01T00:00:00Z', 'first pass text', 42)] }];
    // Force a resync of the same comment: reset the source's cursor watermark
    // directly (a real second cycle would otherwise skip an already-seen
    // comment via the watermark — this test's point is the field-preservation
    // invariant on the UPDATE path itself, which the idempotency test above
    // doesn't exercise since it never resends an already-synced item).
    await db.update(sourcesTable).set({ cursor: {} }).where(eq(sourcesTable.id, sourceId));
    commentPageIndex = 0;

    const second = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(second.json()).toEqual(expect.objectContaining({ status: 'ok', fetched: 1, created: 0, updated: 1 }));

    const afterResync = (
      await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${recordId}`)
    ).json();
    expect(afterResync.values[replyDraft.apiName]).toBe('Thanks for watching!'); // untouched
    expect(afterResync.values[likeCount.apiName]).toBe(42); // the mapped field DID update
  });

  it('cursor incrementality: a later cycle only fetches comments newer than the watermark', async () => {
    commentPages = [{ items: [thread('c20', 'v1', '2026-03-01T00:00:00Z')] }];
    commentPageIndex = 0;
    const { dbId, sourceId } = await setupDatabaseAndConnection('CursorIncrementality');

    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    const runsAfterFirst = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/runs`)).json()
      .data;
    expect(runsAfterFirst[0]).toEqual(expect.objectContaining({ status: 'ok', fetched: 1, created: 1 }));

    // Next cycle's page has the OLD comment (stale, before the watermark) AND
    // one genuinely new comment — order=time means newest-first, so the
    // provider must stop at the watermark and never re-emit the stale one.
    commentPages = [{ items: [thread('c21', 'v1', '2026-03-02T00:00:00Z'), thread('c20', 'v1', '2026-03-01T00:00:00Z')] }];
    commentPageIndex = 0;
    const second = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(second.json()).toEqual(expect.objectContaining({ status: 'ok', fetched: 1, created: 1, updated: 0 }));

    const all = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(all).toHaveLength(2);
  });

  it('connection deleted → source flips to error status, notifies, and never syncs data', async () => {
    commentPages = [{ items: [thread('c30', 'v1', '2026-04-01T00:00:00Z')] }];
    commentPageIndex = 0;
    const { dbId, sourceId, connectionId } = await setupDatabaseAndConnection('ConnDeleted');

    await inject('DELETE', `/workspaces/${wsId}/connections/${connectionId}`);

    const run = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(run.json()).toEqual(expect.objectContaining({ status: 'error' }));

    const listed = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/sources`)).json().data;
    expect(listed.find((s: { id: string }) => s.id === sourceId).status).toBe('error');

    const recs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(recs).toHaveLength(0);

    const notifs = await inject('GET', `/workspaces/${wsId}/notifications?type=connection_error`);
    expect(
      notifs.json().data.some((n: { type: string; snippet: string }) => n.snippet?.includes(`ConnDeleted comments`)),
    ).toBe(true);
  });

  it('deleting a source stops syncing but leaves its records intact', async () => {
    commentPages = [{ items: [thread('c40', 'v1', '2026-05-01T00:00:00Z')] }];
    commentPageIndex = 0;
    const { dbId, sourceId } = await setupDatabaseAndConnection('DeleteSource');

    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    const before = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(before).toHaveLength(1);

    const del = await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}`);
    expect(del.statusCode).toBe(200);

    const listed = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/sources`)).json().data;
    expect(listed.find((s: { id: string }) => s.id === sourceId)).toBeUndefined();

    const after = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(after).toHaveLength(1); // the record the (now-deleted) source created is untouched
  });

  it('skipped_quota: a cycle that would exceed the daily budget is skipped, not silently run', async () => {
    commentPages = [{ items: [thread('c50', 'v1', '2026-06-01T00:00:00Z')] }];
    commentPageIndex = 0;
    const { dbId, sourceId, connectionId } = await setupDatabaseAndConnection('QuotaSkip');

    // Exhaust today's real (cached) budget directly through the guard itself —
    // exercises the exact function SourcesService.runOne consumes from,
    // without needing to reach into process env after boot.
    const { env } = await import('../src/config/env');
    const dailyBudget = env().YOUTUBE_DAILY_QUOTA_UNITS;
    const consumed = await connections.checkAndConsumeQuota(connectionId, dailyBudget, dailyBudget);
    expect(consumed).toBe(true);

    const run = await inject('POST', `/workspaces/${wsId}/databases/${dbId}/sources/${sourceId}/sync-now`);
    expect(run.json()).toEqual(expect.objectContaining({ status: 'skipped_quota', fetched: 0, created: 0, updated: 0 }));

    const recs = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records?limit=200`)).json().data;
    expect(recs).toHaveLength(0); // the guard fired BEFORE any network call, not after
  });

  it('checkAndConsumeQuota: allows under budget, denies once it would exceed it', async () => {
    const { dbId, connectionId } = await setupDatabaseAndConnection('QuotaGuardUnit');
    void dbId;

    expect(await connections.checkAndConsumeQuota(connectionId, 5, 10)).toBe(true); // 5/10
    expect(await connections.checkAndConsumeQuota(connectionId, 4, 10)).toBe(true); // 9/10
    expect(await connections.checkAndConsumeQuota(connectionId, 2, 10)).toBe(false); // would be 11/10 — denied
    expect(await connections.checkAndConsumeQuota(connectionId, 1, 10)).toBe(true); // 10/10 exactly — allowed
    expect(await connections.checkAndConsumeQuota(connectionId, 1, 10)).toBe(false); // now truly full
  });
});
