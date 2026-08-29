/**
 * #451 — the deterministic core of the agent UAT seeder.
 *
 * Every value the seeder invents comes from here, and here has no clock and no
 * `Math.random`. That is the whole point: Nadia finds a bug on Tuesday against
 * `--seed 1`, and Wednesday's `--seed 1` is the same workspace down to the
 * timestamps. A generator that drifts makes every finding unfalsifiable, which
 * is worse than no generator at all.
 */

/** FNV-1a — a string seed to a 32-bit state, so `--seed nadia-1` works as well as `--seed 7`. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32. Small, fast, and — the property that matters here — identical
 * across Node versions and platforms, because it is pure integer arithmetic
 * with no floating-point accumulation.
 */
export class Rng {
  private state: number;

  constructor(seed: string | number) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  }

  /** A fresh stream derived from this one — so adding a step to workspace 3 cannot shift workspace 4. */
  fork(label: string): Rng {
    return new Rng((this.state ^ hashSeed(label)) >>> 0);
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Inclusive low, exclusive high. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length)]!;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Fisher-Yates on a copy — the input is never mutated. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  /** `count` distinct members of `items` (or all of them, if count is larger). */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffle(items).slice(0, Math.min(count, items.length));
  }
}

/**
 * A timestamp `daysBack` before the seeder's epoch, jittered within the day.
 *
 * The epoch is a FIXED date, not `Date.now()` — six months of history that
 * silently slides forward every run is six months of history nobody can
 * reproduce. When the window needs to move, move this constant and say so.
 */
/*
 * End of day, not 09:00. `daysBefore` places a record at a working hour within
 * its day, so with a mid-morning anchor a day-zero record landed at 17:40 —
 * AFTER the epoch it was supposed to precede. Caught by the "never returns a
 * future date" test; it would have shown up in the product as seed records
 * dated in the future relative to the window they claim to span.
 */
export const SEED_EPOCH = new Date('2026-08-01T23:59:59.999Z');

export function daysBefore(rng: Rng, maxDaysBack: number): Date {
  const daysBack = rng.int(0, maxDaysBack);
  const minuteOfDay = rng.int(8 * 60, 19 * 60); // working hours, so activity feeds look human
  const d = new Date(SEED_EPOCH.getTime() - daysBack * 86_400_000);
  d.setUTCHours(0, minuteOfDay, rng.int(0, 60), 0);
  return d;
}
