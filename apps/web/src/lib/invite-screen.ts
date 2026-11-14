import type { InviteDetails } from '@/lib/invite-api';

/**
 * Ticket #1302 — what the Join screen says, decided in one place from the invite details and who is signed in, so the screen, its
 * tests and the copy cannot drift. The screen draws a model; it does not decide.
 *
 * `not_found` is ONE answer for an unknown, malformed, revoked and replaced token (the API returns one body so tokens cannot be
 * probed), so its wording is generic and names nobody. Only `expired` and `used` know the inviter, and name them.
 * Revoked cannot be told from unknown until the API keeps a `revoked_at` (ticket #1304): until then a revoked link reads as not found.
 */
export type JoinSession = { status: 'loading' } | { status: 'signed_out' } | { status: 'signed_in'; email: string };

export type JoinModel =
  | { kind: 'loading' }
  /** The details could not be read (offline, rate limited). Not the same as the link being dead. */
  | { kind: 'unavailable'; title: string; body: string }
  | { kind: 'not_found'; title: string; body: string }
  | { kind: 'expired' | 'used'; title: string; body: string; workspaceName: string; logoUrl: string | null }
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

export function joinModel(input: { details: InviteDetails | null | undefined; detailsFailed?: boolean; session: JoinSession }): JoinModel {
  const { details, session } = input;
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
/** `not_found` after a valid read can be a race or a revoke, so it never names the inviter (same rule as the not-found screen). */
export function joinFailureMessage(failure: 'not_found' | 'expired' | 'mismatch' | 'already_member' | 'other', inviter: string | null): string {
  switch (failure) {
    case 'expired':
      return `This invite has expired. ${askFor(inviter)}`;
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
