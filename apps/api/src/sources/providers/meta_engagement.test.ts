import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { metaEngagementProvider } from './meta_engagement';
import type { SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

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
      return { status: 200, json: async () => value[Math.min(i, value.length - 1)], text: async () => '' };
    }
    return { status: 200, json: async () => value, text: async () => '' };
  };
  return { fetcher, calls };
}

function baseCtx(overrides: Partial<SourceSyncContext> = {}): SourceSyncContext {
  return {
    auth: { auth_style: 'bearer', token: 'page-token' },
    config: { page_id: 'page1' },
    cursor: {},
    fetcher: async () => {
      throw new Error('not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

describe('metaEngagementProvider', () => {
  it('emits page comments and replies, tagging kind by parent presence', async () => {
    const { fetcher } = fakeFetcher({
      'page1/posts': {
        data: [
          {
            id: 'post1',
            comments: {
              data: [
                { id: 'c1', from: { id: 'u1', name: 'Alice' }, message: 'top', created_time: '2026-01-02T00:00:00+0000', permalink_url: 'https://fb/c1' },
                { id: 'r1', from: { id: 'u2', name: 'Bob' }, message: 'reply', created_time: '2026-01-01T00:00:00+0000', parent: { id: 'c1' } },
              ],
            },
          },
        ],
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await metaEngagementProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));

    expect(emitted).toEqual([
      {
        provider: 'meta.page_comments',
        kind: 'comment',
        external_id: 'c1',
        author_handle: null,
        author_name: 'Alice',
        text: 'top',
        permalink: 'https://fb/c1',
        parent_external_id: null,
        post_external_id: 'post1',
        posted_at: '2026-01-02T00:00:00.000Z',
      },
      {
        provider: 'meta.page_comments',
        kind: 'reply',
        external_id: 'r1',
        author_handle: null,
        author_name: 'Bob',
        text: 'reply',
        permalink: null,
        parent_external_id: 'c1',
        post_external_id: 'post1',
        posted_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(result.cursor).toEqual({ fb_watermark: '2026-01-02T00:00:00.000Z', ig_watermark: null });
  });

  it('resolves page_id via /me when config omits it', async () => {
    const { fetcher, calls } = fakeFetcher({
      me: { id: 'resolved-page' },
      'resolved-page/posts': { data: [] },
    });
    await metaEngagementProvider.sync(baseCtx({ fetcher, config: {} }));
    expect(calls[0]).toContain('/me?');
    expect(calls[1]).toContain('resolved-page/posts');
  });

  it('skips comments at or before the watermark and does not regress it', async () => {
    const { fetcher } = fakeFetcher({
      'page1/posts': {
        data: [
          {
            id: 'post1',
            comments: { data: [{ id: 'old', message: 'old', created_time: '2026-01-01T00:00:00+0000' }] },
          },
        ],
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await metaEngagementProvider.sync(
      baseCtx({ fetcher, cursor: { fb_watermark: '2026-01-01T00:00:00.000Z' }, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted).toHaveLength(0);
    expect(result.cursor).toEqual({ fb_watermark: '2026-01-01T00:00:00.000Z', ig_watermark: null });
  });

  it('walks IG media + comments when ig_user_id is configured, independent watermark', async () => {
    const { fetcher } = fakeFetcher({
      'page1/posts': { data: [] },
      'ig1/media': { data: [{ id: 'media1', permalink: 'https://instagram.com/p/media1' }] },
      'media1/comments': {
        data: [{ id: 'igc1', username: 'carol', text: 'love it', timestamp: '2026-02-01T00:00:00+0000' }],
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await metaEngagementProvider.sync(
      baseCtx({ fetcher, config: { page_id: 'page1', ig_user_id: 'ig1' }, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted).toEqual([
      {
        provider: 'meta.page_comments',
        kind: 'comment',
        external_id: 'igc1',
        author_handle: 'carol',
        author_name: null,
        text: 'love it',
        permalink: 'https://instagram.com/p/media1',
        parent_external_id: null,
        post_external_id: 'media1',
        posted_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
    expect(result.cursor).toEqual({ fb_watermark: null, ig_watermark: '2026-02-01T00:00:00.000Z' });
  });

  it('rejects a connection without a bearer token before any network call', async () => {
    const { fetcher, calls } = fakeFetcher({});
    await expect(metaEngagementProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(calls).toHaveLength(0);
  });
});
