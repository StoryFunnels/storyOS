/**
 * Races `work` against a timer. Resolves with the work's value, or rejects with `onTimeout()`'s error once `ms` have passed.
 *
 * The timer is always cleared, and `work` is left to finish in the background: this bounds how long a CALLER waits, it does not
 * cancel the work (a pending database query keeps running until the database ends it). Used where an unbounded wait is the bug
 * (ticket #1314: a formula dry-run that ran more than two minutes).
 */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  // A late rejection from `work` after the timeout must not become an unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
