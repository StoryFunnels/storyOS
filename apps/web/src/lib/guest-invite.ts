/**
 * #327 — the ONE builder for a "invite a guest" deep link into the members
 * settings dialog.
 *
 * Three surfaces (new-workspace, the template gallery, the share dialog) each
 * hand-built this URL, and they drifted: #106 fixed the grant on new-workspace
 * only, so the template gallery kept sending `grant=editor`. An editor guest is
 * BILLABLE — `access.service.ts` counts a guest as billable once any grant
 * ranks at or above `contributor`, and editor outranks it — so that link
 * silently cost a seat while FreeGuestTip promised guests are free.
 *
 * The default here is the load-bearing part: a caller that says nothing gets a
 * free tier. Billing a seat has to be a deliberate, visible choice at the call
 * site, never something you inherit by forgetting an argument.
 */

/**
 * Guest tiers that are never a paid seat. Mirrors the billing rule in
 * `apps/api/src/access/access.service.ts` (`isBillable`): a guest becomes
 * billable at `contributor` and above, so viewer and commenter stay free.
 * Keep this in step with that predicate — the server owns the real rule.
 */
export const FREE_GUEST_GRANTS = ['viewer', 'commenter'] as const;

export type GuestGrant = 'viewer' | 'commenter' | 'contributor' | 'editor' | 'creator';

/** Whether a grant costs a seat. Mirrors the server's `isBillable`. */
export function isBillableGuestGrant(grant: GuestGrant): boolean {
  return !(FREE_GUEST_GRANTS as readonly string[]).includes(grant);
}

export function guestInviteHref({
  ws,
  spaceId,
  grant = 'viewer',
}: {
  ws: string;
  /** Scopes the invite to one space. Omitted → the dialog opens unscoped. */
  spaceId?: string | null;
  /** Defaults to the free `viewer` tier. Pass a billable tier only where the cost is stated. */
  grant?: GuestGrant;
}): string {
  const base = `/w/${ws}/settings/members?invite=guest`;
  // The grant only means something alongside a space — an unscoped invite has
  // nothing to apply it to, which is why the share dialog omitted both together.
  return spaceId ? `${base}&space=${spaceId}&grant=${grant}` : base;
}
