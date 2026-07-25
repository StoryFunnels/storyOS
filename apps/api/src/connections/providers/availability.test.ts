import { describe, expect, it } from 'vitest';
import { availabilityFor } from './availability';
import type { ProviderDescriptor } from './types';

/** A bare descriptor of a given tier — availabilityFor only reads `tier` and
 * (for oauth_managed) `oauth.clientIdEnv/clientSecretEnv`, so the rest is stub. */
function descriptor(overrides: Partial<ProviderDescriptor> & Pick<ProviderDescriptor, 'tier'>): ProviderDescriptor {
  return {
    id: 'x',
    label: 'X',
    authKind: overrides.tier === 'oauth_managed' ? 'oauth2' : 'api_key',
    healthCheck: async () => undefined,
    ...(overrides.tier === 'oauth_managed'
      ? {
          oauth: {
            authUrl: 'https://example.test/auth',
            tokenUrl: 'https://example.test/token',
            scopes: ['openid'],
            clientIdEnv: 'X_CLIENT_ID',
            clientSecretEnv: 'X_CLIENT_SECRET',
          },
        }
      : {}),
    ...overrides,
  };
}

const ENV_PRESENT = { X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'secret' };
const ENV_ABSENT: Record<string, string | undefined> = {};

describe('availabilityFor — the full #345 truth table', () => {
  it('api_key ⇒ connectable regardless of mode or env', () => {
    for (const isHosted of [true, false]) {
      expect(availabilityFor(descriptor({ tier: 'api_key' }), { isHosted, env: ENV_ABSENT })).toBe(
        'connectable',
      );
    }
  });

  it('oauth_managed + env present ⇒ connectable (either mode)', () => {
    for (const isHosted of [true, false]) {
      expect(
        availabilityFor(descriptor({ tier: 'oauth_managed' }), { isHosted, env: ENV_PRESENT }),
      ).toBe('connectable');
    }
  });

  it('oauth_managed + hosted + env absent ⇒ connectable (managed app)', () => {
    expect(
      availabilityFor(descriptor({ tier: 'oauth_managed' }), { isHosted: true, env: ENV_ABSENT }),
    ).toBe('connectable');
  });

  it('oauth_managed + self-managed + env absent ⇒ operator_config', () => {
    expect(
      availabilityFor(descriptor({ tier: 'oauth_managed' }), { isHosted: false, env: ENV_ABSENT }),
    ).toBe('operator_config');
  });

  it('oauth_managed treats a half-configured env (id only) as absent', () => {
    expect(
      availabilityFor(descriptor({ tier: 'oauth_managed' }), {
        isHosted: false,
        env: { X_CLIENT_ID: 'id' },
      }),
    ).toBe('operator_config');
  });

  it('hosted_only ⇒ connectable on hosted, cloud_only when self-managed', () => {
    expect(availabilityFor(descriptor({ tier: 'hosted_only' }), { isHosted: true, env: ENV_ABSENT })).toBe(
      'connectable',
    );
    expect(availabilityFor(descriptor({ tier: 'hosted_only' }), { isHosted: false, env: ENV_ABSENT })).toBe(
      'cloud_only',
    );
  });
});
