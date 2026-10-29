/**
 * #1099 — what a space page's Access section may say, as one pure function so the rules have tests and the page only draws.
 *
 * Since restricted spaces (ADR-0018, #923/#924) "every member has access" is true ONLY of an unrestricted space. A restricted
 * space is opened by admins and by a grant, so the old "Workspace members — admin or member, access to every non-personal
 * space" group named people who cannot see the space. Who gets to see WHICH names follows the Manage access dialog, which is
 * admin-only: a member's GET /grants is refused (403), so a non-admin is told the space is restricted and shown no names.
 */
export type SpaceAccessMode =
  | 'everyone' // unrestricted: the original rendering, unchanged
  | 'restricted-admin' // restricted, viewer is an admin: admins plus the granted people
  | 'restricted-private' // restricted, viewer is a member: the fact, no names
  | 'guest'; // guests are told why there is no list

export interface AccessPerson {
  name: string;
  role: string;
}

export function spaceAccessMode(input: { restricted: boolean | undefined; workspaceRole: string | undefined }): SpaceAccessMode {
  if (input.workspaceRole === 'guest') return 'guest';
  if (input.restricted !== true) return 'everyone';
  return input.workspaceRole === 'admin' ? 'restricted-admin' : 'restricted-private';
}

/** Who may call GET /grants: admins only (the API's MinRole). Anything else would be a doomed 403 in the console. */
export const canReadGrants = (workspaceRole: string | undefined): boolean => workspaceRole === 'admin';

type MemberLike = { role: string; user: { name: string } };

/** The "Workspace members" group for an unrestricted space: every admin and member, never guests. */
export function everyoneRows(members: ReadonlyArray<MemberLike>): AccessPerson[] {
  return members.filter((m) => m.role !== 'guest').map((m) => ({ name: m.user.name, role: m.role }));
}

/** The "Workspace admins" group for a restricted space: admins always see it (ADR-0018 decision (a)); no member is named. */
export function adminRows(members: ReadonlyArray<MemberLike>): AccessPerson[] {
  return members.filter((m) => m.role === 'admin').map((m) => ({ name: m.user.name, role: m.role }));
}

export const RESTRICTED_SUMMARY =
  'Restricted. Only admins and the people added can see this space. Everyone else does not see it anywhere.';
export const RESTRICTED_PRIVATE_NOTE = 'Only workspace admins can see who has access to a restricted space.';
