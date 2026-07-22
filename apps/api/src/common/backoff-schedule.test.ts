import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, nextAttemptDelayMs } from './backoff-schedule';

describe('backoff-schedule (MN-253)', () => {
  it('follows the 30s / 2m / 10m / 1h schedule', () => {
    expect(nextAttemptDelayMs(1)).toBe(30_000);
    expect(nextAttemptDelayMs(2)).toBe(120_000);
    expect(nextAttemptDelayMs(3)).toBe(600_000);
    expect(nextAttemptDelayMs(4)).toBe(3_600_000);
  });

  it('returns null once MAX_ATTEMPTS (5) is reached — the signal to fail the job for good', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(nextAttemptDelayMs(5)).toBeNull();
    expect(nextAttemptDelayMs(6)).toBeNull();
  });
});
