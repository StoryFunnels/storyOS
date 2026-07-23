import { z } from 'zod';
import { UnprocessableEntityException } from '@nestjs/common';
import type { GoogleAuth } from '../../connections/providers/google';
import type { ConnectionFetcher } from '../../connections/providers/types';
import type { SourceProviderDescriptor, SourceSyncContext } from './types';

/**
 * #239 — the three YouTube read providers. All three reuse the `google`
 * connection descriptor's `youtube.readonly` scope (connections/providers/
 * google.ts) — read-only is enough for every field these emit; nothing here
 * writes to YouTube (that's MN-259's youtube_upload action).
 *
 * Quota: every call below costs 1 unit (YouTube Data API v3's flat read
 * cost) — `estimateQuotaUnits` below is a call-count estimate, checked by
 * SourcesService BEFORE the cycle runs so a mid-cycle failure never leaves
 * the budget short.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(
  fetcher: ConnectionFetcher,
  accessToken: string,
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetcher(`${API_BASE}/${path}?${qs}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status < 200 || res.status >= 300) {
    const body = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`YouTube API ${path} failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function accessTokenOf(auth: unknown): string {
  const { access_token } = (auth ?? {}) as Partial<GoogleAuth>;
  if (!access_token) throw new UnprocessableEntityException('Connection is missing a YouTube access token');
  return access_token;
}

/** `mine=true` (the connected account's own channel) unless config names one explicitly. */
async function resolveUploadsPlaylistId(
  fetcher: ConnectionFetcher,
  accessToken: string,
  channelId?: string,
): Promise<string> {
  const params: Record<string, string> = { part: 'contentDetails' };
  if (channelId) params['id'] = channelId;
  else params['mine'] = 'true';
  const data = await ytGet(fetcher, accessToken, 'channels', params);
  const items = (data['items'] as Array<Record<string, unknown>> | undefined) ?? [];
  const first = items[0] as Record<string, unknown> | undefined;
  const uploads = (
    (first?.['contentDetails'] as Record<string, unknown> | undefined)?.['relatedPlaylists'] as
      | Record<string, unknown>
      | undefined
  )?.['uploads'] as string | undefined;
  if (!uploads) throw new UnprocessableEntityException('Could not resolve the channel\'s uploads playlist');
  return uploads;
}

/** `mine=true` resolves to the connected account's own channel id (used by comments). */
async function resolveChannelId(fetcher: ConnectionFetcher, accessToken: string, configChannelId?: string): Promise<string> {
  if (configChannelId) return configChannelId;
  const data = await ytGet(fetcher, accessToken, 'channels', { part: 'id', mine: 'true' });
  const items = (data['items'] as Array<Record<string, unknown>> | undefined) ?? [];
  const id = (items[0] as Record<string, unknown> | undefined)?.['id'] as string | undefined;
  if (!id) throw new UnprocessableEntityException('Could not resolve the connected channel id');
  return id;
}

const channelConfigSchema = z.object({
  channel_id: z.string().trim().min(1).optional().describe('Channel id — omit to use the connected account\'s own channel.'),
});

export const youtubeVideosProvider: SourceProviderDescriptor = {
  id: 'youtube.videos',
  label: 'YouTube — videos',
  connectionProvider: 'google',
  configSchema: channelConfigSchema,
  estimateQuotaUnits: () => 10,
  async sync(ctx: SourceSyncContext) {
    const accessToken = accessTokenOf(ctx.auth);
    const channelId = ctx.config['channel_id'] as string | undefined;
    const uploadsPlaylistId = await resolveUploadsPlaylistId(ctx.fetcher, accessToken, channelId);

    let pageToken = (ctx.cursor['page_token'] as string | undefined) ?? undefined;
    let pagesWalked = 0;
    const MAX_PAGES = 20; // ≤1000 videos/cycle — plenty for a 15m/hour/day poll, bounds worst-case quota.

    do {
      const page = await ytGet(ctx.fetcher, accessToken, 'playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      });
      const items = (page['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      const videoIds = items
        .map((it) => (it['contentDetails'] as Record<string, unknown> | undefined)?.['videoId'] as string | undefined)
        .filter((id): id is string => Boolean(id));

      if (videoIds.length) {
        const details = await ytGet(ctx.fetcher, accessToken, 'videos', {
          part: 'snippet,contentDetails,status',
          id: videoIds.join(','),
        });
        const detailItems = (details['items'] as Array<Record<string, unknown>> | undefined) ?? [];
        await ctx.emit(
          detailItems.map((v) => {
            const snippet = (v['snippet'] as Record<string, unknown>) ?? {};
            const content = (v['contentDetails'] as Record<string, unknown>) ?? {};
            const status = (v['status'] as Record<string, unknown>) ?? {};
            const id = v['id'] as string;
            return {
              video_id: id,
              title: snippet['title'] ?? '',
              published_at: snippet['publishedAt'] ?? null,
              duration: content['duration'] ?? null,
              privacy: status['privacyStatus'] ?? null,
              url: `https://www.youtube.com/watch?v=${id}`,
            };
          }),
        );
      }

      pageToken = page['nextPageToken'] as string | undefined;
      pagesWalked += 1;
    } while (pageToken && pagesWalked < MAX_PAGES);

    return { cursor: { page_token: pageToken ?? null } };
  },
};

export const youtubeCommentsProvider: SourceProviderDescriptor = {
  id: 'youtube.comments',
  label: 'YouTube — comments',
  connectionProvider: 'google',
  configSchema: channelConfigSchema,
  estimateQuotaUnits: () => 5,
  async sync(ctx: SourceSyncContext) {
    const accessToken = accessTokenOf(ctx.auth);
    const channelId = await resolveChannelId(ctx.fetcher, accessToken, ctx.config['channel_id'] as string | undefined);
    const watermark = (ctx.cursor['watermark'] as string | undefined) ?? undefined;
    let maxSeen = watermark ?? null;

    let pageToken: string | undefined;
    let stop = false;
    let pagesWalked = 0;
    const MAX_PAGES = 20;

    do {
      const page = await ytGet(ctx.fetcher, accessToken, 'commentThreads', {
        part: 'snippet,replies',
        allThreadsRelatedToChannelId: channelId,
        order: 'time',
        maxResults: '100',
        ...(pageToken ? { pageToken } : {}),
      });
      const items = (page['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      const batch: Array<Record<string, unknown>> = [];

      for (const thread of items) {
        const topSnippet = (thread['snippet'] as Record<string, unknown>) ?? {};
        const topComment = (topSnippet['topLevelComment'] as Record<string, unknown>) ?? {};
        const topCommentSnippet = (topComment['snippet'] as Record<string, unknown>) ?? {};
        const publishedAt = topCommentSnippet['publishedAt'] as string | undefined;

        // order=time is newest-first: once we hit the watermark, everything
        // after (older) was already synced — stop walking pages.
        if (watermark && publishedAt && publishedAt <= watermark) {
          stop = true;
          break;
        }

        const videoId = topSnippet['videoId'] as string | undefined;
        batch.push({
          comment_id: topComment['id'],
          video_id: videoId ?? null,
          author_name: topCommentSnippet['authorDisplayName'] ?? '',
          text: topCommentSnippet['textDisplay'] ?? '',
          like_count: topCommentSnippet['likeCount'] ?? 0,
          published_at: publishedAt ?? null,
          is_reply: false,
          permalink: videoId ? `https://www.youtube.com/watch?v=${videoId}&lc=${String(topComment['id'])}` : null,
        });
        if (publishedAt && (!maxSeen || publishedAt > maxSeen)) maxSeen = publishedAt;

        const replies = ((thread['replies'] as Record<string, unknown> | undefined)?.['comments'] as
          | Array<Record<string, unknown>>
          | undefined) ?? [];
        for (const reply of replies) {
          const replySnippet = (reply['snippet'] as Record<string, unknown>) ?? {};
          const replyPublishedAt = replySnippet['publishedAt'] as string | undefined;
          batch.push({
            comment_id: reply['id'],
            video_id: videoId ?? null,
            author_name: replySnippet['authorDisplayName'] ?? '',
            text: replySnippet['textDisplay'] ?? '',
            like_count: replySnippet['likeCount'] ?? 0,
            published_at: replyPublishedAt ?? null,
            is_reply: true,
            permalink: videoId ? `https://www.youtube.com/watch?v=${videoId}&lc=${String(reply['id'])}` : null,
          });
          if (replyPublishedAt && (!maxSeen || replyPublishedAt > maxSeen)) maxSeen = replyPublishedAt;
        }
      }

      if (batch.length) await ctx.emit(batch);
      pageToken = stop ? undefined : (page['nextPageToken'] as string | undefined);
      pagesWalked += 1;
    } while (pageToken && pagesWalked < MAX_PAGES);

    return { cursor: { watermark: maxSeen } };
  },
};

const metricsConfigSchema = z.object({
  video_ids: z.array(z.string().trim().min(1)).optional().describe('Explicit video ids to snapshot.'),
  paired_source_id: z.uuid().optional().describe('A youtube.videos source id to pull video ids from instead.'),
});

export const youtubeMetricsProvider: SourceProviderDescriptor = {
  id: 'youtube.metrics',
  label: 'YouTube — daily metrics',
  connectionProvider: 'google',
  configSchema: metricsConfigSchema,
  estimateQuotaUnits: (config) => {
    const ids = (config['video_ids'] as string[] | undefined) ?? [];
    return Math.max(1, Math.ceil(ids.length / 50)) + 1; // +1 covers the paired-source lookup path
  },
  async sync(ctx: SourceSyncContext) {
    const accessToken = accessTokenOf(ctx.auth);
    let videoIds = (ctx.config['video_ids'] as string[] | undefined) ?? [];
    const pairedSourceId = ctx.config['paired_source_id'] as string | undefined;
    if (videoIds.length === 0 && pairedSourceId) {
      videoIds = await ctx.lookupSourceKeys(pairedSourceId);
    }
    if (videoIds.length === 0) return { cursor: ctx.cursor };

    const date = new Date().toISOString().slice(0, 10);
    const CHUNK = 50;
    for (let i = 0; i < videoIds.length; i += CHUNK) {
      const chunk = videoIds.slice(i, i + CHUNK);
      const data = await ytGet(ctx.fetcher, accessToken, 'videos', {
        part: 'statistics',
        id: chunk.join(','),
      });
      const items = (data['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      await ctx.emit(
        items.map((v) => {
          const stats = (v['statistics'] as Record<string, unknown>) ?? {};
          const videoId = v['id'] as string;
          return {
            snapshot_id: `${videoId}:${date}`,
            video_id: videoId,
            date,
            views: Number(stats['viewCount'] ?? 0),
            likes: Number(stats['likeCount'] ?? 0),
            comments: Number(stats['commentCount'] ?? 0),
          };
        }),
      );
    }
    return { cursor: { ...ctx.cursor, last_snapshot_date: date } };
  },
};
