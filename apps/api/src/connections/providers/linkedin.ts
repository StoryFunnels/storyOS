import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/** The auth JSON shape stored (sealed) for a LinkedIn OAuth2 connection. */
export interface LinkedinAuth {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  /** Epoch ms this token was minted/refreshed. */
  obtained_at: number;
  /** Epoch ms this access token expires. */
  expires_at?: number;
}

const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';

/**
 * LinkedIn (ticket #42 / MN-257's post_social action). Tier B
 * (`oauth_managed`): hosted StoryOS provides a verified OAuth app; a self-
 * managed operator brings their own via `LINKEDIN_CLIENT_ID`/
 * `LINKEDIN_CLIENT_SECRET` (env.ts) — same shape as google.ts's YouTube
 * provider.
 *
 * `w_organization_social`/`r_organization_social` are LinkedIn-restricted
 * scopes that need the app to clear LinkedIn's own review (Step 0, out of
 * engineering scope) — until then a connect attempt against those scopes
 * will itself fail on LinkedIn's side; `env().LINKEDIN_ACTIONS_ENABLED`
 * (added for MN-261's org_engagement source, reused here unchanged) is the
 * separate save-time kill-switch AutomationActionsService.validate() checks
 * before letting a post_social action target linkedin_org/linkedin_member.
 *
 * `/v2/userinfo` (the OpenID Connect profile endpoint, covered by the
 * always-granted `openid`/`profile` scopes) is used as the lightweight
 * health check rather than a heavier organization-scoped call, so a token
 * check never itself depends on the restricted scopes being live yet.
 */
export const linkedinProvider: ProviderDescriptor = {
  id: 'linkedin',
  label: 'LinkedIn',
  authKind: 'oauth2',
  tier: 'oauth_managed',
  oauth: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['w_member_social', 'w_organization_social', 'r_organization_social'],
    clientIdEnv: 'LINKEDIN_CLIENT_ID',
    clientSecretEnv: 'LINKEDIN_CLIENT_SECRET',
  },
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { access_token } = (auth ?? {}) as Partial<LinkedinAuth>;
    if (!access_token) throw new UnprocessableEntityException('LinkedIn connection is missing an access token');
    const res = await fetcher(USERINFO_URL, { headers: { authorization: `Bearer ${access_token}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`LinkedIn token check failed (HTTP ${res.status})`);
    }
  },
};
