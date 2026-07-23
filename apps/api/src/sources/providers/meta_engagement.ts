import { z } from 'zod';
import { UnprocessableEntityException } from '@nestjs/common';
import type { HttpConnectionAuth } from '../../connections/providers/http';
import type { ConnectionFetcher } from '../../connections/providers/types';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';
import type { EngagementItem } from './engagement';

/**
 * MN-261 — Meta (Facebook Page + paired Instagram Business Account) comments,
 * the best-behaved of the three social APIs (MN-260's epic doc). Ship FIRST
 * per the ticket's ordering.
 *
 * Connection: there is no dedicated 'meta' OAuth connection provider yet (the
 * MN-258 ticket this guide assumed as already built does not exist in this
 * codebase — verified against connections/providers/index.ts before writing
 * this). This provider therefore runs against the generic 'http' bearer
 * connection (MN-263, connections/providers/http.ts): the workspace pastes in
 * a long-lived Page Access Token (Graph API "Page" token, or a System User
 * token scoped to the page) obtained from Meta's own dev tools. One source =
 * one page's token, mirroring youtube.ts's "one connection, one channel"
 * shape. A dedicated Meta OAuth connection (proper MN-258) is a clean
 * follow-up that would let this provider's config drop `page_id`/`ig_user_id`
 * in favor of an app-managed page picker — swapping `connectionProvider` to
 * 'meta' then is the only change this file would need.
 */

const API_BASE = 'https://graph.facebook.com/v19.0';
const MAX_PAGES = 20; // bounds worst-case calls/cycle, same rationale as youtube.ts

export const metaEngagementConfigSchema = z.object({
  page_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Facebook Page id — omit to resolve via /me using the connection\'s token.'),
  ig_user_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Paired Instagram Business Account id — omit to skip IG comments entirely.'),
});

function bearerTokenOf(auth: unknown): string {
  const a = (auth ?? {}) as Partial<HttpConnectionAuth>;
  if (a.auth_style !== 'bearer' || !a.token?.trim()) {
    throw new UnprocessableEntityException(
      'meta.page_comments needs an "http" connection with auth_style: "bearer" (a Meta Page Access Token)',
    );
  }
  return a.token;
}

async function fbGet(
  fetcher: ConnectionFetcher,
  token: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token }).toString();
  const res = await fetcher(`${API_BASE}/${path}?${qs}`, {});
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`Meta Graph API ${path} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function resolvePageId(fetcher: ConnectionFetcher, token: string, configPageId?: string): Promise<string> {
  if (configPageId) return configPageId;
  const data = await fbGet(fetcher, token, 'me', { fields: 'id' });
  const id = data['id'] as string | undefined;
  if (!id) throw new UnprocessableEntityException('Could not resolve the connected Facebook Page id');
  return id;
}

function toIso(createdTime: unknown): string | null {
  if (typeof createdTime !== 'string') return null;
  const d = new Date(createdTime);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Walks one page's `/{page_id}/posts` → nested `comments` edge, newest posts first. */
async function syncPageComments(
  fetcher: ConnectionFetcher,
  token: string,
  pageId: string,
  watermark: string | undefined,
  emit: (items: EngagementItem[]) => Promise<void>,
): Promise<string | null> {
  let maxSeen = watermark ?? null;
  let after: string | undefined;
  let pagesWalked = 0;

  do {
    const page = await fbGet(fetcher, token, `${pageId}/posts`, {
      fields: 'id,comments.summary(true){id,from,message,created_time,permalink_url,parent}',
      limit: '25',
      ...(after ? { after } : {}),
    });
    const posts = (page['data'] as Array<Record<string, unknown>> | undefined) ?? [];
    const batch: EngagementItem[] = [];

    for (const post of posts) {
      const postId = post['id'] as string | undefined;
      const comments = ((post['comments'] as Record<string, unknown> | undefined)?.['data'] as
        | Array<Record<string, unknown>>
        | undefined) ?? [];
      for (const c of comments) {
        const createdAt = toIso(c['created_time']);
        if (watermark && createdAt && createdAt <= watermark) continue;
        const parent = c['parent'] as Record<string, unknown> | undefined;
        const from = c['from'] as Record<string, unknown> | undefined;
        batch.push({
          provider: 'meta.page_comments',
          kind: parent?.['id'] ? 'reply' : 'comment',
          external_id: String(c['id']),
          author_handle: null, // Graph API's `from` has no stable handle, only a numeric id/name
          author_name: (from?.['name'] as string | undefined) ?? null,
          text: (c['message'] as string | undefined) ?? '',
          permalink: (c['permalink_url'] as string | undefined) ?? null,
          parent_external_id: (parent?.['id'] as string | undefined) ?? null,
          post_external_id: postId ?? null,
          posted_at: createdAt,
        });
        if (createdAt && (!maxSeen || createdAt > maxSeen)) maxSeen = createdAt;
      }
    }

    if (batch.length) await emit(batch);
    const paging = page['paging'] as Record<string, unknown> | undefined;
    after = (paging?.['cursors'] as Record<string, unknown> | undefined)?.['after'] as string | undefined;
    const hasNext = Boolean(paging?.['next']);
    pagesWalked += 1;
    if (!hasNext) break;
  } while (after && pagesWalked < MAX_PAGES);

  return maxSeen;
}

/** Walks a paired IG Business Account's media → comments, same watermark shape. */
async function syncIgComments(
  fetcher: ConnectionFetcher,
  token: string,
  igUserId: string,
  watermark: string | undefined,
  emit: (items: EngagementItem[]) => Promise<void>,
): Promise<string | null> {
  let maxSeen = watermark ?? null;
  let after: string | undefined;
  let pagesWalked = 0;

  do {
    const page = await fbGet(fetcher, token, `${igUserId}/media`, {
      fields: 'id,permalink',
      limit: '25',
      ...(after ? { after } : {}),
    });
    const mediaItems = (page['data'] as Array<Record<string, unknown>> | undefined) ?? [];

    for (const media of mediaItems) {
      const mediaId = media['id'] as string | undefined;
      const permalink = (media['permalink'] as string | undefined) ?? null;
      if (!mediaId) continue;
      const commentsPage = await fbGet(fetcher, token, `${mediaId}/comments`, {
        fields: 'id,text,username,timestamp',
        limit: '50',
      });
      const comments = (commentsPage['data'] as Array<Record<string, unknown>> | undefined) ?? [];
      const batch: EngagementItem[] = [];
      for (const c of comments) {
        const createdAt = toIso(c['timestamp']);
        if (watermark && createdAt && createdAt <= watermark) continue;
        batch.push({
          provider: 'meta.page_comments',
          kind: 'comment',
          external_id: String(c['id']),
          author_handle: (c['username'] as string | undefined) ?? null,
          author_name: null,
          text: (c['text'] as string | undefined) ?? '',
          permalink,
          parent_external_id: null, // IG's flat comments edge doesn't expose reply nesting
          post_external_id: mediaId,
          posted_at: createdAt,
        });
        if (createdAt && (!maxSeen || createdAt > maxSeen)) maxSeen = createdAt;
      }
      if (batch.length) await emit(batch);
    }

    const paging = page['paging'] as Record<string, unknown> | undefined;
    after = (paging?.['cursors'] as Record<string, unknown> | undefined)?.['after'] as string | undefined;
    const hasNext = Boolean(paging?.['next']);
    pagesWalked += 1;
    if (!hasNext) break;
  } while (after && pagesWalked < MAX_PAGES);

  return maxSeen;
}

export const metaEngagementProvider: SourceProviderDescriptor = {
  id: 'meta.page_comments',
  label: 'Meta — Page & Instagram comments',
  connectionProvider: 'http',
  configSchema: metaEngagementConfigSchema,
  async sync(ctx: SourceSyncContext) {
    const token = bearerTokenOf(ctx.auth);
    const pageId = await resolvePageId(ctx.fetcher, token, ctx.config['page_id'] as string | undefined);
    const igUserId = ctx.config['ig_user_id'] as string | undefined;

    const cursor = ctx.cursor as { fb_watermark?: string; ig_watermark?: string };
    const emit = (items: EngagementItem[]) => ctx.emit(items as unknown as Array<Record<string, unknown>>);

    const fbWatermark = await syncPageComments(ctx.fetcher, token, pageId, cursor.fb_watermark, emit);
    const igWatermark = igUserId
      ? await syncIgComments(ctx.fetcher, token, igUserId, cursor.ig_watermark, emit)
      : (cursor.ig_watermark ?? null);

    return { cursor: { fb_watermark: fbWatermark, ig_watermark: igWatermark } };
  },
};
