/**
 * When a change of signed-in identity must empty the client cache (#468).
 *
 * The React Query cache is created once per tab (`app/providers.tsx`) and its
 * keys are scoped by WORKSPACE, not by user (`['spaces', ws]`, `['databases', ws]`).
 * Sign-out and sign-in are both client-side `router.replace` calls, so the React
 * tree — and the cache inside it — is never torn down. The incoming user's first
 * query for the same workspace is therefore a cache HIT on the outgoing user's
 * data, and `staleTime` serves it immediately while the correct response is still
 * in flight. A guest with one grant was shown her consultant's entire sidebar:
 * two spaces, three databases and every admin nav row. Only a manual reload —
 * which builds a new QueryClient — cleared it, and no user has any reason to
 * reload.
 *
 * This is the decision, kept pure and separate from the effect that acts on it so
 * the security property can be asserted by a test that does not need a DOM. The
 * property: **data cached under one user id is never readable by another.**
 */

/** The last identity we observed. `undefined` = we have not resolved one yet. */
export type SeenIdentity = string | null | undefined;

/**
 * True when going from `previous` to `current` means a different person is now
 * using this tab, and the cache must be emptied.
 *
 * The rules, each of which is a stated requirement on #468:
 *
 * - **First resolution never clears.** `useSession` reports `undefined` while it
 *   is still loading, so every page load passes through "no identity" on its way
 *   to the real one. Treating that as a change would clear the cache on every
 *   single load — turning a security fix into "the app refetches everything,
 *   always", which is the opposite of the `staleTime: 5_000` the app relies on to
 *   feel instant.
 * - **Signing OUT is a change.** `x -> null` clears, so the outgoing user's data
 *   does not sit in memory waiting for whoever signs in next.
 * - **Signing IN is a change.** `null -> y` clears too. Belt and braces: it means
 *   the incoming user starts clean even if the sign-out path was never taken —
 *   an expired or revoked session, or another tab switching identity.
 * - **A session REFRESH is not a change.** The trigger is the user id, not the
 *   session object, so a renewed token for the same person (`x -> x`) leaves the
 *   cache alone and nothing blanks or refetches.
 * - **Switching WORKSPACE is not a change.** The same person keeps their id, so
 *   this function never fires for it; workspace scoping stays the query keys' job.
 */
export function isIdentityChange(previous: SeenIdentity, current: string | null): boolean {
  if (previous === undefined) return false;
  return previous !== current;
}
