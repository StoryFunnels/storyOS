import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for a Resend connection.
 *
 * `from_address` and `webhook_secret` are both MN-256 additions, both
 * optional so an MN-252-era connection (api_key only) keeps working
 * unchanged:
 *  - `from_address`: required before this connection can back a send_email
 *    action (AutomationActionsService.validate() checks for a `from:` entry
 *    in `connections.scopes`, populated by `resolveScopes` below) — its
 *    domain must be one of the key's own Resend-verified domains, checked
 *    right here rather than trusted at face value (never send as a domain
 *    this credential doesn't actually own).
 *  - `webhook_secret`: the signing secret Resend hands out when an admin
 *    points a Resend webhook at this connection's own
 *    `/providers/resend/webhook/:connectionId` URL (resend-webhook.controller.ts)
 *    — absent means bounce/complaint degradation is simply unconfigured for
 *    this connection (every delivery 401s), not a startup requirement.
 */
export interface ResendAuth {
  api_key: string;
  from_address?: string;
  webhook_secret?: string;
}

const DOMAINS_URL = 'https://api.resend.com/domains';

interface ResendDomainsResponse {
  data?: Array<{ name?: string; status?: string }>;
}

/**
 * Resend (MN-252 / MN-256's source ticket): a per-workspace API key, checked
 * against `GET /domains` — any valid key returns 200 (an empty list is a
 * valid, working key; only an invalid/revoked key 401s).
 */
export const resendProvider: ProviderDescriptor = {
  id: 'resend',
  label: 'Resend',
  authKind: 'api_key',
  // MN-253: a conservative MVP default (Resend's own published limit is
  // higher) — JobRunnerService's per-connection token bucket, exercised for
  // real by MN-256's send_email action. Tune once that ticket has real
  // traffic to measure against.
  rateLimit: { capacity: 100, refillMs: 60_000 },
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { api_key } = (auth ?? {}) as Partial<ResendAuth>;
    if (!api_key || !api_key.trim()) {
      throw new UnprocessableEntityException('Resend connection needs an API key');
    }
    const res = await fetcher(DOMAINS_URL, { headers: { authorization: `Bearer ${api_key}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`Resend token check failed (HTTP ${res.status})`);
    }
  },
  /**
   * MN-256: verified domains → `domain:<name>` scope entries, always. When
   * `from_address` is set, its domain must be among them — otherwise this
   * throws (surfaced as a 422 at connect/test time) rather than silently
   * accepting a from-address this key can't actually send as — and a
   * `from:<address>` entry is added, which is what validate() looks for
   * before letting a send_email action reference this connection.
   */
  async resolveScopes(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<string[]> {
    const { api_key, from_address } = (auth ?? {}) as Partial<ResendAuth>;
    if (!api_key) return [];
    const res = await fetcher(DOMAINS_URL, { headers: { authorization: `Bearer ${api_key}` } });
    if (res.status < 200 || res.status >= 300) return [];
    const body = (await res.json()) as ResendDomainsResponse;
    const verified = (body.data ?? [])
      .filter((d) => d.status === 'verified' && d.name)
      .map((d) => d.name!.toLowerCase());
    const scopes = verified.map((d) => `domain:${d}`);
    if (from_address) {
      const domain = from_address.split('@')[1]?.trim().toLowerCase();
      if (!domain || !verified.includes(domain)) {
        throw new UnprocessableEntityException(
          `from_address "${from_address}" is not on a Resend-verified domain for this key` +
            (verified.length > 0 ? ` (verified: ${verified.join(', ')})` : ' (no verified domains on this key yet)'),
        );
      }
      scopes.push(`from:${from_address}`);
    }
    return scopes;
  },
};
