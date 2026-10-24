import { UnprocessableEntityException } from '@nestjs/common';
import type { ProviderDescriptor } from './types';

/**
 * MN-263 — auth for a generic 'http' connection, consumed only by the
 * http_request automation action. Three shapes because "call any API" means
 * there is no single universal auth header:
 *
 *  - bearer: `Authorization: Bearer <token>`
 *  - basic:  `Authorization: Basic base64(username:password)`
 *  - headers: an arbitrary set of static header/value pairs (e.g. `X-Api-Key`)
 *
 * Merged into the outgoing request's headers at SEND TIME ONLY (the http
 * executor never writes this back into any persisted, rendered config) —
 * see http-request-action.service.ts's mergeAuthHeaders.
 */
export interface HttpConnectionAuth {
  /**
   * #1035 — the ONLY place this credential may be sent: scheme + host + port + a path prefix. A rule author (any member) chooses the
   * request URL, so without this a member could point a shared admin connection at their own server and receive the bearer token.
   * Stored inside the sealed auth beside the secret it protects. A connection with none (made before this existed) sends nothing
   * until an admin sets one.
   */
  base_url?: string;
  auth_style: 'bearer' | 'basic' | 'headers';
  token?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
}

/** Why `raw` cannot be a connection's base URL, or null: http(s), a real host, no credentials, query or fragment. */
export function httpBaseUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'base_url is required: the one URL prefix this credential may be sent to (for example https://api.example.com/v1)';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'base_url is not a valid URL';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'base_url must be http or https';
  if (u.username || u.password) return 'base_url must not contain credentials';
  if (u.search || u.hash) return 'base_url must not contain a query or fragment';
  return null;
}

const normPath = (p: string) => (p.endsWith('/') ? p : `${p}/`);

/**
 * #1035 — whether `url` is inside `base`: the SAME origin (scheme, host, port) and a path at or below the base path, on a segment
 * boundary (`/v1` allows `/v1` and `/v1/x`, not `/v10`). Both sides are parsed first, so `https://good.com@evil.com`, `..` segments
 * and an encoded slash cannot fake a match.
 */
export function urlWithinBase(url: string, base: string): boolean {
  let u: URL;
  let b: URL;
  try {
    u = new URL(url);
    b = new URL(base);
  } catch {
    return false;
  }
  if (u.origin !== b.origin || u.username || u.password) return false;
  const up = u.pathname;
  const bp = b.pathname;
  return up === bp || normPath(up).startsWith(normPath(bp));
}

/**
 * MN-263 — the 'http' provider backing http_request's optional connection.
 * `healthCheck` deliberately never probes the network: unlike Resend/Apify
 * there is no universal endpoint to call ("any API" is the whole point), so
 * the only thing worth validating is that the shape is internally consistent
 * — a 'bearer' connection actually has a token, a 'basic' one actually has
 * a username, etc. A connection accepted here starts life 'active' and only
 * turns 'error' once a real http_request send against it fails.
 */
export const httpProvider: ProviderDescriptor = {
  id: 'http',
  label: 'HTTP (custom API)',
  authKind: 'api_key',
  tier: 'api_key',
  async healthCheck(auth: unknown): Promise<void> {
    const a = (auth ?? {}) as Partial<HttpConnectionAuth>;
    const baseProblem = httpBaseUrlProblem(a.base_url);
    if (baseProblem) throw new UnprocessableEntityException(baseProblem);
    if (a.auth_style !== 'bearer' && a.auth_style !== 'basic' && a.auth_style !== 'headers') {
      throw new UnprocessableEntityException(
        "HTTP connection needs auth_style: 'bearer' | 'basic' | 'headers'",
      );
    }
    if (a.auth_style === 'bearer' && !a.token?.trim()) {
      throw new UnprocessableEntityException('bearer auth needs a token');
    }
    if (a.auth_style === 'basic' && (!a.username?.trim() || a.password === undefined)) {
      throw new UnprocessableEntityException('basic auth needs a username and password');
    }
    if (a.auth_style === 'headers' && (!a.headers || Object.keys(a.headers).length === 0)) {
      throw new UnprocessableEntityException('headers auth needs at least one header');
    }
  },
};
