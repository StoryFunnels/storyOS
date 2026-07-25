import { describe, expect, it } from 'vitest';
import { resolveHosted } from './deployment.service';

describe('resolveHosted (#345)', () => {
  it('an explicit STORYOS_HOSTED wins over the billing signal', () => {
    // hosted forced on even with billing off…
    expect(resolveHosted('true', undefined)).toBe(true);
    expect(resolveHosted('1', undefined)).toBe(true);
    // …and forced off even with Stripe wired.
    expect(resolveHosted('false', 'sk_test_123')).toBe(false);
    expect(resolveHosted('0', 'sk_test_123')).toBe(false);
  });

  it('unset STORYOS_HOSTED ⇒ derive from billing (StripeService.enabled shape)', () => {
    expect(resolveHosted(undefined, 'sk_test_123')).toBe(true);
    expect(resolveHosted(undefined, undefined)).toBe(false);
    expect(resolveHosted(undefined, '')).toBe(false);
    expect(resolveHosted(undefined, '   ')).toBe(false);
  });

  it('blank or unrecognized STORYOS_HOSTED falls through to the billing signal', () => {
    expect(resolveHosted('', 'sk_test_123')).toBe(true);
    expect(resolveHosted('   ', undefined)).toBe(false);
    expect(resolveHosted('yes-please', undefined)).toBe(false); // not true/1 → ignored
  });

  it('does NOT fall into the Boolean("false") trap', () => {
    expect(resolveHosted('false', undefined)).toBe(false);
  });
});
