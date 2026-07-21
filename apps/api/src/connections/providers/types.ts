import type { ConnectionAuthKind } from '@storyos/schemas';

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
  /** Required (and only meaningful) when authKind === 'oauth2'. */
  oauth?: ProviderOAuthConfig;
  /**
   * Verify `auth` against the live provider. Throws (an UnprocessableEntityException,
   * by convention) on anything from a malformed credential to a rejected API call —
   * the caller decides what that means (block a create vs. flip a connection's status).
   */
  healthCheck(auth: unknown, fetcher?: ConnectionFetcher): Promise<void>;
}
