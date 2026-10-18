/**
 * Ticket #948 — what the session check actually tells us.
 *
 * `useSession()` hands back `{ data: null, error }` for BOTH "you are signed out" and "the API did
 * not answer". The layout read both as "no session" and sent the user to /login, so every deploy
 * (when the API briefly returns 502) logged out anyone who reloaded. Only an answer can mean
 * signed out; a gateway error or a network failure means we do not know, so the user stays where
 * they are.
 */

export type SessionVerdict = 'pending' | 'authed' | 'signed_out' | 'unavailable';

interface SessionLike {
  data: unknown;
  isPending: boolean;
  error?: { status?: number } | null;
}

export function sessionVerdict({ data, isPending, error }: SessionLike): SessionVerdict {
  if (data) return 'authed';
  if (isPending) return 'pending';
  if (error) {
    const status = error.status;
    // 401/403 and any other 4xx are the server saying no. 5xx, 0 and "no status at all" (a
    // network failure, a proxy that never answered) are the server not saying anything.
    if (typeof status === 'number' && status >= 400 && status < 500) return 'signed_out';
    return 'unavailable';
  }
  // A 200 with a null body is the API's own "no session".
  return 'signed_out';
}
