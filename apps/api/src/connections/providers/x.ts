import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for an X connection.
 *
 * Unlike LinkedIn/YouTube, X is deliberately NOT `oauth_managed` here: X's
 * OAuth2 user-context flow (with PKCE) needs the WORKSPACE's own developer
 * app (client_id/secret) — there is no single verified app StoryOS could run
 * centrally the way it does for LinkedIn/Google, and X's free tier for a
 * managed app would not scale across workspaces anyway. So this descriptor
 * is `api_key` tier: the connect flow (owned by a later ticket, not #42)
 * does its own PKCE dance against the user's own app and stores the
 * resulting bearer/access token here; this descriptor only needs to verify
 * that stored token still works.
 */
export interface XAuth {
  access_token: string;
  refresh_token?: string;
  /** Epoch ms this access token expires, when the connect flow captured one. */
  expires_at?: number;
}

const ME_URL = 'https://api.twitter.com/2/users/me';

/**
 * X / Twitter (ticket #42 / MN-257's post_social action). `GET /2/users/me`
 * with the stored bearer token is the lightest authenticated call the v2 API
 * offers — any valid token returns 200, an invalid/expired one 401s.
 */
export const xProvider: ProviderDescriptor = {
  id: 'x',
  label: 'X (Twitter)',
  authKind: 'api_key',
  tier: 'api_key',
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { access_token } = (auth ?? {}) as Partial<XAuth>;
    if (!access_token || !access_token.trim()) {
      throw new UnprocessableEntityException('X connection needs an access token');
    }
    const res = await fetcher(ME_URL, { headers: { authorization: `Bearer ${access_token}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`X token check failed (HTTP ${res.status})`);
    }
  },
};
