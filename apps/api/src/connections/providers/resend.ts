import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for a Resend connection. api_key-only
 * for now (MVP scope) — MN-256's send_email action is the actual consumer and
 * can extend this to the smtp shape the implementation guide also allows
 * (`{ mode: 'smtp', host, port, user, pass }`) if/when it needs it; adding
 * that later needs no schema change, only a wider union here.
 */
export interface ResendAuth {
  api_key: string;
}

const DOMAINS_URL = 'https://api.resend.com/domains';

/**
 * Resend (MN-252 / MN-256's source ticket): a per-workspace API key, checked
 * against `GET /domains` — any valid key returns 200 (an empty list is a
 * valid, working key; only an invalid/revoked key 401s).
 */
export const resendProvider: ProviderDescriptor = {
  id: 'resend',
  label: 'Resend',
  authKind: 'api_key',
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
};
