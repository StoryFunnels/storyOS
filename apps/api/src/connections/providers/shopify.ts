import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for a Shopify connection (#333).
 *
 * Shopify's simplest secure server-to-server credential is a **custom app's
 * Admin API access token** (the merchant creates a custom app in their store
 * admin, grants read scopes, and copies the `shpat_…` token). That is a
 * user-supplied secret the user brings themselves — no StoryOS-owned OAuth app
 * is needed — so Shopify is a **Tier A (`api_key`)** provider that works
 * identically on hosted StoryOS Cloud and on a self-managed box. A public-app
 * OAuth flow (a Tier B upgrade) can come later; it is deliberately NOT built
 * here.
 *
 *  - `shop_domain`: the store's canonical `*.myshopify.com` host. Normalized
 *    and validated to that shape (never a bare custom domain, never an
 *    arbitrary URL) so the token is only ever sent to a real Shopify admin
 *    endpoint — the credential-scope equivalent of Resend's from-address check.
 *  - `access_token`: the Admin API access token (`shpat_…` for a custom app).
 */
export interface ShopifyAuth {
  shop_domain: string;
  access_token: string;
}

/** Admin API version pinned for every Shopify call (connection + sources).
 * Shopify supports a version for ~12 months; bump deliberately, in one place. */
export const SHOPIFY_API_VERSION = '2024-07';

/**
 * Normalize whatever the user pasted into a canonical `store.myshopify.com`
 * host, or throw. Accepts `store`, `store.myshopify.com`, and a full
 * `https://store.myshopify.com/…` URL; rejects anything that isn't a
 * `*.myshopify.com` host. Rejecting non-myshopify hosts is a security control,
 * not just tidiness: it guarantees the sealed access token can only ever be
 * sent to Shopify's own admin API, never to an operator-internal address an
 * attacker slipped into `shop_domain` (SSRF).
 */
export function normalizeShopDomain(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new UnprocessableEntityException('Shopify connection needs a shop domain (e.g. my-store.myshopify.com)');
  }
  let host = raw.trim().toLowerCase();
  // Strip a scheme + any path/query if a full URL was pasted.
  if (host.includes('://')) {
    try {
      host = new URL(host).host;
    } catch {
      throw new UnprocessableEntityException(`Invalid Shopify shop domain "${raw}"`);
    }
  } else {
    host = host.split('/')[0]!;
  }
  // A bare handle ("my-store") → my-store.myshopify.com.
  if (!host.includes('.')) host = `${host}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(host)) {
    throw new UnprocessableEntityException(
      `"${raw}" is not a Shopify store domain — use your store's <name>.myshopify.com host`,
    );
  }
  return host;
}

export function shopifyGraphqlUrl(shopDomain: string): string {
  return `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
}

/** Bearer-equivalent header Shopify's Admin API expects for a custom-app token. */
export function shopifyAuthHeaders(accessToken: string): Record<string, string> {
  return { 'X-Shopify-Access-Token': accessToken, 'content-type': 'application/json' };
}

interface ShopifyGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }> | { message?: string };
}

/**
 * POST a GraphQL query to the connection's shop and return `data`, throwing an
 * UnprocessableEntityException on transport failure OR a top-level `errors`
 * array (Shopify answers 200 even for throttling / bad-field errors, so the
 * body must be inspected, not just the status). Shared by the connection
 * healthCheck and every Shopify source provider.
 */
export async function shopifyGraphql<T>(
  fetcher: ConnectionFetcher,
  auth: ShopifyAuth,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const shopDomain = normalizeShopDomain(auth.shop_domain);
  const accessToken = auth.access_token?.trim();
  if (!accessToken) throw new UnprocessableEntityException('Shopify connection needs an Admin API access token');

  const res = await fetcher(shopifyGraphqlUrl(shopDomain), {
    method: 'POST',
    headers: shopifyAuthHeaders(accessToken),
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UnprocessableEntityException('Shopify rejected the Admin API access token (check the token and its scopes)');
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new UnprocessableEntityException(`Shopify Admin API call failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as ShopifyGraphqlResponse<T>;
  if (body.errors) {
    const message = Array.isArray(body.errors)
      ? body.errors.map((e) => e.message).filter(Boolean).join('; ')
      : body.errors.message;
    throw new UnprocessableEntityException(`Shopify Admin API error: ${message || 'unknown error'}`);
  }
  if (body.data === undefined) throw new UnprocessableEntityException('Shopify Admin API returned no data');
  return body.data;
}

/**
 * Shopify (#333): a per-store Admin API access token, verified with the
 * cheapest possible Admin API call — `{ shop { name } }` — the same "does this
 * token even work" check a human would do first. Tier A: the user brings the
 * token, so it is `connectable` on every deployment.
 */
export const shopifyProvider: ProviderDescriptor = {
  id: 'shopify',
  label: 'Shopify',
  authKind: 'api_key',
  tier: 'api_key',
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { shop_domain, access_token } = (auth ?? {}) as Partial<ShopifyAuth>;
    // Validate + normalize the domain first (throws its own 422), before any
    // network call, so a malformed domain never reaches the fetcher.
    normalizeShopDomain(shop_domain);
    if (!access_token || !access_token.trim()) {
      throw new UnprocessableEntityException('Shopify connection needs an Admin API access token');
    }
    const data = await shopifyGraphql<{ shop?: { name?: string } }>(
      fetcher,
      auth as ShopifyAuth,
      '{ shop { name } }',
    );
    if (!data.shop?.name) {
      throw new UnprocessableEntityException('Shopify token check did not return a shop — the token may lack read_products scope');
    }
  },
  /**
   * Capture the custom app's granted access scopes as `scope:<handle>` entries
   * (mirrors Resend's verified-domain scopes) so the Connections surface shows
   * what this token can actually read. Best-effort: a failure here never blocks
   * connecting a token whose healthCheck already passed — same as Resend's
   * domain read degrading to `[]`.
   */
  async resolveScopes(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<string[]> {
    try {
      const data = await shopifyGraphql<{ currentAppInstallation?: { accessScopes?: Array<{ handle?: string }> } }>(
        fetcher,
        auth as ShopifyAuth,
        '{ currentAppInstallation { accessScopes { handle } } }',
      );
      const scopes = data.currentAppInstallation?.accessScopes ?? [];
      return scopes.map((s) => s.handle).filter((h): h is string => Boolean(h)).map((h) => `scope:${h}`);
    } catch {
      return [];
    }
  },
};
