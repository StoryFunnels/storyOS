/**
 * Ticket #1280 — which automation rule is asking for an approval, as the row words it.
 *
 * ONE place for both approval rows (the Inbox page and the Inbox slide-over), so the wording cannot drift. The API (PR 1533) decides
 * what THIS viewer may know and says so in `rule_label`: the rule's name for someone who may read that database's automations,
 * "A rule in <database>" for someone who may open the database but not its automations, and the bare "A rule" for someone who
 * cannot even see the database. All three fields are null when no rule wrote the approval (an agent proposal, a button) or the rule
 * was deleted. The web NEVER reads `rule_name` to fill a withheld label and never shows `rule_id`: a withheld name is withheld.
 *
 * Unconfigured is not invalid: no label means no tail (the existing "needs your approval to run" stands), never an error and
 * never a uuid.
 */
export interface ApprovalRuleFields {
  rule_id?: string | null;
  rule_name?: string | null;
  rule_label?: string | null;
}

/** The API's label for a viewer who cannot see the rule's database either; it names nothing, so the row says nothing extra. */
export const BARE_WITHHELD_LABEL = 'A rule';

/** The API sent a label but no name: the viewer may not read this rule (the contract in PR 1533: `label != null && name == null`). */
export function ruleIsWithheld(a: ApprovalRuleFields | null | undefined): boolean {
  return Boolean(a?.rule_label?.trim()) && !a?.rule_name;
}

/** The API named the rule for this viewer. */
export function ruleIsGiven(a: ApprovalRuleFields | null | undefined): boolean {
  return Boolean(a?.rule_label?.trim()) && Boolean(a?.rule_name);
}

/**
 * The words that follow "needs your approval to run", or null when there is nothing true to add.
 * Given: the rule's name. Withheld with a database: "a rule in <database>" (the sentence continues, so the leading capital drops).
 * Withheld without a database, or no rule at all: null.
 */
export function approvalRuleTail(a: ApprovalRuleFields | null | undefined): string | null {
  const label = a?.rule_label?.trim();
  if (!label) return null;
  if (ruleIsGiven(a)) return label;
  if (label === BARE_WITHHELD_LABEL) return null;
  return label.charAt(0).toLowerCase() + label.slice(1);
}
