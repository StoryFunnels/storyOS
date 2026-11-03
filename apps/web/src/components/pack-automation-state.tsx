'use client';

import { Switch } from '@/components/ui/switch';
import { SWITCH_KINDS, switchableSentence, type SwitchKinds } from '@/lib/pack-switchable';
import {
  automationSentence,
  installedAutomationState,
  type AutomationPreviewItem,
  type SwitchedOffBecause,
} from '@/lib/pack-automation-state';

/**
 * Ticket #1172 — the line under a switchable install item in the review: "Off until you turn it on" + why, with a switch for the
 * ones a person is allowed to turn on here. ONE row for every kind (lib/pack-switchable.ts: the words differ per kind, nothing
 * else does), used by the install list and by the update list, so the two cannot say different things about the same item.
 *
 * Draws nothing for an item that already exists (the API gives it neither flag), and nothing for a kind the registry does not
 * know (ticket #1192's agent triggers until the API returns them). Not gold: the item is not the thing that acts until it is on,
 * and gold belongs to agent rows.
 */
export function SwitchableRow({
  kind,
  item,
  chosen,
  confirmed,
  onChoose,
  kinds = SWITCH_KINDS,
}: {
  kind: string;
  item: AutomationPreviewItem;
  chosen: boolean;
  /** The server's preview taken WITH the person's choice, once it has answered. */
  confirmed?: AutomationPreviewItem;
  onChoose: (label: string, on: boolean) => void;
  kinds?: SwitchKinds;
}) {
  const sentence = switchableSentence(kind, item, chosen, confirmed, kinds);
  if (!sentence) return null;
  const { state } = sentence;
  const canToggle = state.kind === 'turned-on' || state.kind === 'off';
  return (
    <span
      className="mt-1 flex items-center justify-between gap-3"
      data-testid="pack-automation-state"
      data-kind={kind}
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
          aria-label={kinds[kind]!.ariaLabel(item.name)}
        />
      )}
    </span>
  );
}

/** An automation's row: the `automation` kind of `SwitchableRow`. */
export function AutomationStateLine(props: Omit<Parameters<typeof SwitchableRow>[0], 'kind' | 'kinds'>) {
  return <SwitchableRow kind="automation" {...props} />;
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
