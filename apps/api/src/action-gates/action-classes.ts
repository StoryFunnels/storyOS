/**
 * #781 — named action classes for the automation engine's ACTIONS.
 *
 * `delete_records` (#542 Phase 2) and `source_push` (#944) are classes of a
 * different shape: the first is gated by a declared policy in `action_gate_policies`,
 * the second by a per-source flag on #282's write-back. This file is the part that
 * is about AUTOMATION ACTIONS, the ones an author configures on a rule, and what a
 * CLASS implies for them, so that a gate is declared once, by class, instead of being
 * re-implemented inside each action.
 *
 * `spend_money` is deliberately absent: nothing in the product spends money, so its
 * rules would be invented and wrong on first contact (#781, descoped 2026-10-04).
 * Whoever builds the first money-spending action declares it in THAT change.
 *
 * Naming: snake_case, like `delete_records` and `source_push`. The class string is a
 * free-text column value that admins' policies will reference, so it is cheap to get
 * right now and a migration to change later. (#781's text spells it with a hyphen;
 * the existing classes decided otherwise.)
 */

/** Content leaves StoryOS for the public or a third party as an irreversible act. */
export const PUBLISH_EXTERNALLY_ACTION_CLASS = 'publish_externally';

export interface ActionClassRules {
  /**
   * What `require_approval` means when the author LEFT IT UNSET. A gated class is
   * held for a person's approval by default; the author must say otherwise out loud.
   */
  approvalWhenUnset: 'gated';
  /**
   * Turning approval OFF is a human decision, typed by a workspace admin: a member
   * cannot save it, and neither can an agent or MCP client authoring on their behalf.
   */
  ungateNeedsHumanAdmin: boolean;
}

const RULES: Readonly<Record<string, ActionClassRules>> = {
  [PUBLISH_EXTERNALLY_ACTION_CLASS]: { approvalWhenUnset: 'gated', ungateNeedsHumanAdmin: true },
};

/**
 * Which class an automation action type belongs to. THE MEMBERS OF EACH CLASS, today:
 *
 *  - `publish_externally`: `post_social` ONLY.
 *
 * A class with one member is fine; a class with unlisted members is not, so the
 * considered non-members are recorded in #781: `send_email` has the same gating shape
 * but its own, differently-defaulted logic (it is NOT gated when every recipient is a
 * workspace member), so folding it in is a change in behaviour that needs a decision,
 * not a refactor; `send_slack_message`, `send_webhook` and `http_request` are not
 * gated by default today.
 */
const CLASS_OF_ACTION_TYPE: Readonly<Record<string, string>> = {
  post_social: PUBLISH_EXTERNALLY_ACTION_CLASS,
};

export function actionClassOf(actionType: string): string | null {
  return CLASS_OF_ACTION_TYPE[actionType] ?? null;
}

/** The rules a gated automation action's class imposes, or null if its type is in no class. */
export function classRulesFor(actionType: string): ActionClassRules | null {
  const cls = actionClassOf(actionType);
  return cls ? (RULES[cls] ?? null) : null;
}

/**
 * #1174 / ADR-0021 §7 — the automation actions that reach OUTSIDE StoryOS. ONE constant, shared by the staging decision
 * (actions.service.ts) and by anything that needs to ask "is this outward?", so a new outward action kind is added in one place.
 *
 * When the event that fired a rule was caused by a RUN CREDENTIAL (an agent running on a member's own machine), every one of these
 * is held for a person regardless of the rule's `require_approval`: the agent can steer the content, and for an address or URL
 * built from a record field, the destination. `send_email` keeps its member-only exception (see `agentOriginHoldsAction`).
 */
export const OUTWARD_AUTOMATION_ACTION_TYPES: ReadonlySet<string> = new Set(['send_email', 'send_slack_message', 'send_webhook', 'http_request', 'post_social']);

/**
 * The agent's own `approval_policy` vocabulary (agents/agent-runtime.ts APPROVAL_POLICY_KINDS) that each outward action belongs to.
 * An `outward` and a `webhook` proposal can both apply through send_webhook, which is why the policy and the executor differ.
 */
const POLICY_CLASSES_OF_ACTION: Readonly<Record<string, readonly string[]>> = {
  send_email: ['email', 'outward'],
  send_webhook: ['webhook', 'outward'],
  http_request: ['webhook', 'outward'],
  send_slack_message: ['outward'],
  post_social: ['outward'],
};

/** True when the agent's declared `approval_policy` lists a class this action belongs to. */
export function agentPolicyHoldsAction(policy: ReadonlySet<string>, actionType: string): boolean {
  return (POLICY_CLASSES_OF_ACTION[actionType] ?? []).some((c) => policy.has(c));
}

/**
 * The staging rule for an action whose event was caused by a run credential. `recipientsAllMembers` is only meaningful for
 * `send_email` (every rendered to+cc address is an active member's). Pure so the five kinds are tested without a database.
 *  - not outward: not held here;
 *  - send_email to members only: held only if the agent's own approval_policy lists a class it belongs to;
 *  - every other outward kind, and send_email to anyone else: held.
 */
export function agentOriginHoldsAction(actionType: string, opts: { recipientsAllMembers: boolean; policy: ReadonlySet<string> }): boolean {
  if (!OUTWARD_AUTOMATION_ACTION_TYPES.has(actionType)) return false;
  if (actionType === 'send_email' && opts.recipientsAllMembers) return agentPolicyHoldsAction(opts.policy, actionType);
  return true;
}
