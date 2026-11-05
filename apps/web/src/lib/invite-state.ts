/**
 * Ticket #1186 — what an invitation SAYS about itself on Settings › Members.
 *
 * `GET /invites` returns every invitation nobody has accepted, expired ones included (the API's `listPending` filters only on
 * `acceptedAt`), and until this ticket the page drew them all as "Pending". On JCM Agency that was four invitations, all past their
 * `expires_at` since 25 Aug, each still labelled pending, so nobody knew they were dead links. The state is derived from `expires_at`
 * here, in one place, so the row, the heading count and the tests read the same fact.
 *
 * Resend works on an expired invitation: `InvitesService.resend` looks the invite up by id and `acceptedAt IS NULL` only, then issues
 * a fresh token and a fresh seven days. Its one-minute cooldown is measured from the last send (`expiresAt` minus the TTL), so an
 * invitation that expired weeks ago is never throttled. Resend is therefore offered on pending AND expired invitations (taking it off a
 * pending one would remove a shipped action), and for an expired one it is the way forward.
 */
export interface InviteLike {
  email: string;
  role: string;
  expires_at: string;
  created_at?: string;
}

export type InviteState = 'expired' | 'pending';

/** Expired once `expires_at` is at or before `now`. An unreadable date is treated as pending: never claim "expired" on a guess. */
export function inviteState(invite: Pick<InviteLike, 'expires_at'>, now: number): InviteState {
  const at = Date.parse(invite.expires_at);
  return Number.isFinite(at) && at <= now ? 'expired' : 'pending';
}

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', member: 'Member', guest: 'Guest' };

export interface InviteRowModel {
  state: InviteState;
  /** The pill: "Expired 25 Aug" or "Pending". */
  pill: string;
  /** The line under the email: "Member · invited 5 Aug", plus when a pending one runs out. */
  detail: string;
  /** The button that sends a fresh link. Present on every invitation: see the file comment. */
  resendLabel: string;
  resendAriaLabel: string;
  /** An expired invitation's link is dead, so sending it again is the primary action. */
  resendIsPrimary: boolean;
}

export function inviteRowModel(invite: InviteLike, now: number, date: (iso: string) => string): InviteRowModel {
  const state = inviteState(invite, now);
  const role = ROLE_LABEL[invite.role] ?? invite.role;
  const invited = invite.created_at ? ` · invited ${date(invite.created_at)}` : '';
  return {
    state,
    pill: state === 'expired' ? `Expired ${date(invite.expires_at)}` : 'Pending',
    detail: state === 'expired' ? `${role}${invited}` : `${role}${invited} · expires ${date(invite.expires_at)}`,
    resendLabel: 'Send again',
    resendAriaLabel: `Send the invitation to ${invite.email} again`,
    resendIsPrimary: state === 'expired',
  };
}

/** The count beside the "Invitations" heading: "4 expired · none pending". */
export function invitationsSummary(invites: ReadonlyArray<Pick<InviteLike, 'expires_at'>>, now: number): string {
  const expired = invites.filter((i) => inviteState(i, now) === 'expired').length;
  const pending = invites.length - expired;
  if (expired === 0) return `${pending} pending`;
  return `${expired} expired · ${pending === 0 ? 'none pending' : `${pending} pending`}`;
}

/** Expired invitations first (they are the ones that need a decision), then pending, each in the order the API sent them. */
export function sortInvites<T extends Pick<InviteLike, 'expires_at'>>(invites: ReadonlyArray<T>, now: number): T[] {
  const rank = (i: T) => (inviteState(i, now) === 'expired' ? 0 : 1);
  return [...invites].sort((a, b) => rank(a) - rank(b));
}
