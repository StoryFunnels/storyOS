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
  auth_style: 'bearer' | 'basic' | 'headers';
  token?: string;
  username?: string;
  password?: string;
  headers?: Record<string, string>;
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
  async healthCheck(auth: unknown): Promise<void> {
    const a = (auth ?? {}) as Partial<HttpConnectionAuth>;
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
