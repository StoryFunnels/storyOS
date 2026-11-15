import type { InviteDetails } from '@/lib/invite-api';

/**
 * Ticket #1302 — what the Join screen says, decided in one place from the invite details and who is signed in, so the screen, its
 * tests and the copy cannot drift. The screen draws a model; it does not decide.
 *
 * `not_found` is ONE answer for an unknown, malformed and replaced token (the API returns one body so tokens cannot be probed),
 * so its wording is generic and names nobody. `expired`, `used` and `revoked` know the inviter, and name them. A revoke keeps
 * the invite row as a tombstone (ticket #1304), which is how `revoked` can be told from unknown.
 */
export type JoinSession = { status: 'loading' } | { status: 'signed_out' } | { status: 'signed_in'; email: string };

export type JoinModel =
  | { kind: 'loading' }
  /** The accept succeeded and the browser is on its way into the workspace. The invite is now `used` BY THIS PERSON; never draw that. */
  | { kind: 'joining'; title: string; body: string }
  /** The details could not be read (offline, rate limited). Not the same as the link being dead. */
  | { kind: 'unavailable'; title: string; body: string }
  | { kind: 'not_found'; title: string; body: string }
  | { kind: 'expired' | 'used' | 'revoked'; title: string; body: string; workspaceName: string; logoUrl: string | null }
  | { kind: 'join_signed_out'; title: string; workspaceName: string; logoUrl: string | null; invitedEmail: string; action: string }
  | { kind: 'join_one_click'; title: string; workspaceName: string; logoUrl: string | null; invitedEmail: string; action: string }
  | {
      kind: 'mismatch';
      title: string;
      body: string;
      workspaceName: string;
      logoUrl: string | null;
      invitedEmail: string;
      signedInEmail: string;
      switchLabel: string;
    };

export const NOT_FOUND_COPY = {
  title: 'This invite link no longer works',
  body: 'Ask whoever invited you for a new link.',
} as const;

export const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const askFor = (inviter: string | null) => `Ask ${inviter ?? 'whoever invited you'} for a new link.`;

export const JOINING_COPY = { title: 'Joining…', body: 'Taking you into the workspace.' } as const;

/**
 * The invite details are read to DRAW the screen. Once the accept has succeeded they are never read again: the invite is `used`
 * (by this person), and a re-read would draw "already used" for the seconds before the redirect lands (ticket #1302).
 */
export const detailsQueryEnabled = (input: { token: string | null; joined: boolean }): boolean => Boolean(input.token) && !input.joined;

export function joinModel(input: {
  details: InviteDetails | null | undefined;
  detailsFailed?: boolean;
  session: JoinSession;
  /** The accept succeeded. Wins over everything the details say, now or after a refetch. */
  joined?: boolean;
}): JoinModel {
  const { details, session } = input;
  if (input.joined) return { kind: 'joining', ...JOINING_COPY };
  if (input.detailsFailed) {
    return { kind: 'unavailable', title: 'We could not check this invite', body: 'Check your connection and reload the page to try again.' };
  }
  if (!details || session.status === 'loading') return { kind: 'loading' };
  if (details.status === 'not_found' || !details.workspace_name) return { kind: 'not_found', ...NOT_FOUND_COPY };

  const workspaceName = details.workspace_name;
  const logoUrl = details.workspace_logo_url;
  const inviter = details.inviter_name;

  if (details.status === 'expired') {
    return { kind: 'expired', title: 'This invite has expired', body: askFor(inviter), workspaceName, logoUrl };
  }
  if (details.status === 'used') {
    return { kind: 'used', title: 'This invite was already used', body: askFor(inviter), workspaceName, logoUrl };
  }

  if (details.status === 'revoked') {
    return { kind: 'revoked', title: 'This invite was revoked', body: askFor(inviter), workspaceName, logoUrl };
  }

  const invitedEmail = details.invited_email ?? '';
  const title = inviter ? `${inviter} invited you to ${workspaceName}` : `You have been invited to ${workspaceName}`;
  const action = `Join ${workspaceName}`;
  if (session.status === 'signed_out') return { kind: 'join_signed_out', title, workspaceName, logoUrl, invitedEmail, action };
  if (sameEmail(session.email, invitedEmail)) return { kind: 'join_one_click', title, workspaceName, logoUrl, invitedEmail, action };
  return {
    kind: 'mismatch',
    title: 'This invite is for a different account',
    body: `This invite was sent to ${invitedEmail}. You’re signed in as ${session.email}.`,
    workspaceName,
    logoUrl,
    invitedEmail,
    signedInEmail: session.email,
    switchLabel: 'Switch account',
  };
}

/** better-auth answers a sign-up for an address that already has an account with USER_ALREADY_EXISTS (422). */
export function isUserAlreadyExists(error: { code?: string; status?: number; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (typeof error.code === 'string' && error.code.startsWith('USER_ALREADY_EXISTS')) return true;
  return error.status === 422 && /already exists/i.test(error.message ?? '');
}

/** The sentence under a failed accept. A failure that means the invite is dead says so; the rest is a plain retry. */
/** `not_found` after a valid read can be a race, so it never names the inviter (same rule as the not-found screen). */
export function joinFailureMessage(failure: 'not_found' | 'expired' | 'revoked' | 'mismatch' | 'already_member' | 'other', inviter: string | null): string {
  switch (failure) {
    case 'expired':
      return `This invite has expired. ${askFor(inviter)}`;
    case 'revoked':
      return `This invite was revoked. ${askFor(inviter)}`;
    case 'not_found':
      return `This invite link no longer works. ${askFor(null)}`;
    case 'mismatch':
      return 'This invite was sent to a different address.';
    case 'already_member':
      return 'You are already a member of this workspace.';
    default:
      return 'Could not join the workspace. Try again.';
  }
}

/** The sentence under Switch account when the sign-out request throws (API down). Same plain-retry shape as the join failure. */
export const SWITCH_ACCOUNT_FAILURE = 'Could not sign out. Try again.';

/**
 * Runs the sign-up / sign-in / join steps of a Join submit. Those calls can THROW (`TypeError: Failed to fetch` with the API down),
 * and an uncaught throw left the button on "Joining…" for good (ticket #1302, found on PR 1561). A throw is a failed join like any
 * other: busy is reset and the same retry message the accept path shows is set. The error itself is neither logged nor echoed (it can
 * carry the request URL). A step that returns normally owns its own busy/error handling, as before.
 */
export async function runJoinSubmit(
  steps: () => Promise<void>,
  hooks: { setBusy: (busy: boolean) => void; setError: (message: string | null) => void },
  failureMessage: string = joinFailureMessage('other', null),
): Promise<void> {
  try {
    await steps();
  } catch {
    hooks.setError(failureMessage);
    hooks.setBusy(false);
  }
}
