import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { xEngagementProvider } from './x_engagement';
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
    auth: { auth_style: 'bearer', token: 'x-token' },
    config: { user_id: 'u1' },
    cursor: {},
    fetcher: async () => {
      throw new Error('not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

describe('xEngagementProvider', () => {
  it('emits mentions with resolved handles, permalink, and conversation as post_external_id', async () => {
    const { fetcher } = fakeFetcher({
      mentions: {
        data: [{ id: 't1', author_id: 'a1', text: 'hey @you', created_at: '2026-01-01T00:00:00Z', conversation_id: 'conv1' }],
        includes: { users: [{ id: 'a1', username: 'alice', name: 'Alice' }] },
        meta: { newest_id: 't1' },
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await xEngagementProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));

    expect(emitted).toEqual([
      {
        provider: 'x.mentions',
        kind: 'mention',
        external_id: 't1',
        author_handle: 'alice',
        author_name: 'Alice',
        text: 'hey @you',
        permalink: 'https://x.com/alice/status/t1',
        parent_external_id: null,
        post_external_id: 'conv1',
        posted_at: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(result.cursor).toEqual({ since_id: 't1' });
  });

  it('resolves user_id via /2/users/me when config omits it', async () => {
    const { fetcher, calls } = fakeFetcher({
      'users/me': { data: { id: 'uid42' } },
      mentions: { data: [], meta: {} },
    });
    await xEngagementProvider.sync(baseCtx({ fetcher, config: {} }));
    expect(calls[0]).toContain('users/me');
    expect(calls[1]).toContain('users/uid42/mentions');
  });

  it('sends since_id on the request once a cursor exists', async () => {
    const { fetcher, calls } = fakeFetcher({ mentions: { data: [], meta: {} } });
    await xEngagementProvider.sync(baseCtx({ fetcher, cursor: { since_id: 't0' } }));
    expect(calls[0]).toContain('since_id=t0');
  });

  it('walks pagination_token pages until meta.next_token runs out', async () => {
    const { fetcher, calls } = fakeFetcher({
      mentions: [
        { data: [{ id: 't2', author_id: 'a1', text: 'first page' }], includes: { users: [{ id: 'a1', username: 'a' }] }, meta: { next_token: 'p2', newest_id: 't2' } },
        { data: [{ id: 't3', author_id: 'a1', text: 'second page' }], includes: { users: [{ id: 'a1', username: 'a' }] }, meta: { newest_id: 't3' } },
      ],
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await xEngagementProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));
    expect(emitted.map((i) => i['external_id'])).toEqual(['t2', 't3']);
    expect(calls.filter((u) => u.includes('mentions'))).toHaveLength(2);
    expect(calls[1]).toContain('pagination_token=p2');
    expect(result.cursor).toEqual({ since_id: 't3' });
  });

  it('falls back to author_handle/author_name null when the tweet author is not in includes', async () => {
    const { fetcher } = fakeFetcher({
      mentions: { data: [{ id: 't1', author_id: 'unknown', text: 'x', created_at: null }], includes: { users: [] }, meta: {} },
    });
    const emitted: Array<Record<string, unknown>> = [];
    await xEngagementProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));
    expect(emitted[0]).toMatchObject({ author_handle: null, author_name: null, permalink: null, posted_at: null });
  });

  it('rejects a connection without a bearer token before any network call', async () => {
    const { fetcher, calls } = fakeFetcher({});
    await expect(xEngagementProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(calls).toHaveLength(0);
  });
});
