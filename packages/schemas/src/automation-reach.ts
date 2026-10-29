import type { AutomationAction } from './fields';

/**
 * Ticket #1107 — how far an automation ACTION reaches, as ONE classification.
 *
 *  - `outward`: it leaves the workspace — an email, a Slack message, a webhook, an arbitrary HTTP call, a public post.
 *  - `agent`:   it starts an agent run.
 *  - `internal`: it only changes records, comments, or notifies workspace members.
 *
 * A pack automation that is `outward` or `agent` installs SWITCHED OFF (see `installedEnabledState`): installing a pack must never
 * start sending anything or running an agent until a person turns the rule on.
 *
 * EXHAUSTIVE ON PURPOSE. The map is keyed by every `AutomationAction['type']`, so adding an action type without classifying it
 * is a compile error here, not a quiet default of "internal" (an unlisted outward action would otherwise ship ON — the #878 shape,
 * a default that does something while looking like a declaration).
 *
 * This is a different question from `action-gates/action-classes.ts` (which actions are HELD for approval at run time; only
 * `post_social` is a member today). That one answers "may this run unattended"; this one answers "should an install start it".
 *
 * ZOD-FREE ON PURPOSE (type-only import above): the MCP image bundles this package, see `state-category.ts`.
 */
export type ActionReach = 'outward' | 'agent' | 'internal';

export const ACTION_REACH: Readonly<Record<AutomationAction['type'], ActionReach>> = {
  set_values: 'internal',
  create_record: 'internal',
  create_records: 'internal',
  add_comment: 'internal',
  notify_user: 'internal',
  update_linked: 'internal',
  send_email: 'outward',
  send_slack_message: 'outward',
  send_webhook: 'outward',
  http_request: 'outward',
  post_social: 'outward',
  run_agent: 'agent',
};

/**
 * The reach of a rule's actions, taken as a whole: `outward` if ANY action is outward (outward wins over agent: the stronger
 * claim), else `agent` if any runs an agent, else `internal`. An action whose type is not known counts as `outward` — a pack
 * is a hand-edited file, and a type this build cannot classify must not ship ON.
 */
export function automationReach(actions: ReadonlyArray<{ type?: unknown }>): ActionReach {
  let reach: ActionReach = 'internal';
  for (const a of actions) {
    const r = typeof a.type === 'string' && a.type in ACTION_REACH ? ACTION_REACH[a.type as AutomationAction['type']] : 'outward';
    if (r === 'outward') return 'outward';
    if (r === 'agent') reach = 'agent';
  }
  return reach;
}

export interface InstalledEnabledState {
  enabled: boolean;
  /** Set when the rule installs OFF *because of* what it does (not because the manifest said `enabled: false`). */
  switched_off_because?: 'outward' | 'agent';
}

/**
 * What state a pack automation installs in. `manifestEnabled` is the manifest's own flag; `personEnabled` is true only when a
 * PERSON, in the install review, asked for this rule to be on.
 *
 *  - An `outward`/`agent` rule is on ONLY if `personEnabled` — the manifest's `enabled: true` is ignored.
 *  - Any rule the manifest switched off stays off unless the person turned it on (they can in the review).
 *  - An internal rule takes the manifest's value.
 */
export function installedEnabledState(
  actions: ReadonlyArray<{ type?: unknown }>,
  manifestEnabled: boolean,
  personEnabled = false,
): InstalledEnabledState {
  if (personEnabled) return { enabled: true };
  const reach = automationReach(actions);
  if (reach !== 'internal') return { enabled: false, switched_off_because: reach };
  return { enabled: manifestEnabled };
}
