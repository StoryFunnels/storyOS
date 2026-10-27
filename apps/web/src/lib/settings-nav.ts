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

/**
 * Whether a role may open a workspace-level admin settings page (Billing, Webhooks, Connections, Integrations...): admins only, the
 * same rule the nav applies with `isAdmin` and the API applies with `@MinRole('admin')`. One predicate for the in-page refusal
 * (`AdminsOnly`, #1092), so the nav, the page and the guard test cannot drift.
 */
export function canOpenAdminSettings(role: string | undefined): boolean {
  return role === 'admin';
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
    // #967 — its permanent home, right after Members (the sidebar row is only an invitation until the first AI
    // connects, then it disappears). Own route and the API-tokens gate from #875; Integrations is NOT relaxed for it.
    ...(canEdit ? [{ href: `${base}/connect-ai`, label: 'Connect your AI' }] : []),
    ...(isAdmin && billingEnabled ? [{ href: `${base}/billing`, label: 'Billing' }] : []),
    ...(isAdmin ? [{ href: `${base}/integrations`, label: 'Integrations' }] : []),
    ...(canEdit ? [{ href: `${base}/api`, label: 'API tokens' }] : []),
    ...(isAdmin ? [{ href: `${base}/export`, label: 'Export' }] : []),
    // #618 — admin-only, matching the restore endpoints' own @MinRole('admin') gate.
    ...(isAdmin ? [{ href: `${base}/trash`, label: 'Trash' }] : []),
    // #727 — admin-only, matching audit-log.controller.ts's own @MinRole('admin').
    ...(isAdmin ? [{ href: `${base}/audit-log`, label: 'Audit log' }] : []),
    // #546 — admin-only: it lists gate policies and every agent's declared reach, both admin reads.
    ...(isAdmin ? [{ href: `${base}/governance`, label: 'Governance' }] : []),
  ];
}
