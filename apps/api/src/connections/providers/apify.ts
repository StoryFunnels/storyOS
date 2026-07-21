import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/** The auth JSON shape stored (sealed) for an Apify connection. */
export interface ApifyAuth {
  api_key: string;
}

const ME_URL = 'https://api.apify.com/v2/users/me';

/**
 * Apify (MN-252 / MN-262's source ticket): a personal API token, checked
 * against `GET /v2/users/me` — the same "does this key even work" check a
 * human would do first.
 */
export const apifyProvider: ProviderDescriptor = {
  id: 'apify',
  label: 'Apify',
  authKind: 'api_key',
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { api_key } = (auth ?? {}) as Partial<ApifyAuth>;
    if (!api_key || !api_key.trim()) {
      throw new UnprocessableEntityException('Apify connection needs an API key');
    }
    const res = await fetcher(ME_URL, { headers: { authorization: `Bearer ${api_key}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`Apify token check failed (HTTP ${res.status})`);
    }
  },
};
