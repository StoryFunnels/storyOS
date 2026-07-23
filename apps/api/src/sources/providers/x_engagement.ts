import { z } from 'zod';
import { UnprocessableEntityException } from '@nestjs/common';
import type { HttpConnectionAuth } from '../../connections/providers/http';
import type { ConnectionFetcher } from '../../connections/providers/types';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';
import type { EngagementItem } from './engagement';

/**
 * MN-261 — X (Twitter) mentions. Tier-limited per the ticket: results and
 * lookback depend entirely on the connected account's own X API plan — this
 * provider does not (and cannot) work around that, it just walks whatever
 * `/2/users/:id/mentions` returns.
 *
 * Connection: same situation as meta_engagement.ts — no dedicated 'x' OAuth
 * connection provider exists yet (verified against
 * connections/providers/index.ts), so this runs against the generic 'http'
 * bearer connection: the workspace pastes in a User-Context OAuth 2.0 Bearer
 * token (tweet.read + users.read + mentions scopes) minted via X's own
 * developer portal.
 */

const API_BASE = 'https://api.twitter.com/2';
const MAX_PAGES = 10;

export const xEngagementConfigSchema = z.object({
  user_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('X user id whose mentions to track — omit to resolve via /2/users/me.'),
});

function bearerTokenOf(auth: unknown): string {
  const a = (auth ?? {}) as Partial<HttpConnectionAuth>;
  if (a.auth_style !== 'bearer' || !a.token?.trim()) {
    throw new UnprocessableEntityException(
      'x.mentions needs an "http" connection with auth_style: "bearer" (an X API OAuth 2.0 user token)',
    );
  }
  return a.token;
}

async function xGet(
  fetcher: ConnectionFetcher,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetcher(`${API_BASE}/${path}${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`X API ${path} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function resolveUserId(fetcher: ConnectionFetcher, token: string, configUserId?: string): Promise<string> {
  if (configUserId) return configUserId;
  const data = await xGet(fetcher, token, 'users/me', {});
  const id = ((data['data'] as Record<string, unknown> | undefined)?.['id'] as string | undefined) ?? undefined;
  if (!id) throw new UnprocessableEntityException('Could not resolve the connected X user id');
  return id;
}

export const xEngagementProvider: SourceProviderDescriptor = {
  id: 'x.mentions',
  label: 'X (Twitter) — mentions',
  connectionProvider: 'http',
  configSchema: xEngagementConfigSchema,
  async sync(ctx: SourceSyncContext) {
    const token = bearerTokenOf(ctx.auth);
    const userId = await resolveUserId(ctx.fetcher, token, ctx.config['user_id'] as string | undefined);
    const sinceId = (ctx.cursor['since_id'] as string | undefined) ?? undefined;

    let newestId = sinceId ?? null;
    let paginationToken: string | undefined;
    let pagesWalked = 0;

    do {
      const params: Record<string, string> = {
        'tweet.fields': 'author_id,created_at,conversation_id',
        expansions: 'author_id',
        'user.fields': 'username,name',
        max_results: '100',
        ...(sinceId ? { since_id: sinceId } : {}),
        ...(paginationToken ? { pagination_token: paginationToken } : {}),
      };
      const page = await xGet(ctx.fetcher, token, `users/${userId}/mentions`, params);
      const tweets = (page['data'] as Array<Record<string, unknown>> | undefined) ?? [];
      const users = ((page['includes'] as Record<string, unknown> | undefined)?.['users'] as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
      const userById = new Map(users.map((u) => [u['id'] as string, u]));

      const batch: EngagementItem[] = tweets.map((t) => {
        const authorId = t['author_id'] as string | undefined;
        const author = authorId ? userById.get(authorId) : undefined;
        const username = author?.['username'] as string | undefined;
        const id = t['id'] as string;
        return {
          provider: 'x.mentions',
          kind: 'mention',
          external_id: id,
          author_handle: username ?? null,
          author_name: (author?.['name'] as string | undefined) ?? null,
          text: (t['text'] as string | undefined) ?? '',
          permalink: username ? `https://x.com/${username}/status/${id}` : null,
          parent_external_id: null, // mentions aren't a thread reply — no parent to report
          post_external_id: (t['conversation_id'] as string | undefined) ?? null,
          posted_at: (t['created_at'] as string | undefined) ?? null,
        };
      });
      if (batch.length) await ctx.emit(batch as unknown as Array<Record<string, unknown>>);

      const meta = (page['meta'] as Record<string, unknown> | undefined) ?? {};
      const pageNewest = meta['newest_id'] as string | undefined;
      if (pageNewest && (!newestId || pageNewest > newestId)) newestId = pageNewest;

      paginationToken = meta['next_token'] as string | undefined;
      pagesWalked += 1;
    } while (paginationToken && pagesWalked < MAX_PAGES);

    return { cursor: { since_id: newestId } };
  },
};
