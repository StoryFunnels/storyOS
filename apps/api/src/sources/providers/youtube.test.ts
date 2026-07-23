import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { youtubeCommentsProvider, youtubeMetricsProvider, youtubeVideosProvider } from './youtube';
import type { SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

/** Routes canned JSON by which YouTube endpoint a URL hits — no real network. */
function fakeFetcher(routes: Record<string, unknown | unknown[]>): { fetcher: ConnectionFetcher; calls: string[] } {
  const calls: string[] = [];
  const cursors = new Map<string, number>();
  const fetcher: ConnectionFetcher = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`no route for ${url}`);
    const value = routes[key];
    if (Array.isArray(value)) {
      const i = cursors.get(key) ?? 0;
      cursors.set(key, i + 1);
      const body = value[Math.min(i, value.length - 1)];
      return { status: 200, json: async () => body, text: async () => '' };
    }
    return { status: 200, json: async () => value, text: async () => '' };
  };
  return { fetcher, calls };
}

function baseCtx(overrides: Partial<SourceSyncContext> = {}): SourceSyncContext {
  return {
    auth: { access_token: 'ya29.test' },
    config: {},
    cursor: {},
    fetcher: async () => {
      throw new Error('fetcher not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

describe('youtubeVideosProvider', () => {
  it('resolves the uploads playlist, walks pages, and emits upsert-ready items', async () => {
    const { fetcher } = fakeFetcher({
      '/channels': { items: [{ contentDetails: { relatedPlaylists: { uploads: 'PL_uploads' } } }] },
      '/playlistItems': { items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] },
      '/videos': {
        items: [
          { id: 'v1', snippet: { title: 'Video 1', publishedAt: '2026-01-01T00:00:00Z' }, contentDetails: { duration: 'PT1M' }, status: { privacyStatus: 'public' } },
          { id: 'v2', snippet: { title: 'Video 2', publishedAt: '2026-01-02T00:00:00Z' }, contentDetails: { duration: 'PT2M' }, status: { privacyStatus: 'unlisted' } },
        ],
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await youtubeVideosProvider.sync(
      baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted).toEqual([
      { video_id: 'v1', title: 'Video 1', published_at: '2026-01-01T00:00:00Z', duration: 'PT1M', privacy: 'public', url: 'https://www.youtube.com/watch?v=v1' },
      { video_id: 'v2', title: 'Video 2', published_at: '2026-01-02T00:00:00Z', duration: 'PT2M', privacy: 'unlisted', url: 'https://www.youtube.com/watch?v=v2' },
    ]);
    expect(result.cursor).toEqual({ page_token: null });
  });

  it('walks multiple playlistItems pages until nextPageToken runs out', async () => {
    const { fetcher, calls } = fakeFetcher({
      '/channels': { items: [{ contentDetails: { relatedPlaylists: { uploads: 'PL_uploads' } } }] },
      '/playlistItems': [
        { items: [{ contentDetails: { videoId: 'v1' } }], nextPageToken: 'page2' },
        { items: [{ contentDetails: { videoId: 'v2' } }] },
      ],
      '/videos': [
        { items: [{ id: 'v1', snippet: {}, contentDetails: {}, status: {} }] },
        { items: [{ id: 'v2', snippet: {}, contentDetails: {}, status: {} }] },
      ],
    });
    const emitted: Array<Record<string, unknown>> = [];
    await youtubeVideosProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));
    expect(emitted.map((i) => i['video_id'])).toEqual(['v1', 'v2']);
    expect(calls.filter((u) => u.includes('/playlistItems'))).toHaveLength(2);
  });

  it('uses config.channel_id instead of mine=true when provided', async () => {
    const { fetcher, calls } = fakeFetcher({
      '/channels': { items: [{ contentDetails: { relatedPlaylists: { uploads: 'PL_x' } } }] },
      '/playlistItems': { items: [] },
    });
    await youtubeVideosProvider.sync(baseCtx({ fetcher, config: { channel_id: 'UC123' } }));
    expect(calls[0]).toContain('id=UC123');
    expect(calls[0]).not.toContain('mine=true');
  });
});

describe('youtubeCommentsProvider', () => {
  it('emits top-level comments and replies, tracking the max published_at as the new watermark', async () => {
    const { fetcher } = fakeFetcher({
      '/channels': { items: [{ id: 'UC_channel' }] },
      '/commentThreads': {
        items: [
          {
            id: 'thread_1',
            snippet: {
              videoId: 'v1',
              topLevelComment: {
                id: 'c1',
                snippet: { authorDisplayName: 'A', textDisplay: 'hi', likeCount: 3, publishedAt: '2026-01-02T00:00:00Z' },
              },
            },
            replies: {
              comments: [
                { id: 'r1', snippet: { authorDisplayName: 'B', textDisplay: 'reply', likeCount: 0, publishedAt: '2026-01-01T00:00:00Z' } },
              ],
            },
          },
        ],
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await youtubeCommentsProvider.sync(
      baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted).toEqual([
      {
        comment_id: 'c1',
        video_id: 'v1',
        author_name: 'A',
        text: 'hi',
        like_count: 3,
        published_at: '2026-01-02T00:00:00Z',
        is_reply: false,
        permalink: 'https://www.youtube.com/watch?v=v1&lc=c1',
      },
      {
        comment_id: 'r1',
        video_id: 'v1',
        author_name: 'B',
        text: 'reply',
        like_count: 0,
        published_at: '2026-01-01T00:00:00Z',
        is_reply: true,
        permalink: 'https://www.youtube.com/watch?v=v1&lc=r1',
      },
    ]);
    expect(result.cursor).toEqual({ watermark: '2026-01-02T00:00:00Z' });
  });

  it('stops walking once it reaches an item at or before the watermark', async () => {
    const { fetcher, calls } = fakeFetcher({
      '/channels': { items: [{ id: 'UC_channel' }] },
      '/commentThreads': [
        {
          items: [
            { id: 't2', snippet: { videoId: 'v1', topLevelComment: { id: 'c2', snippet: { publishedAt: '2026-01-03T00:00:00Z', textDisplay: 'new' } } } },
            { id: 't1', snippet: { videoId: 'v1', topLevelComment: { id: 'c1', snippet: { publishedAt: '2026-01-01T00:00:00Z', textDisplay: 'old' } } } },
          ],
          nextPageToken: 'should-never-be-followed',
        },
      ],
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await youtubeCommentsProvider.sync(
      baseCtx({ fetcher, cursor: { watermark: '2026-01-01T00:00:00Z' }, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted.map((i) => i['comment_id'])).toEqual(['c2']); // c1 is at the watermark — excluded
    expect(calls.filter((u) => u.includes('/commentThreads'))).toHaveLength(1); // never followed nextPageToken
    expect(result.cursor).toEqual({ watermark: '2026-01-03T00:00:00Z' });
  });
});

describe('youtubeMetricsProvider', () => {
  it('snapshots statistics for explicit config.video_ids', async () => {
    const { fetcher } = fakeFetcher({
      '/videos': { items: [{ id: 'v1', statistics: { viewCount: '100', likeCount: '10', commentCount: '2' } }] },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await youtubeMetricsProvider.sync(
      baseCtx({ fetcher, config: { video_ids: ['v1'] }, emit: async (items) => void emitted.push(...items) }),
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(emitted).toEqual([{ snapshot_id: `v1:${today}`, video_id: 'v1', date: today, views: 100, likes: 10, comments: 2 }]);
    expect(result.cursor).toEqual({ last_snapshot_date: today });
  });

  it('resolves video ids from a paired source via lookupSourceKeys when video_ids is absent', async () => {
    const { fetcher } = fakeFetcher({
      '/videos': { items: [{ id: 'v9', statistics: { viewCount: '1', likeCount: '0', commentCount: '0' } }] },
    });
    const emitted: Array<Record<string, unknown>> = [];
    await youtubeMetricsProvider.sync(
      baseCtx({
        fetcher,
        config: { paired_source_id: 'some-source-id' },
        lookupSourceKeys: async (id) => (id === 'some-source-id' ? ['v9'] : []),
        emit: async (items) => void emitted.push(...items),
      }),
    );
    expect(emitted.map((i) => i['video_id'])).toEqual(['v9']);
  });

  it('no-ops (0 calls) when there are no video ids at all', async () => {
    const { fetcher, calls } = fakeFetcher({ '/videos': { items: [] } });
    const result = await youtubeMetricsProvider.sync(baseCtx({ fetcher, cursor: { some: 'state' } }));
    expect(calls).toHaveLength(0);
    expect(result.cursor).toEqual({ some: 'state' }); // cursor round-trips unchanged
  });
});

describe('accessTokenOf via healthCheck-adjacent errors', () => {
  it('every provider rejects a connection with no access_token, before any network call', async () => {
    const { fetcher, calls } = fakeFetcher({});
    await expect(youtubeVideosProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(youtubeCommentsProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    await expect(
      youtubeMetricsProvider.sync(baseCtx({ fetcher, auth: {}, config: { video_ids: ['v1'] } })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls).toHaveLength(0);
  });
});
