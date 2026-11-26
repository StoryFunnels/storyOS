import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/** The auth JSON sealed for a YouTube (upload) connection: Google's own OAuth2 token response, like the `google` provider's. */
export interface YoutubeAuth {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  /** Epoch ms this token was minted/refreshed. */
  obtained_at: number;
  /** Epoch ms this access token expires: drives ConnectionsService's refresh loop. */
  expires_at?: number;
}

/** Least privilege (ticket #60): upload a video, and read the channel the token belongs to. Nothing that edits or deletes. */
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_SCOPES = [YOUTUBE_UPLOAD_SCOPE, YOUTUBE_READONLY_SCOPE];

/** A channel is named by its id, and only by that: `UC` + 22 url-safe characters. */
export const YOUTUBE_CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

export const YOUTUBE_CHANNELS_URL = 'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true&maxResults=50';

/**
 * YouTube upload (ticket #60) for `post_social` with target `youtube_channel`. Tier B (`oauth_managed`): hosted StoryOS
 * provides a Google app that has cleared Google's sensitive-scope verification; a self-managed operator brings their own via
 * YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET. A DEDICATED provider and client, deliberately not the `google` provider (which
 * backs sign-in and the read-only YouTube source): adding `youtube.upload` there would widen every existing connection's
 * consent and tie sign-in to a sensitive scope.
 *
 * `access_type=offline&prompt=consent` is required to get a refresh token. The refresh loop is ConnectionsService's generic one
 * (it reads `refresh_token` / `expires_at` from the sealed blob), the same as the `google` provider.
 */
export const youtubeProvider: ProviderDescriptor = {
  id: 'youtube',
  label: 'YouTube (upload)',
  authKind: 'oauth2',
  tier: 'oauth_managed',
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: YOUTUBE_SCOPES,
    clientIdEnv: 'YOUTUBE_CLIENT_ID',
    clientSecretEnv: 'YOUTUBE_CLIENT_SECRET',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  // Each upload costs 1,600 of a project's default 10,000 daily quota units; a per-connection ceiling of 6 a day keeps one
  // connection from draining a shared hosted app. YouTube's own quota (a 403) is still handled in the executor.
  rateLimit: { capacity: 6, refillMs: 86_400_000 },
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { access_token } = (auth ?? {}) as Partial<YoutubeAuth>;
    if (!access_token) throw new UnprocessableEntityException('YouTube connection is missing an access token');
    const res = await fetcher(YOUTUBE_CHANNELS_URL, { headers: { authorization: `Bearer ${access_token}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`YouTube token check failed (HTTP ${res.status})`);
    }
  },
};
