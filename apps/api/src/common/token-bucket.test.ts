import { describe, expect, it } from 'vitest';
import { freshBucket, takeToken } from './token-bucket';

const CONFIG = { capacity: 3, refillMs: 60_000 }; // 3 tokens / minute

describe('token-bucket (MN-253)', () => {
  it('starts full and allows up to `capacity` immediate takes', () => {
    const now = 0;
    let state = freshBucket(CONFIG, now);
    for (let i = 0; i < 3; i++) {
      const result = takeToken(state, CONFIG, now);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    // The 4th take, same instant, has nothing left.
    const exhausted = takeToken(state, CONFIG, now);
    expect(exhausted.allowed).toBe(false);
  });

  it('treats a missing state as a fresh, full bucket', () => {
    const result = takeToken(null, CONFIG, 0);
    expect(result.allowed).toBe(true);
    expect(result.state.tokens).toBeCloseTo(2, 5);
  });

  it('refills continuously — half the window back gives roughly half the tokens', () => {
    let state = freshBucket(CONFIG, 0);
    // Drain it.
    for (let i = 0; i < 3; i++) state = takeToken(state, CONFIG, 0).state;
    expect(takeToken(state, CONFIG, 0).allowed).toBe(false);
    // Half the refill window later, ~1.5 tokens are back — enough for one take.
    const halfway = takeToken(state, CONFIG, 30_000);
    expect(halfway.allowed).toBe(true);
    // A second take at the same instant is one token short of ~1.5 - 1 = 0.5.
    expect(takeToken(halfway.state, CONFIG, 30_000).allowed).toBe(false);
  });

  it('never refills past capacity, however long the idle gap', () => {
    const state = freshBucket(CONFIG, 0);
    const muchLater = takeToken(state, CONFIG, 10 * CONFIG.refillMs);
    expect(muchLater.allowed).toBe(true);
    expect(muchLater.state.tokens).toBeCloseTo(CONFIG.capacity - 1, 5);
  });
});
