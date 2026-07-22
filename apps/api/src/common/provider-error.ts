/**
 * MN-253 — the error shape every JobRunnerService executor throws to report a
 * failed external call. Anything else thrown (a plain Error, a TypeError from
 * a bug in the executor) is treated as non-retryable — an executor opts INTO
 * retry by throwing this, rather than the runner guessing from a message.
 */
export class ProviderError extends Error {
  /** True for a transient failure (timeout, 5xx, rate limited) worth retrying;
   * false for a failure retrying can't fix (401, 404, validation 4xx). */
  readonly retryable: boolean;
  /** Provider-supplied backoff hint (e.g. a 429's `Retry-After`), in ms. When
   * set, this overrides the schedule's own delay for the next attempt. */
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { retryable: boolean; retryAfterMs?: number }) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
    this.retryAfterMs = opts.retryAfterMs;
  }
}
