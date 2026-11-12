/**
 * Ticket #1291 — what a page that is ABOUT one thing (a database, a record, a view, a document, a space, a skill, an agent...) does
 * when that thing cannot be read. Four answers, never a fifth that is a spinner:
 *
 *   loading — the first answer has not arrived;
 *   ready   — there is something to draw;
 *   gone    — the server said 404 or 403. To a person the two are one fact ("not here for you"): a guest without access must not be
 *             able to tell "forbidden" from "never existed", so both render the SAME not-found page;
 *   failed  — anything else (the network, a 5xx, a proxy page). We do NOT know the thing is gone, so it must never read as a 404:
 *             it says the load failed and offers a retry.
 *
 * Why this is a module and not a line in each page. A missing database used to load forever: the page's query kept erroring, and
 * every fresh observer of an errored query refetches it on mount, which puts the query back to `pending` (there is no data to keep),
 * which is `isLoading` again. Four hooks reading one key kept resetting each other (hundreds of requests, a skeleton that never ended).
 * `entityQueryOptions` stops that at the source for a gone entity, and `entityState` is the one reading of a query every page shares.
 */

/** The HTTP status of a failed API call, or null when the failure never reached the server (offline, aborted) or carries none.
 *  `api.ts` stamps `error.meta.status` on every error envelope (`withSafeErrors`), because the SDK hands back the body, not the response. */
export function errorStatus(error: unknown): number | null {
  const body = error as { error?: { meta?: { status?: unknown } } } | null | undefined;
  const status = body?.error?.meta?.status;
  return typeof status === 'number' ? status : null;
}

/** 404 and 403: the one fact "this is not here for you". */
export function isGoneError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 403;
}

export type EntityState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'gone' }
  | { kind: 'failed'; error: unknown };

/** The slice of a react-query result that decides it. Structural, so a test needs no QueryClient. */
export interface EntityQueryLike {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: unknown;
}

export function entityState(q: EntityQueryLike): EntityState {
  // Data wins: a background refetch that fails must not take a loaded page away.
  if (q.data !== undefined && q.data !== null) return { kind: 'ready' };
  if (q.isError) return isGoneError(q.error) ? { kind: 'gone' } : { kind: 'failed', error: q.error };
  if (q.isPending) return { kind: 'loading' };
  // Settled with no data and no error: the thing is not there (a lookup that came back null).
  return { kind: 'gone' };
}

/** Several queries that must ALL answer (a record needs its database too): gone/failed from any one wins, loading until all are in. */
export function combineEntityStates(...states: EntityState[]): EntityState {
  const gone = states.find((s) => s.kind === 'gone');
  if (gone) return gone;
  const failed = states.find((s) => s.kind === 'failed');
  if (failed) return failed;
  if (states.some((s) => s.kind === 'loading')) return { kind: 'loading' };
  return { kind: 'ready' };
}

/** A gone entity is not retried, and not refetched by the next observer that mounts or the next window focus: that refetch is what
 *  turned an errored query back into a spinner. A FAILED one still retries once, and a Retry button calls `refetch()`. */
export const entityQueryOptions = {
  retry: (failureCount: number, error: unknown) => !isGoneError(error) && failureCount < 1,
  retryOnMount: false,
  refetchOnWindowFocus: (query: { state: { status: string; error: unknown } }) =>
    !(query.state.status === 'error' && isGoneError(query.state.error)),
} as const;
