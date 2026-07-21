import { describe, expect, it } from 'vitest';
import { HookRateLimiterService } from './hook-rate-limiter.service';

describe('HookRateLimiterService (MN-254)', () => {
  it('allows up to 60 hits in a window, then blocks the 61st', () => {
    const limiter = new HookRateLimiterService();
    const now = 1_000_000;
    for (let i = 0; i < 60; i++) {
      expect(limiter.hit('tok_a', now)).toBe(true);
    }
    expect(limiter.hit('tok_a', now)).toBe(false);
  });

  it('keys buckets independently per hook token', () => {
    const limiter = new HookRateLimiterService();
    const now = 1_000_000;
    for (let i = 0; i < 60; i++) limiter.hit('tok_a', now);
    expect(limiter.hit('tok_a', now)).toBe(false);
    // A different hook's budget is untouched.
    expect(limiter.hit('tok_b', now)).toBe(true);
  });

  it('resets once the window has elapsed', () => {
    const limiter = new HookRateLimiterService();
    const start = 1_000_000;
    for (let i = 0; i < 60; i++) limiter.hit('tok_a', start);
    expect(limiter.hit('tok_a', start)).toBe(false);
    expect(limiter.hit('tok_a', start + 60_000)).toBe(true);
  });

  it('sweep drops only expired buckets', () => {
    const limiter = new HookRateLimiterService();
    limiter.hit('stale', 0);
    limiter.hit('fresh', 100_000);
    limiter.sweep(100_000 + 30_000);
    // stale's window (started at 0) is long expired by 130_000; fresh's isn't.
    expect(limiter.hit('stale', 130_000)).toBe(true); // fresh bucket minted, still allowed
    for (let i = 1; i < 60; i++) limiter.hit('fresh', 130_000);
    expect(limiter.hit('fresh', 130_000)).toBe(false); // fresh bucket survived the sweep
  });
});
