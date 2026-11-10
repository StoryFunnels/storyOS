/**
 * Ticket #1172 / ticket #1192 — the install review's "switchable install items": things a pack installs SWITCHED OFF that a
 * person can turn on from the review. Today only automations (`kind: 'automation'`, ticket #1107).
 *
 * ONE row component renders every kind (components/pack-automation-state.tsx `SwitchableRow`); everything that differs by kind
 * lives in ONE place, the `SwitchKindSpec` in `SWITCH_KINDS`: the words, the aria label, which items a person may switch on, and
 * the request field the chosen keys go in. The request is built from the items by kind (`enableRequestBody`).
 *
 * Agent triggers (ticket #1192 / ticket #1254) are the second kind: a state-bound pack agent trigger installs OFF and only a
 * person's switch here turns it on ("Wake it automatically", sent as `enable_agent_triggers`). The preview's `triggers` list carries
 * each one's label ("Agent <- Database.Field = State"), whether it would be on, and why not. A human-gated trigger never starts by
 * itself and is not held off, so it draws nothing.
 */

import {
  automationSentence,
  automationState,
  enableAutomationsList,
  type AutomationPreviewItem,
  type AutomationState,
} from './pack-automation-state';

const ARROW = ' \u2190 ';

/** A trigger's label, "Agent <- Database.Field = State", in parts; null when it is not in that shape (the row then says nothing specific). */
export function parseTriggerLabel(label: string): { agent: string; database: string; field: string; option: string } | null {
  const arrow = label.indexOf(ARROW);
  const eq = label.lastIndexOf(' = ');
  if (arrow < 0 || eq < arrow) return null;
  const agent = label.slice(0, arrow);
  const dbField = label.slice(arrow + ARROW.length, eq);
  const dot = dbField.indexOf('.');
  if (dot < 0) return null;
  return { agent, database: dbField.slice(0, dot), field: dbField.slice(dot + 1), option: label.slice(eq + 3) };
}

/** What wakes it, as one clause: "wakes when Status becomes Onboarding"; the raw label when it is not in the known shape. */
function wakesWhen(label: string): string {
  const p = parseTriggerLabel(label);
  return p ? `wakes when ${p.field} becomes ${p.option}` : `wakes on ${label}`;
}

/** "Wake it automatically": off by default, one line naming what wakes it. Nothing for a trigger that already exists or never fires by itself. */
function triggerSentence(state: AutomationState, key: string): { lead: string; rest: string | null } | null {
  const when = wakesWhen(key);
  const cap = when.charAt(0).toUpperCase() + when.slice(1);
  switch (state.kind) {
    case 'off':
      return { lead: 'Wake it automatically', rest: `Off until you turn it on. ${cap}.` };
    case 'turned-on':
      return { lead: 'Wake it automatically', rest: `On once installed. ${cap}.` };
    default:
      return null;
  }
}

function triggerAriaLabel(key: string): string {
  const p = parseTriggerLabel(key);
  return p ? `Wake ${p.agent} automatically when ${p.field} becomes ${p.option}` : `Wake it automatically: ${key}`;
}

/** The preview's agent triggers as switchable items, keyed by their label. */
export const triggerItems = (triggers: AutomationPreviewItem[]): SwitchableItem[] =>
  triggers.map((item) => ({ kind: 'agent_trigger', key: item.name, item }));

/** The triggers that belong under one agent's row. */
export const triggersOfAgent = <T extends { name: string }>(triggers: T[], agent: string): T[] =>
  triggers.filter((t) => parseTriggerLabel(t.name)?.agent === agent);

export interface SwitchKindSpec {
  /** The install/preview request body field this kind's chosen keys are sent in. */
  requestField: string;
  /** The one sentence under a row, in this kind's own words; null draws nothing. */
  sentence: (state: AutomationState, key: string) => { lead: string; rest: string | null } | null;
  /** The switch's accessible name. */
  ariaLabel: (key: string) => string;
  /** The keys of this kind's items a person turned on AND may turn on, in the preview's own order. */
  pick: (items: AutomationPreviewItem[], chosen: Record<string, boolean>) => string[];
}

export type SwitchKinds = Readonly<Record<string, SwitchKindSpec>>;

export const SWITCH_KINDS: SwitchKinds = {
  automation: {
    requestField: 'enable_automations',
    sentence: automationSentence,
    ariaLabel: (key) => `Turn on ${key} when installed`,
    pick: enableAutomationsList,
  },
  agent_trigger: {
    requestField: 'enable_agent_triggers',
    sentence: triggerSentence,
    ariaLabel: triggerAriaLabel,
    // Same rule as an automation: only a trigger that would be created OFF and that a person turned on.
    pick: enableAutomationsList,
  },
};

/** One thing the review can switch: its kind, the preview's label (the key the request uses) and its preview state. */
export interface SwitchableItem {
  kind: string;
  key: string;
  item: AutomationPreviewItem;
}

/** The id a choice is stored under: the same label under two kinds can never collide. */
export const switchId = (kind: string, key: string) => `${kind}:${key}`;

/** The preview's automations as switchable items. The dialog adds other kinds' items to this list when the API returns them. */
export const automationItems = (automations: AutomationPreviewItem[]): SwitchableItem[] =>
  automations.map((item) => ({ kind: 'automation', key: item.name, item }));

/** The sentence for an item of any registered kind; null for an unregistered kind (ignored) and for nothing to say. */
export function switchableSentence(
  kind: string,
  item: AutomationPreviewItem,
  chosen: boolean,
  confirmed?: AutomationPreviewItem,
  kinds: SwitchKinds = SWITCH_KINDS,
): { state: AutomationState; lead: string; rest: string | null } | null {
  const spec = kinds[kind];
  if (!spec) return null;
  const state = automationState(item, chosen, confirmed);
  const s = spec.sentence(state, item.name);
  return s ? { state, ...s } : null;
}

/**
 * The request body fragment for everything a person turned on: one field per kind, each omitted when empty so the default call is
 * unchanged. `chosen` is keyed by `switchId`. Items of an unregistered kind contribute nothing.
 */
export function enableRequestBody(
  items: SwitchableItem[],
  chosen: Record<string, boolean>,
  kinds: SwitchKinds = SWITCH_KINDS,
): Record<string, string[]> {
  const body: Record<string, string[]> = {};
  for (const kind of new Set(items.map((i) => i.kind))) {
    const spec = kinds[kind];
    if (!spec) continue;
    const ofKind = items.filter((i) => i.kind === kind);
    const byKey = Object.fromEntries(ofKind.map((i) => [i.key, chosen[switchId(kind, i.key)] === true]));
    const keys = spec.pick(
      ofKind.map((i) => i.item),
      byKey,
    );
    if (keys.length > 0) body[spec.requestField] = [...(body[spec.requestField] ?? []), ...keys];
  }
  return body;
}
