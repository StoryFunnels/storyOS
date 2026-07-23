import { UnprocessableEntityException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../config/env';

vi.mock('../../config/env', () => ({ env: vi.fn() }));

import { env } from '../../config/env';
import { linkedinEngagementProvider } from './linkedin_engagement';
import type { SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

const mockEnv = vi.mocked(env);

function envWith(overrides: Partial<Env>): Env {
  return { LINKEDIN_ACTIONS_ENABLED: false, ...overrides } as Env;
}

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
    auth: { auth_style: 'bearer', token: 'li-token' },
    config: { post_urns: ['urn:li:share:1'] },
    cursor: {},
    fetcher: async () => {
      throw new Error('not stubbed');
    },
    emit: async () => undefined,
    lookupSourceKeys: async () => [],
    ...overrides,
  };
}

describe('linkedinEngagementProvider', () => {
  beforeEach(() => {
    mockEnv.mockReset();
  });

  it('refuses to sync while LINKEDIN_ACTIONS_ENABLED is off — no network call at all', async () => {
    mockEnv.mockReturnValue(envWith({ LINKEDIN_ACTIONS_ENABLED: false }));
    const { fetcher, calls } = fakeFetcher({});
    await expect(linkedinEngagementProvider.sync(baseCtx({ fetcher }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(calls).toHaveLength(0);
  });

  it('when enabled, emits comments/replies per configured post_urn with per-urn watermarks', async () => {
    mockEnv.mockReturnValue(envWith({ LINKEDIN_ACTIONS_ENABLED: true }));
    const { fetcher } = fakeFetcher({
      socialActions: {
        elements: [
          { id: 'lc1', message: { text: 'top comment' }, created: { time: 1735689600000 } },
          { id: 'lc2', message: { text: 'a reply' }, created: { time: 1735776000000 }, parentComment: 'lc1' },
        ],
        paging: { total: 2 },
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await linkedinEngagementProvider.sync(baseCtx({ fetcher, emit: async (items) => void emitted.push(...items) }));

    expect(emitted).toEqual([
      {
        provider: 'linkedin.org_engagement',
        kind: 'comment',
        external_id: 'lc1',
        author_handle: null,
        author_name: null,
        text: 'top comment',
        permalink: null,
        parent_external_id: null,
        post_external_id: 'urn:li:share:1',
        posted_at: new Date(1735689600000).toISOString(),
      },
      {
        provider: 'linkedin.org_engagement',
        kind: 'reply',
        external_id: 'lc2',
        author_handle: null,
        author_name: null,
        text: 'a reply',
        permalink: null,
        parent_external_id: 'lc1',
        post_external_id: 'urn:li:share:1',
        posted_at: new Date(1735776000000).toISOString(),
      },
    ]);
    expect(result.cursor).toEqual({
      watermarks: { 'urn:li:share:1': new Date(1735776000000).toISOString() },
    });
  });

  it('skips elements at or before that post_urn\'s stored watermark', async () => {
    mockEnv.mockReturnValue(envWith({ LINKEDIN_ACTIONS_ENABLED: true }));
    const oldIso = new Date(1735689600000).toISOString();
    const { fetcher } = fakeFetcher({
      socialActions: {
        elements: [{ id: 'lc1', message: { text: 'old' }, created: { time: 1735689600000 } }],
        paging: { total: 1 },
      },
    });
    const emitted: Array<Record<string, unknown>> = [];
    const result = await linkedinEngagementProvider.sync(
      baseCtx({ fetcher, cursor: { watermarks: { 'urn:li:share:1': oldIso } }, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted).toHaveLength(0);
    expect(result.cursor).toEqual({ watermarks: { 'urn:li:share:1': oldIso } });
  });

  it('walks multiple configured post_urns independently', async () => {
    mockEnv.mockReturnValue(envWith({ LINKEDIN_ACTIONS_ENABLED: true }));
    const { fetcher, calls } = fakeFetcher({
      'share%3A1': { elements: [{ id: 'a1', message: { text: 'from post 1' }, created: { time: 1735689600000 } }], paging: { total: 1 } },
      'share%3A2': { elements: [{ id: 'b1', message: { text: 'from post 2' }, created: { time: 1735689600000 } }], paging: { total: 1 } },
    });
    const emitted: Array<Record<string, unknown>> = [];
    await linkedinEngagementProvider.sync(
      baseCtx({ fetcher, config: { post_urns: ['urn:li:share:1', 'urn:li:share:2'] }, emit: async (items) => void emitted.push(...items) }),
    );
    expect(emitted.map((i) => i['post_external_id'])).toEqual(['urn:li:share:1', 'urn:li:share:2']);
    expect(calls).toHaveLength(2);
  });

  it('rejects a connection without a bearer token before any network call, even when enabled', async () => {
    mockEnv.mockReturnValue(envWith({ LINKEDIN_ACTIONS_ENABLED: true }));
    const { fetcher, calls } = fakeFetcher({});
    await expect(linkedinEngagementProvider.sync(baseCtx({ fetcher, auth: {} }))).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(calls).toHaveLength(0);
  });
});
