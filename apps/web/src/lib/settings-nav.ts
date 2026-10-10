/**
 * Workspace settings navigation, as a pure function of the viewer's role (ticket #875), so the
 * gating that used to be two adjacent lines in layout.tsx can be tested per role, guest included.
 *
 * Two different gates, deliberately:
 *  - `isAdmin` guards the workspace-level credential and admin surfaces (Integrations hosts the
 *    provider cards: github, slack, linkedin, x...). It stays exactly as it was.
 *  - `canEdit` (`role !== 'guest'`) guards what a MEMBER may do with their own credential: API
 *    tokens, and now Connect your AI, the page that explains how to use that token.
 */
export interface SettingsNavFlags {
  isAdmin: boolean;
  canEdit: boolean;
  billingEnabled: boolean;
}

export function settingsFlags(role: string | undefined, billingEnabled: boolean | undefined): SettingsNavFlags {
  return { isAdmin: role === 'admin', canEdit: role !== 'guest', billingEnabled: Boolean(billingEnabled) };
}

/** Whether a role may use the Connect-your-AI screen: the same rule as minting an API token. */
export function canConnectAi(role: string | undefined): boolean {
  return role !== 'guest';
}

export function workspaceSettingsLinks(base: string, flags: SettingsNavFlags): Array<{ href: string; label: string }> {
  const { isAdmin, canEdit, billingEnabled } = flags;
  return [
    // #457 — where a property OF the workspace goes, starting with its description.
    { href: `${base}/general`, label: 'General' },
    ...(isAdmin ? [{ href: `${base}/members`, label: 'Members' }] : []),
    ...(isAdmin && billingEnabled ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    ...(isAdmin ? [{ href: `${base}/integrations`, label: 'Integrations' }] : []),
    // #875 — own entry and own route at the API-tokens gate; Integrations is NOT relaxed for it.
    ...(canEdit ? [{ href: `${base}/connect-ai`, label: 'Connect your AI' }] : []),
    ...(canEdit ? [{ href: `${base}/api`, label: 'API tokens' }] : []),
    ...(isAdmin ? [{ href: `${base}/export`, label: 'Export' }] : []),
    // #618 — admin-only, matching the restore endpoints' own @MinRole('admin') gate.
    ...(isAdmin ? [{ href: `${base}/trash`, label: 'Trash' }] : []),
    // #727 — admin-only, matching audit-log.controller.ts's own @MinRole('admin').
    ...(isAdmin ? [{ href: `${base}/audit-log`, label: 'Audit log' }] : []),
  ];
}
