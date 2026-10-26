/**
 * #1039 — two different erasures, and the words must never blur them.
 *
 *  - A workspace ADMIN erases a person FROM THAT WORKSPACE only (`POST /workspaces/:ws/members/:member/gdpr/anonymize`):
 *    their membership, access, per-person state and the tokens minted for it go. Their account, sign-in and every other
 *    workspace are untouched.
 *  - A person erases THEIR OWN ACCOUNT everywhere (`POST /me/gdpr/erase {confirm: true}`, session only): irreversible.
 *    Refused with 409 while they are the only admin of any workspace.
 */

/** What deleting your own account does, as the confirmation lists it. */
export const DELETE_ACCOUNT_CONSEQUENCES = [
  'Your account is erased and becomes an anonymous placeholder. Your name and email are removed.',
  'You leave every workspace you are in.',
  'Every sign-in, session, API token and AI connection of yours is destroyed.',
  'Your comments and history stay in those workspaces, but are no longer attributed to you.',
  'This cannot be undone.',
] as const;

export const DELETE_ACCOUNT_BLOCKER =
  'If you are the only admin of a workspace, deleting your account is blocked until you promote another admin or delete that workspace.';

/** Typing the email is the confirmation. Whitespace and case do not count against the person; anything else does. */
export function emailConfirmMatches(typed: string, email: string): boolean {
  const t = typed.trim().toLowerCase();
  return t.length > 0 && t === email.trim().toLowerCase();
}

/** The body the API requires: anything other than a literal `true` is refused. */
export const ERASE_ME_BODY = { confirm: true } as const;
