/**
 * Narrows an optional value in a test and fails LOUDLY, naming what was missing, when it is absent (ticket #1247).
 * Use it instead of a bare `!`: a `!` only silences the type checker, so a missing value surfaces later as an unrelated
 * TypeError or as `undefined` quietly flowing into a URL or an arithmetic expression.
 */
export function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`test precondition: expected ${what} to be present`);
  return value;
}
