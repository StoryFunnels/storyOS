import type { ConnectionAuthKind, ProviderTier } from '@storyos/schemas';

/**
 * Minimal fetch surface so every provider's `healthCheck` (and the OAuth token
 * exchange) is testable without a network — the same shape as `SlackFetcher` /
 * `GithubAppFetcher` (integrations/slack.service.ts, integrations/github-app.service.ts).
 */
export type ConnectionFetcher = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export const defaultConnectionFetcher: ConnectionFetcher = (url, init) =>
  fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body }) as unknown as ReturnType<ConnectionFetcher>;

export interface ProviderOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** process.env var name holding the BYO OAuth app's client id. */
  clientIdEnv: string;
  /** process.env var name holding the BYO OAuth app's client secret. */
  clientSecretEnv: string;
  /** Extra static query params merged into the authorize URL — e.g. Google's
   * `access_type=offline&prompt=consent`, needed to actually get a refresh token. */
  extraAuthParams?: Record<string, string>;
}

/**
 * A registered external provider (MN-252). Registering a new one — a new file
 * under `providers/` plus one line in `providers/index.ts` — never needs a
 * schema change: `connections.provider` is a free-text column, and the auth
 * JSON shape lives entirely inside each descriptor.
 */
export interface ProviderDescriptor {
  /** Registry key, also stored verbatim in `connections.provider`. */
  id: string;
  label: string;
  authKind: ConnectionAuthKind;
  /**
   * #346 — the integration tier, by who owns the credential (parent #344):
   *  - 'api_key'       — user brings their own key; works hosted + self-managed.
   *  - 'oauth_managed' — needs a verified OAuth app (hosted provides the managed
   *                      one; self-managed operators bring their own via
   *                      oauth.clientIdEnv/clientSecretEnv).
   *  - 'hosted_only'   — only meaningful on hosted StoryOS (reserved; no provider
   *                      uses it yet).
   * Distinct from `authKind` (the mechanical credential shape): every current
   * 'oauth2' provider is 'oauth_managed', but the two axes are independent so a
   * future api_key provider could be hosted_only, etc. Availability is resolved
   * from this tier + deployment mode by availabilityFor() (providers/availability.ts).
   */
  tier: ProviderTier;
  /**
   * #346 — optional human copy surfaced next to a non-`connectable` availability
   * (e.g. the "Available on StoryOS Cloud" upsell line #347's gallery renders).
   */
  availabilityNote?: string;
  /** Required (and only meaningful) when authKind === 'oauth2'. */
  oauth?: ProviderOAuthConfig;
  /**
   * Verify `auth` against the live provider. Throws (an UnprocessableEntityException,
   * by convention) on anything from a malformed credential to a rejected API call —
   * the caller decides what that means (block a create vs. flip a connection's status).
   */
  healthCheck(auth: unknown, fetcher?: ConnectionFetcher): Promise<void>;
  /**
   * MN-253 — default per-connection token-bucket budget for jobs run against
   * this provider (e.g. `{ capacity: 50, refillMs: 86_400_000 }` for "50/24h").
   * Absent means JobRunnerService applies no rate limit for this provider.
   */
  rateLimit?: { capacity: number; refillMs: number };
  /**
   * MN-256 — runs immediately AFTER a successful healthCheck (create() and
   * test() both call it) and its return value becomes `connections.scopes`.
   * For an api_key/smtp provider this is the one place scope-like facts
   * living on the LIVE credential (Resend's verified domains, an SMTP
   * connection's mandatory from-address) get captured — `scopes` already
   * exists for OAuth2's granted-scope list, so this reuses the same jsonb
   * column rather than needing a schema change. May throw (same convention as
   * healthCheck) to reject a credential healthCheck alone can't rule out —
   * e.g. a configured `from_address` whose domain isn't actually verified.
   * Absent means scopes stays `[]`, exactly like today for every provider
   * before MN-256.
   */
  resolveScopes?(auth: unknown, fetcher?: ConnectionFetcher): Promise<string[]>;
}
