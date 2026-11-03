'use client';

import { Switch } from '@/components/ui/switch';
import {
  automationSentence,
  automationState,
  installedAutomationState,
  type AutomationPreviewItem,
  type SwitchedOffBecause,
} from '@/lib/pack-automation-state';

/**
 * Ticket #1172 — the line under an automation in the install review: "Off until you turn it on" + why, with a switch for the
 * rules a person is allowed to turn on here. The ONE implementation, used by the install list and by the update list, so the
 * two cannot say different things about the same rule.
 *
 * Draws nothing for a rule that already exists (the API gives it neither flag): there is nothing new to say about it.
 * Not gold: the rule is not the thing that acts until it is on, and gold belongs to agent rows.
 */
export function AutomationStateLine({
  item,
  chosen,
  confirmed,
  onChoose,
}: {
  item: AutomationPreviewItem;
  chosen: boolean;
  /** The server's preview taken WITH the person's choice, once it has answered. */
  confirmed?: AutomationPreviewItem;
  onChoose: (label: string, on: boolean) => void;
}) {
  const state = automationState(item, chosen, confirmed);
  const sentence = automationSentence(state);
  if (!sentence) return null;
  const canToggle = state.kind === 'turned-on' || state.kind === 'off';
  return (
    <span
      className="mt-1 flex items-center justify-between gap-3"
      data-testid="pack-automation-state"
      data-state={state.kind}
    >
      <span className="min-w-0 flex-1 text-label">
        <span className={state.kind === 'off' ? 'font-medium text-warning-text' : 'font-medium text-ink-secondary'}>
          {sentence.lead}
        </span>
        {sentence.rest && <span className="text-muted">{` · ${sentence.rest}`}</span>}
      </span>
      {canToggle && (
        <Switch
          checked={state.kind === 'turned-on'}
          onCheckedChange={(on) => onChoose(item.name, on)}
          aria-label={`Turn on ${item.name} when installed`}
        />
      )}
    </span>
  );
}

/** After the install: what state each automation was actually created in. No switch — the review is over. Draws nothing without `enabled`. */
export function InstalledAutomationLine({
  entity,
}: {
  entity: { enabled?: boolean; switched_off_because?: SwitchedOffBecause };
}) {
  const state = installedAutomationState(entity);
  const sentence = automationSentence(state);
  if (!sentence) return null;
  return (
    <span className="mt-0.5 text-label" data-testid="pack-automation-result" data-state={state.kind}>
      <span className={state.kind === 'off' ? 'font-medium text-warning-text' : 'font-medium text-ink-secondary'}>
        {state.kind === 'on' ? 'On' : sentence.lead}
      </span>
      {sentence.rest && state.kind !== 'on' && <span className="text-muted">{` · ${sentence.rest}`}</span>}
    </span>
  );
}
