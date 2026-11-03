/**
 * Ticket #1172 — what the install review says about each automation: on or off, and WHY it is off, in a person's words.
 *
 * Since ticket #1107 a pack automation that reaches outside the workspace or runs an agent installs SWITCHED OFF, and the
 * preview says so per rule: `enabled_on_install` + `switched_off_because`. Without this the review listed those rules like
 * every other row and a person read them as running.
 *
 * Pure so every sentence and the request body are tested. Three facts the API decides and this file only reads:
 *  - a rule that already exists carries NEITHER field (the install leaves it alone) → we say nothing new about it;
 *  - the label a person turns on is the preview's own `name`, "Database.Rule name", sent back byte for byte;
 *  - when a rule is turned on the SERVER's answer drops `switched_off_because`, so the reason is always read from the
 *    preview taken WITHOUT the choice, never from the confirming one.
 */

export type SwitchedOffBecause = 'outward' | 'agent';

/** The slice of a preview automation this reads. Everything beyond `name` is optional: an existing rule carries neither flag. */
export interface AutomationPreviewItem {
  /** The preview's label, "Database.Rule name" — also the key `enable_automations` is sent in. */
  name: string;
  enabled_on_install?: boolean;
  switched_off_because?: SwitchedOffBecause;
}

export type AutomationState =
  /** Nothing new: the rule already exists (or the API said nothing). The row is left exactly as it was. */
  | { kind: 'existing' }
  /** Would be created switched on. */
  | { kind: 'on' }
  /** Would be created switched off. `because` is absent when the pack itself ships the rule off (Social Command Center's three reminders). */
  | { kind: 'off'; because?: SwitchedOffBecause }
  /** A person turned it on here: it will be created switched on. */
  | { kind: 'turned-on'; because?: SwitchedOffBecause };

/** Plain words for why, as the end of a sentence. Never "outward"/"agent": those are the API's words. */
export const REASON_WORDS: Record<SwitchedOffBecause, string> = {
  outward: 'it sends things outside your workspace',
  agent: 'it runs an agent',
};

export const PACK_OFF_REASON = 'the pack ships it switched off';

/**
 * The state of one automation row.
 *
 * `chosen`: the person has turned it on in this review. `confirmed`: the server's preview taken WITH the choice, when it has
 * answered — the row only claims "on" if the server agrees, so a label that did not match can never read as on while the
 * install leaves the rule off.
 */
export function automationState(
  item: AutomationPreviewItem,
  chosen: boolean,
  confirmed?: AutomationPreviewItem,
): AutomationState {
  if (item.enabled_on_install === undefined) return { kind: 'existing' };
  if (item.enabled_on_install) return { kind: 'on' };
  const because = item.switched_off_because;
  // Any rule that would be created off can be turned on here: the API honours `enable_automations` for every one of them (checked
  // live against a rule the pack itself ships off), and `confirmed` is what stops this lying if that ever changes.
  if (chosen && (confirmed === undefined || confirmed.enabled_on_install === true)) {
    return { kind: 'turned-on', because };
  }
  return { kind: 'off', because };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The one sentence under an automation row; null when there is nothing new to say. */
export function automationSentence(state: AutomationState): { lead: string; rest: string | null } | null {
  switch (state.kind) {
    case 'existing':
      return null;
    case 'on':
      return { lead: 'On once installed', rest: null };
    case 'turned-on':
      return {
        lead: 'On once installed',
        rest: state.because ? `You turned it on: ${REASON_WORDS[state.because]}.` : 'You turned it on.',
      };
    case 'off':
      return {
        lead: 'Off until you turn it on',
        rest: `${capitalise(state.because ? REASON_WORDS[state.because] : PACK_OFF_REASON)}.`,
      };
  }
}

/** The labels to send as `enable_automations`: only rules that would be created off AND that a person turned on, in the preview's own order. */
export function enableAutomationsList(items: AutomationPreviewItem[], chosen: Record<string, boolean>): string[] {
  return items
    .filter((i) => i.enabled_on_install === false && chosen[i.name] === true)
    .map((i) => i.name);
}

/** The request body fragment shared by preview and install: omitted entirely when nothing is chosen, so the default call is unchanged. */
export function enableAutomationsBody(list: string[]): { enable_automations?: string[] } {
  return list.length > 0 ? { enable_automations: list } : {};
}

/**
 * The same sentence AFTER the install, from the install result's own `enabled` + `switched_off_because` (which the API sets from
 * what it actually created). `enabled` absent (an older API) says nothing rather than guessing.
 */
export function installedAutomationState(entity: { enabled?: boolean; switched_off_because?: SwitchedOffBecause }): AutomationState {
  if (entity.enabled === undefined) return { kind: 'existing' };
  return entity.enabled ? { kind: 'on' } : { kind: 'off', because: entity.switched_off_because };
}
