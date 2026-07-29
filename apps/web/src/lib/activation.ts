/**
 * First-run activation checklist (#155) — pure step-derivation.
 *
 * Completion for every step is derived from REAL workspace state (the server's
 * `/workspaces/:ws/onboarding` endpoint, MN-213), never from a stored flag that
 * drifts and tells an already-activated user they did nothing. This module is
 * the pure "given that state → which steps, done or not, and where each links"
 * mapping, kept out of the page component so it's unit-testable in isolation.
 */

/** Live Getting-Started state, mirrors the API's onboarding response (MN-213). */
export interface OnboardingState {
  database_created: boolean;
  records_added: boolean;
  teammate_invited: boolean;
  board_view_built: boolean;
  relation_created: boolean;
  ai_connected: boolean;
  business_pack_installed: boolean;
}

export interface ActivationStep {
  /** Stable key for React lists + tests (independent of the human label). */
  key: keyof OnboardingState;
  label: string;
  done: boolean;
  /** Deep-link to the action; omitted when the step has no single destination. */
  href?: string;
}

export interface ActivationContext {
  ws: string;
  /** First non-system database id, if any — used to deep-link the record/view/relation steps. */
  firstDbId?: string;
}

/**
 * The activation path, ordered from empty workspace to activated. Labels are
 * intentionally generic-but-smart (pack-tailored wording is a follow-up); each
 * uncompleted step deep-links to where the user performs it.
 */
export function buildActivationSteps(state: OnboardingState, ctx: ActivationContext): ActivationStep[] {
  const dbHref = ctx.firstDbId ? `/w/${ctx.ws}/d/${ctx.firstDbId}` : undefined;
  return [
    { key: 'database_created', label: 'Create a database', done: state.database_created, href: undefined },
    { key: 'records_added', label: 'Open it and add a few records', done: state.records_added, href: dbHref },
    { key: 'board_view_built', label: 'Build a board view', done: state.board_view_built, href: dbHref },
    {
      key: 'relation_created',
      label: 'Connect two databases with a relation',
      done: state.relation_created,
      href: dbHref,
    },
    {
      key: 'teammate_invited',
      label: 'Invite a teammate',
      done: state.teammate_invited,
      href: `/w/${ctx.ws}/settings/members`,
    },
    { key: 'ai_connected', label: 'Connect your AI (MCP)', done: state.ai_connected, href: `/w/${ctx.ws}/settings/api` },
    {
      key: 'business_pack_installed',
      label: 'Install a Business Pack',
      done: state.business_pack_installed,
      href: `/w/${ctx.ws}/packs`,
    },
  ];
}

/** How many steps are done, for the "N/total" progress label. */
export function completedCount(steps: ActivationStep[]): number {
  return steps.filter((s) => s.done).length;
}

/** Every step complete — the checklist self-hides at this point. */
export function isActivationComplete(steps: ActivationStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/**
 * Whether to render the checklist: we have steps, the user hasn't finished them
 * all, and they haven't manually dismissed it for this workspace.
 */
export function shouldShowChecklist(steps: ActivationStep[], dismissed: boolean): boolean {
  return steps.length > 0 && !isActivationComplete(steps) && !dismissed;
}

/** Is this workspace in the user's dismissed list? Tolerates an undefined list (prefs still loading). */
export function isWorkspaceDismissed(dismissedWorkspaces: string[] | undefined, ws: string): boolean {
  return (dismissedWorkspaces ?? []).includes(ws);
}

/** The next dismissed-workspaces list after dismissing `ws` (idempotent, no dupes). */
export function withWorkspaceDismissed(dismissedWorkspaces: string[] | undefined, ws: string): string[] {
  const current = dismissedWorkspaces ?? [];
  return current.includes(ws) ? current : [...current, ws];
}
