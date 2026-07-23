import { describe, expect, it, vi } from 'vitest';

// Only linkedin_engagement.ts reads env() (its LINKEDIN_ACTIONS_ENABLED gate) —
// mocked true here so all three providers can run through the same
// conformance loop without the gate getting in the way.
vi.mock('../../config/env', () => ({ env: vi.fn(() => ({ LINKEDIN_ACTIONS_ENABLED: true })) }));

import { assertEngagementShape } from './engagement';
import { metaEngagementProvider } from './meta_engagement';
import { xEngagementProvider } from './x_engagement';
import { linkedinEngagementProvider } from './linkedin_engagement';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';
import type { ConnectionFetcher } from '../../connections/providers/types';

function fakeFetcher(routes: Record<string, unknown>): ConnectionFetcher {
  return async (url) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) throw new Error(`no route for ${url}`);
    return { status: 200, json: async () => routes[key], text: async () => '' };
  };
}

function baseCtx(overrides: Partial<SourceSyncContext> = {}): SourceSyncContext {
  return {
    auth: { auth_style: 'bearer', token: 'test-token' },
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

/**
 * MN-261's "one parametrized test all providers must pass": every social
 * source, given a minimal realistic page of its own API's response shape,
 * must emit items conforming to the shared EngagementItem contract
 * (sources/providers/engagement.ts) — the whole reason one Engagement
 * database can hold rows from all three.
 */
const FIXTURES: Array<{ label: string; provider: SourceProviderDescriptor; ctx: SourceSyncContext }> = [
  {
    label: 'meta.page_comments',
    provider: metaEngagementProvider,
    ctx: baseCtx({
      config: { page_id: 'page1' },
      fetcher: fakeFetcher({
        'page1/posts': {
          data: [
            {
              id: 'post1',
              comments: {
                data: [
                  {
                    id: 'c1',
                    from: { id: 'u1', name: 'Alice' },
                    message: 'hi there',
                    created_time: '2026-01-01T00:00:00+0000',
                    permalink_url: 'https://facebook.com/post1?comment_id=c1',
                  },
                ],
              },
            },
          ],
        },
      }),
    }),
  },
  {
    label: 'x.mentions',
    provider: xEngagementProvider,
    ctx: baseCtx({
      config: { user_id: 'u1' },
      fetcher: fakeFetcher({
        mentions: {
          data: [
            { id: 't1', author_id: 'a1', text: 'hey @you check this out', created_at: '2026-01-01T00:00:00Z', conversation_id: 'conv1' },
          ],
          includes: { users: [{ id: 'a1', username: 'alice', name: 'Alice' }] },
          meta: { newest_id: 't1' },
        },
      }),
    }),
  },
  {
    label: 'linkedin.org_engagement',
    provider: linkedinEngagementProvider,
    ctx: baseCtx({
      config: { post_urns: ['urn:li:share:1'] },
      fetcher: fakeFetcher({
        socialActions: {
          elements: [{ id: 'lc1', message: { text: 'nice post' }, created: { time: 1735689600000 } }],
          paging: { total: 1 },
        },
      }),
    }),
  },
];

for (const { label, provider, ctx } of FIXTURES) {
  describe(`${label} — EngagementItem conformance`, () => {
    it('emits at least one item, and every emitted item matches the shared shape', async () => {
      const emitted: Array<Record<string, unknown>> = [];
      await provider.sync({ ...ctx, emit: async (items) => void emitted.push(...items) });

      expect(emitted.length).toBeGreaterThan(0);
      for (const item of emitted) {
        assertEngagementShape(item);
        expect(item.provider).toBe(provider.id);
      }
    });
  });
}
