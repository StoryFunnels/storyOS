/**
 * Ticket #1172 / ticket #1192 — the install review's "switchable install items": things a pack installs SWITCHED OFF that a
 * person can turn on from the review. Today only automations (`kind: 'automation'`, ticket #1107).
 *
 * ONE row component renders every kind (components/pack-automation-state.tsx `SwitchableRow`); everything that differs by kind
 * lives in ONE place, the `SwitchKindSpec` in `SWITCH_KINDS`: the words, the aria label, which items a person may switch on, and
 * the request field the chosen keys go in. The request is built from the items by kind (`enableRequestBody`).
 *
 * EXTENSION POINT, ticket #1192 (agent triggers install off too; only a person's switch in the review turns one on; human-gated
 * bindings are unaffected). It is deliberately NOT registered below, because the API does not return it yet and its field names
 * are not known. To add it, #1192's preview must provide, per agent trigger it would create:
 *   1. a stable label to key the switch by, and the same label accepted by the install request;
 *   2. whether it would be on or off at install (and, for an off one, why);
 *   3. the request field the chosen labels go in.
 * Then: register `agent_trigger` in `SWITCH_KINDS` with its own `sentence` (e.g. "wakes when Status becomes Onboarding · off"),
 * `ariaLabel`, `eligible` and `requestField`, and have the dialog map the preview's new list to `SwitchableItem`s next to the
 * automations. No row component or request code changes. Until then an item of an unregistered kind is IGNORED: it draws nothing
 * and is never sent, rather than crashing or being sent under a guessed field.
 */

import {
  automationSentence,
  automationState,
  enableAutomationsList,
  type AutomationPreviewItem,
  type AutomationState,
} from './pack-automation-state';

export interface SwitchKindSpec {
  /** The install/preview request body field this kind's chosen keys are sent in. */
  requestField: string;
  /** The one sentence under a row, in this kind's own words; null draws nothing. */
  sentence: (state: AutomationState) => { lead: string; rest: string | null } | null;
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
  const s = spec.sentence(state);
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
