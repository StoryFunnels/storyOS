import { UnprocessableEntityException } from '@nestjs/common';
import { defaultConnectionFetcher } from './types';
import type { ConnectionFetcher, ProviderDescriptor } from './types';

/**
 * The auth JSON shape stored (sealed) for a workspace's own OpenAI key
 * (#352 — Tyron: bring your own AI key).
 *
 * `model` is optional: absent means Tyron uses this codebase's own default
 * (the same env-configured model tag the managed path uses,
 * OPENAI_TYRON_BYO_DEFAULT_MODEL) rather than forcing every workspace to
 * know a model name before it can connect.
 */
export interface OpenAiConnectionAuth {
  api_key: string;
  model?: string;
}

const MODELS_URL = 'https://api.openai.com/v1/models';

/**
 * OpenAI (#352). `tier: 'api_key'` — a workspace brings its own key, which is
 * exactly what makes this usable identically on hosted and self-managed
 * (providers/availability.ts's `connectable` branch for api_key needs no
 * operator env var at all, unlike an oauth_managed provider).
 *
 * `healthCheck` hits `GET /v1/models`, the same "list something cheap" shape
 * `resendProvider` uses against `/domains` — any valid key returns 200
 * regardless of which models the account has enabled; only an invalid/
 * revoked key 401s.
 */
export const openaiProvider: ProviderDescriptor = {
  id: 'openai',
  label: 'OpenAI',
  authKind: 'api_key',
  tier: 'api_key',
  async healthCheck(auth: unknown, fetcher: ConnectionFetcher = defaultConnectionFetcher): Promise<void> {
    const { api_key } = (auth ?? {}) as Partial<OpenAiConnectionAuth>;
    if (!api_key || !api_key.trim()) {
      throw new UnprocessableEntityException('OpenAI connection needs an API key');
    }
    const res = await fetcher(MODELS_URL, { headers: { authorization: `Bearer ${api_key}` } });
    if (res.status < 200 || res.status >= 300) {
      throw new UnprocessableEntityException(`OpenAI key check failed (HTTP ${res.status})`);
    }
  },
};
