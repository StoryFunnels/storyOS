import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/** The auth JSON shape stored (sealed) for a Google OAuth2 connection. */
export interface GoogleAuth {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  /** Epoch ms this token was minted/refreshed. */
  obtained_at: number;
  /** Epoch ms this access token expires — drives the refresh loop. */
  expires_at?: number;
}

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * YouTube (MN-252's OAuth2 proof: the first real end-to-end connect flow).
 * Reuses the `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` self-host already sets
 * for "Continue with Google" (config/env.ts) — exactly the "YT reuses
 * GOOGLE_…" reuse the ticket calls for, one ticket early. MN-259's YouTube
 * action/source can either widen `scopes` on this descriptor or register its
 * own with a narrower scope set; both read the same env vars.
 *
 * `access_type=offline&prompt=consent` is required to get a refresh_token —
 * without it Google only returns one on the very first ever consent.
 */
export const googleProvider: ProviderDescriptor = {
  id: 'google',
  // Keep the stored provider id for backwards compatibility; the credential is
  // product-specific and must never be presented as generic Google access.
  label: 'YouTube',
  authKind: 'oauth2',
  oauth: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/youtube.readonly'],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { access_token } = (auth ?? {}) as Partial<GoogleAuth>;
    if (!access_token) throw new UnprocessableEntityException('YouTube connection is missing an access token');
    const res = await fetcher(USERINFO_URL, { headers: { authorization: `Bearer ${access_token}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`YouTube token check failed (HTTP ${res.status})`);
    }
  },
};
