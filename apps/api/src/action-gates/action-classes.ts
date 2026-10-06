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
