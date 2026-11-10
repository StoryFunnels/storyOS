/**
 * #327 — the ONE builder for a "invite a guest" deep link into the members
 * settings dialog.
 *
 * Three surfaces (new-workspace, the template gallery, the share dialog) each
 * hand-built this URL, and they drifted: #106 fixed the grant on new-workspace
 * only, so the template gallery kept sending `grant=editor`. An editor guest is
 * BILLABLE at the time (#327) — the server then counted a guest as a paid seat
 * once any grant reached `contributor`, so that link silently cost a seat while
 * FreeGuestTip promised guests are free. Since ticket #1258 a guest is free at
 * every grant role, so the cost is gone; the default stays the least-privilege
 * `viewer` because a caller that says nothing should not hand out edit access.
 */

/**
 * Guest tiers that are never a paid seat: ALL of them (ticket #1258). A guest is
 * free at every grant role; only admins and members pay. Mirrors the server rule
 * in `apps/api/src/access/access.service.ts` (`isBillable`) — keep them in step,
 * the server owns the real rule.
 */
export const FREE_GUEST_GRANTS = ['viewer', 'commenter', 'contributor', 'editor', 'creator'] as const;

export type GuestGrant = (typeof FREE_GUEST_GRANTS)[number];

/** Whether a guest grant costs a seat. Never: guests are always free. Mirrors the server's `isBillable`. */
export function isBillableGuestGrant(_grant: GuestGrant): boolean {
  return false;
}

export function guestInviteHref({
  ws,
  spaceId,
  grant = 'viewer',
}: {
  ws: string;
  /** Scopes the invite to one space. Omitted → the dialog opens unscoped. */
  spaceId?: string | null;
  /** Defaults to the read-only `viewer` tier. Any tier is free; pass a wider one only where the person should be able to edit. */
  grant?: GuestGrant;
}): string {
  const base = `/w/${ws}/settings/members?invite=guest`;
  // The grant only means something alongside a space — an unscoped invite has
  // nothing to apply it to, which is why the share dialog omitted both together.
  return spaceId ? `${base}&space=${spaceId}&grant=${grant}` : base;
}
