import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Env } from '../config/env';

vi.mock('../config/env', () => ({ env: vi.fn() }));

import { env } from '../config/env';
import { StripeService } from './stripe.service';

const mockEnv = vi.mocked(env);

function envWith(overrides: Partial<Env>): Env {
  return { NODE_ENV: 'test', ...overrides } as Env;
}

describe('StripeService.enabled/client/assertEnabled', () => {
  beforeEach(() => {
    mockEnv.mockReset();
  });

  it('is disabled with no STRIPE_SECRET_KEY — every workspace stays Free', () => {
    mockEnv.mockReturnValue(envWith({}));
    const service = new StripeService();
    expect(service.enabled).toBe(false);
  });

  it('is enabled once STRIPE_SECRET_KEY is set', () => {
    mockEnv.mockReturnValue(envWith({ STRIPE_SECRET_KEY: 'sk_test_abc' }));
    const service = new StripeService();
    expect(service.enabled).toBe(true);
  });

  it('client throws a 503 when disabled', () => {
    mockEnv.mockReturnValue(envWith({}));
    const service = new StripeService();
    expect(() => service.client).toThrow(ServiceUnavailableException);
  });

  it('client returns the Stripe SDK instance when enabled', () => {
    mockEnv.mockReturnValue(envWith({ STRIPE_SECRET_KEY: 'sk_test_abc' }));
    const service = new StripeService();
    expect(service.client).toBeTruthy();
  });

  it('#510 — assertEnabled throws the same 503 as client, for a mutation with no Stripe I/O of its own', () => {
    mockEnv.mockReturnValue(envWith({}));
    const service = new StripeService();
    expect(() => service.assertEnabled()).toThrow(ServiceUnavailableException);
  });

  it('#510 — assertEnabled is a no-op when enabled', () => {
    mockEnv.mockReturnValue(envWith({ STRIPE_SECRET_KEY: 'sk_test_abc' }));
    const service = new StripeService();
    expect(() => service.assertEnabled()).not.toThrow();
  });

  it('refuses a live key (sk_live_) outside production', () => {
    mockEnv.mockReturnValue(envWith({ STRIPE_SECRET_KEY: 'sk_live_abc', NODE_ENV: 'development' }));
    expect(() => new StripeService()).toThrow(/live Stripe key/);
  });
});
