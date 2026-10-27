/**
 * Ticket #1093 — what each consequential Settings action asks before it runs.
 *
 * Eight actions ran on one click with nothing in between (Dara's #974 inventory marks each "gains a confirm"; the ticket counts
 * seven, the inventory lists eight, all eight are here). Each builder returns the options for the shared `useConfirm()` dialog and
 * says WHO or WHAT is affected and the EFFECT, so a slip is one Cancel away. They are plain functions of the names involved, in one
 * file, so the wording is testable and the pages cannot each invent their own. Cancel resolves false and the page never calls the
 * mutation: the API endpoints are untouched.
 */
export interface SettingsConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
}

export type WorkspaceRole = 'admin' | 'member' | 'guest';

const ROLE_WORD: Record<WorkspaceRole, string> = { admin: 'an admin', member: 'a member', guest: 'a guest' };
const ROLE_NAME: Record<WorkspaceRole, string> = { admin: 'Admin', member: 'Member', guest: 'Guest' };

/** What each role means in this product, kept next to the nav's own gating (`settings-nav.ts`): admin settings vs a member's work vs a guest's grants. */
const ROLE_EFFECT: Record<WorkspaceRole, string> = {
  admin: 'They can open the admin settings: members, billing, integrations, export, trash and the audit log.',
  member: 'They work in the workspace but cannot open the admin settings.',
  guest: 'They only see the spaces and databases shared with them.',
};

/** A member's role in the Members list. Moving anyone off admin, or onto it, is the sharp edge, so it is stated first. */
export function confirmRoleChange(person: string, from: WorkspaceRole, to: WorkspaceRole): SettingsConfirm {
  const lead =
    from === 'admin'
      ? `${person} stops being an admin and becomes ${ROLE_WORD[to]}. They lose access to the admin settings.`
      : to === 'admin'
        ? `${person} becomes an admin. ${ROLE_EFFECT.admin}`
        : `${person} goes from ${ROLE_NAME[from]} to ${ROLE_NAME[to]}. ${ROLE_EFFECT[to]}`;
  return { title: `Change ${person} to ${ROLE_NAME[to]}?`, message: lead, confirmLabel: `Change to ${ROLE_NAME[to]}`, danger: from === 'admin' };
}

export function confirmRemoveMember(person: string): SettingsConfirm {
  return {
    title: `Remove ${person}?`,
    message: `${person} loses access to this workspace right away. Their comments and history stay, still attributed to them, and you can invite them again later.`,
    confirmLabel: 'Remove member',
    danger: true,
  };
}

export function confirmRevokeInvite(email: string): SettingsConfirm {
  return {
    title: `Revoke the invite for ${email}?`,
    message: `The invite link stops working. ${email} cannot join with it, and you would have to send a new invite.`,
    confirmLabel: 'Revoke invite',
    danger: true,
  };
}

export function confirmRemovePhoto(): SettingsConfirm {
  return {
    title: 'Remove your photo?',
    message: 'Your picture goes back to your initials everywhere it shows. You can upload a new one any time.',
    confirmLabel: 'Remove photo',
    danger: true,
  };
}

/** `device` is how the session row already names it ("Chrome on macOS"), `ip` its address. */
export function confirmRevokeSession(device: string, ip: string): SettingsConfirm {
  return {
    title: `Sign out ${device}?`,
    message: `That device (${ip}) is signed out right away and has to sign in again. This device stays signed in.`,
    confirmLabel: 'Sign it out',
    danger: true,
  };
}

/** A token of THIS workspace. A token from another workspace has its own, longer sentence on the API tokens page. */
export function confirmRevokeToken(name: string, workspace: string): SettingsConfirm {
  return {
    title: `Revoke “${name}”?`,
    message: `Anything using this token for ${workspace} stops working immediately, and it cannot be recovered: you would have to create a new token and update wherever it was used.`,
    confirmLabel: 'Revoke token',
    danger: true,
  };
}

export function confirmToggleWebhook(url: string, enabling: boolean): SettingsConfirm {
  return enabling
    ? {
        title: 'Enable this webhook?',
        message: `StoryOS starts sending events to ${url} again.`,
        confirmLabel: 'Enable webhook',
        danger: false,
      }
    : {
        title: 'Disable this webhook?',
        message: `StoryOS stops sending events to ${url} until you enable it again. Nothing is deleted.`,
        confirmLabel: 'Disable webhook',
        danger: true,
      };
}

export function confirmRemoveCalendarMapping(database: string, calendar: string): SettingsConfirm {
  return {
    title: `Stop syncing ${database} with ${calendar}?`,
    message: `This removes the mapping, so changes stop flowing between them. Events already on the calendar stay there, and so do your records. To sync again you would set up a new mapping.`,
    confirmLabel: 'Remove mapping',
    danger: true,
  };
}
