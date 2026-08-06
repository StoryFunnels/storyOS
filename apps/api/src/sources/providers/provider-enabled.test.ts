import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isProviderEnabled, type SourceProviderDescriptor } from './types';
import { linkedinEngagementProvider } from './linkedin_engagement';

/**
 * #111 — a source provider is offered in the "Sync from…" picker (and creatable)
 * only when it is enabled. LinkedIn stays off until an operator flips
 * LINKEDIN_ACTIONS_ENABLED, so it must never be selectable — otherwise a user
 * picks a source that only ever fails at sync.
 */
const base: Omit<SourceProviderDescriptor, 'enabled'> = {
  id: 'test.provider',
  label: 'Test',
  connectionProvider: 'http',
  configSchema: z.object({}),
  async sync() {
    return { cursor: {} };
  },
};

describe('isProviderEnabled', () => {
  it('treats a provider with no enabled() as always on', () => {
    expect(isProviderEnabled(base)).toBe(true);
  });

  it('is on when enabled() returns true', () => {
    expect(isProviderEnabled({ ...base, enabled: () => true })).toBe(true);
  });

  it('is off when enabled() returns false', () => {
    expect(isProviderEnabled({ ...base, enabled: () => false })).toBe(false);
  });

  it('gates the LinkedIn provider on LINKEDIN_ACTIONS_ENABLED (off in the test env)', () => {
    // The test env never sets LINKEDIN_ACTIONS_ENABLED, so LinkedIn is disabled
    // and stays out of listProviders() / rejected by create.
    expect(typeof linkedinEngagementProvider.enabled).toBe('function');
    expect(isProviderEnabled(linkedinEngagementProvider)).toBe(false);
  });
});
